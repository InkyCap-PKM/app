//! Tauri commands for package-handoff collaboration.
//!
//! The non-destructive half (enable / package / import) and the apply
//! half (writing accepted changes into the working notebox) both live
//! here. They orchestrate the tested engine in `crate::collab`:
//! membership comes from the filter evaluator, identity/clock bookkeeping
//! from `versions.json`, and all working-notebox writes go through
//! `NoteboxStorage` (atomic).
//!
//! State is kept on disk — `versions.json`, `me.json`, and a staging
//! directory under `.inkycap/collab/<id>/` — rather than in `AppState`,
//! so each command reads the current truth and there's no in-memory
//! cache to keep coherent with the file watcher.
//!
//! Not yet wired (work-in-progress, tracked in the plan): attachment
//! discovery into packages, the `#review-reject` rejection log, and
//! bibliography conflict resolution beyond keep-local.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::collab::{self, apply, bibliography, identity, package, review};
use crate::collab::package::{PackageManifest, PackagedNote};
use crate::collab::clock::VectorClock;
use crate::collab::versions::{NoteVersion, VersionsFile};
use crate::collection_parser::filter::evaluate_filter_group;
use crate::collection_parser::model::{
    parse_collection_file, serialize_collection_file, CollectionFile, FilterGroup,
};
use crate::errors::{InkyCapError, Result};
use crate::models::note::PropertyValue;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::storage::{sanitize_notebox_arg, to_frontend_string};

const INCOMING_DIR: &str = "incoming";
const INCOMING_VERSIONS: &str = "incoming-versions.json";
const INCOMING_MANIFEST: &str = "incoming-manifest.json";

// --- report / request types (mirrored in the frontend) ---

#[derive(Debug, Serialize)]
pub struct CollabEnableReport {
    /// Notes matched by the collection filter.
    pub members: usize,
    /// Notes that received a freshly-stamped `collabid`.
    pub stamped: usize,
}

/// The three-way lifecycle of a collection's collaboration, surfaced as a
/// Disable / Pause / Enable pill in the UI.
///
/// - `Disabled` — no sidecar on disk; the pristine default. Re-enabling sets
///   up fresh history.
/// - `Paused` — sidecar present (history/identity preserved) but inactive:
///   packaging/importing are off and the membership filter is unlocked.
///   Resuming is lossless.
/// - `Enabled` — actively collaborative.
///
/// The flag (`collaboration.enabled`) only distinguishes Enabled from the
/// other two; Paused vs Disabled is told apart by whether the sidecar exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollabState {
    Disabled,
    Paused,
    Enabled,
}

#[derive(Debug, Serialize)]
pub struct CollabStatus {
    pub enabled: bool,
    /// Tri-state lifecycle (Disabled / Paused / Enabled) for the pill.
    pub state: CollabState,
    /// The local user's handle for this collection, if pinned.
    pub handle: Option<String>,
    /// Tracked (non-tombstoned) notes in the sidecar.
    pub note_count: usize,
}

#[derive(Debug, Serialize)]
pub struct PackageReport {
    pub path: String,
    pub note_count: usize,
}

#[derive(Debug, Serialize)]
pub struct ImportPackageResult {
    /// Frontend-canonical path of the collection the package landed in
    /// (created if it didn't exist).
    pub collection_path: String,
    pub collection_name: String,
    /// True when the collection was created by this import.
    pub created: bool,
    pub review: review::ReviewResult,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionAction {
    Accept,
    Reject,
    Skip,
}

#[derive(Debug, Deserialize)]
pub struct ReviewDecision {
    pub collabid: String,
    pub action: DecisionAction,
    /// Rationale for a `Reject` decision, recorded in the collection's
    /// rejection-log note as a `#review-reject(...)` entry. Ignored for
    /// `Accept` / `Skip`; absent (or empty) logs the rejection with no
    /// reason text.
    #[serde(default)]
    pub reason: Option<String>,
}

/// The user's resolution for one conflicting bibliography key. Keys with no
/// decision default to keeping the local entry (the conservative choice).
#[derive(Debug, Deserialize)]
pub struct BibDecision {
    pub key: String,
    /// `true` ⇒ take the incoming entry; `false` ⇒ keep local.
    pub take_incoming: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct ApplyReport {
    pub applied: usize,
    pub deleted: usize,
    pub rejected: usize,
    pub skipped: usize,
    /// Bibliography entries added by union-merging the incoming shared
    /// `.bib` (additions only; conflicts are kept-local for now).
    pub bib_added: usize,
}

// --- helpers ---

/// Read a note property as a string. Numbers (the `zid` is one) are
/// rendered as integers so a `collabid` never carries a `.0`.
fn prop_string(props: &HashMap<String, PropertyValue>, key: &str) -> Option<String> {
    match props.get(key) {
        Some(PropertyValue::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(PropertyValue::Number(n)) => Some(format!("{}", *n as i64)),
        _ => None,
    }
}

/// Read a list-typed note property as its string members (the `collection`
/// property is a list). A bare string is treated as a one-element list.
fn prop_string_list(props: &HashMap<String, PropertyValue>, key: &str) -> Vec<String> {
    match props.get(key) {
        Some(PropertyValue::List(items)) => items
            .iter()
            .filter_map(|v| match v {
                PropertyValue::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .collect(),
        Some(PropertyValue::String(s)) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// The membership name of a collection — its `.collection` file stem. This
/// is what the property-based filter matches (`collection.contains("<stem>")`)
/// and what gets stamped into each member's `collection` property.
fn collection_membership_name(collection_path: &Path) -> String {
    collection_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The canonical, location-independent membership filter for a
/// collaborative collection: notes opt in via their `collection` property,
/// not their folder. Matches the shape `default_collection_file_for`
/// produces, so a collection created the normal way is already canonical.
///
/// Collaborative membership must not depend on where a collaborator files a
/// note, so the folder/path predicates a user might otherwise write are
/// deliberately excluded — `collab_enable` replaces the filter with this.
fn canonical_membership_filter(name: &str) -> FilterGroup {
    FilterGroup {
        and: Some(vec![
            serde_yaml::Value::String("file.name != this.file.name".to_string()),
            serde_yaml::Value::String(r#"file.ext == "typ""#.to_string()),
            serde_yaml::Value::String(format!(r#"collection.contains("{name}")"#)),
        ]),
        or: None,
    }
}

/// Sanitize a user-controlled, notebox-root-relative folder: keep only
/// `Normal` path components, dropping any `..`, `.`, root, or drive-prefix
/// so a hand-edited `.collection` can't redirect imports outside the
/// notebox. Returns forward-slash form (empty when nothing survives).
fn sanitize_relfolder(folder: &str) -> String {
    use std::path::Component;
    Path::new(folder)
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Resolve the import folder for a collaborative collection: the
/// receiver-configured `import_folder`, or `Collaboration/<name>` when
/// unset. Always sanitized to stay inside the notebox.
fn import_folder_for(base: &CollectionFile, collection_name: &str) -> String {
    let configured = base
        .collaboration
        .as_ref()
        .and_then(|c| c.import_folder.as_ref())
        .map(|f| sanitize_relfolder(f))
        .filter(|f| !f.is_empty());
    configured.unwrap_or_else(|| format!("Collaboration/{collection_name}"))
}

/// Build a `collabid` → current notebox-relative path map from the live
/// property index. This is the authoritative answer to "where does the
/// receiver keep this note right now", independent of the path the sidecar
/// last recorded — so moves are followed instead of producing duplicates.
async fn collabid_path_map(state: &AppState, root: &Path) -> HashMap<String, String> {
    let index = state.property_index.read().await;
    let mut map = HashMap::new();
    for n in index.notes.values() {
        if let Some(cid) = prop_string(&n.properties, "collabid") {
            let rel = n.path.strip_prefix(root).unwrap_or(&n.path);
            map.insert(cid, to_frontend_string(rel));
        }
    }
    map
}

/// Record a deletion tombstone for `collabid` in every collaborative
/// collection sidecar under `<root>/.inkycap/collab/` that tracks it live,
/// attributing the delete to each collection's own pinned handle. Returns
/// how many sidecars were tombstoned.
///
/// A note can belong to several collaborative collections, so every sidecar
/// is checked. A collection with no pinned identity (`me.json`) is skipped —
/// we can't attribute the delete, and reconcile's drop-then-re-offer
/// fallback still covers that case. Pure filesystem orchestration (no
/// AppState) so it stays unit-testable.
fn tombstone_in_sidecars(root: &Path, collabid: &str) -> Result<usize> {
    let collab_root = root.join(".inkycap").join("collab");
    let Ok(entries) = std::fs::read_dir(&collab_root) else {
        return Ok(0);
    };
    let mut count = 0usize;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let vpath = dir.join("versions.json");
        let Some(mut versions) = VersionsFile::load(&vpath)? else {
            continue;
        };
        let tracked_live = versions
            .notes
            .get(collabid)
            .map(|n| !n.is_deleted())
            .unwrap_or(false);
        if !tracked_live {
            continue;
        }
        let Some(me) = identity::load_me(&dir)? else {
            continue;
        };
        versions.record_delete(collabid, &me.handle);
        versions.save(&vpath)?;
        count += 1;
    }
    Ok(count)
}

/// Tombstone a note across the collaborative collections that track it, so a
/// local delete *propagates* to collaborators on the next package instead of
/// the note re-appearing as Added.
///
/// **Call before the note leaves the property index** — its `collabid` is
/// read from the live index (the file is already, or about to be, gone).
/// A no-op for a note with no `collabid` (not collaborative). This is the
/// destructive sibling of membership-shrink: removing a note from a
/// collection stops sharing it, while *deleting* it records a tombstone that
/// travels and (after the receiver accepts) removes their copy too.
pub async fn record_note_deletion(state: &AppState, note_path: &Path) -> Result<()> {
    let root = notebox_root(state).await?;
    let collabid = {
        let index = state.property_index.read().await;
        index
            .notes
            .get(note_path)
            .and_then(|n| prop_string(&n.properties, "collabid"))
    };
    let Some(collabid) = collabid else {
        return Ok(());
    };
    tombstone_in_sidecars(&root, &collabid)?;
    Ok(())
}

/// Resolve the open notebox root, or error if none is open.
async fn notebox_root(state: &AppState) -> Result<PathBuf> {
    state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)
}

/// Compute the absolute collection path and its stable collab id.
async fn collection_ids(
    state: &AppState,
    collection_path: &str,
) -> Result<(PathBuf, PathBuf, String)> {
    let storage = state.get_storage().await?;
    let arg = sanitize_notebox_arg(collection_path)?;
    let abs = storage.resolve_path(&arg)?;
    let root = notebox_root(state).await?;
    let id = collab::collection_id(&root, &abs);
    Ok((root, abs, id))
}

// --- commands ---

/// Pin which collaborator the local user is for this collection.
#[tauri::command]
pub async fn collab_set_identity(
    collection_path: String,
    handle: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let (root, _abs, id) = collection_ids(&state, &collection_path).await?;
    let dir = collab::collab_dir(&root, &id);
    identity::save_me(&dir, &identity::LocalIdentity { handle })?;
    Ok(())
}

/// Mint a stable, filename-safe collaborator handle seeded from a display
/// name, made unique against `taken` (the handles already on other
/// contributor rows). Used by the contributors editor when a row is first
/// marked an editing collaborator. Reuses the same `identity` helpers the
/// collab engine uses, so a handle minted here is identical to one minted at
/// enable time.
#[tauri::command]
pub async fn collab_seed_handle(name: String, taken: Vec<String>) -> Result<String> {
    let set: HashSet<String> = taken.into_iter().collect();
    Ok(identity::unique_handle(&identity::seed_handle(&name), &set))
}

/// Read the local user's pinned handle for this collection (or `None`).
#[tauri::command]
pub async fn collab_get_identity(
    collection_path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    let (root, _abs, id) = collection_ids(&state, &collection_path).await?;
    let dir = collab::collab_dir(&root, &id);
    Ok(identity::load_me(&dir)?.map(|m| m.handle))
}

/// Move a collection between the three collaboration states (the
/// Disable / Pause / Enable pill).
///
/// - `Enabled` — set up collaboration. From `Disabled` this seeds fresh
///   history; from `Paused` it resumes the existing history losslessly.
///   Requires a handle (the `handle` arg, falling back to the pinned
///   `me.json` identity).
/// - `Paused` — keep all history but go inactive (cheap flag flip). From
///   `Disabled` it prepares collaboration inactive (so it also needs a
///   handle), but the common path is `Enabled → Paused`.
/// - `Disabled` — tear down the sidecar (history / identity / staging) and
///   clear the flag. No handle needed; the stamped `collabid` /
///   `collection` properties on notes are left untouched, so a later
///   re-enable reuses the same identities.
#[tauri::command]
pub async fn collab_set_state(
    collection_path: String,
    target: CollabState,
    handle: Option<String>,
    state: State<'_, AppState>,
) -> Result<CollabEnableReport> {
    let storage = state.get_storage().await?;
    let (root, _abs, id) = collection_ids(&state, &collection_path).await?;
    let col_arg = sanitize_notebox_arg(&collection_path)?;
    let sidecar_exists = collab::versions_path(&root, &id).exists();

    match target {
        CollabState::Disabled => {
            // Drop the whole sidecar dir (versions.json, me.json, staging) and
            // clear the flag. The canonical property filter stays in place —
            // membership-by-property is still meaningful — and unlocks in the
            // UI now that `enabled` is false.
            let dir = collab::collab_dir(&root, &id);
            if dir.exists() {
                std::fs::remove_dir_all(&dir)?;
            }
            let mut base = parse_collection_file(&storage.read_file(&col_arg).await?)?;
            if let Some(mut c) = base.collaboration.take() {
                c.enabled = false;
                base.collaboration = Some(c);
            }
            storage
                .write_file(&col_arg, &serialize_collection_file(&base)?)
                .await?;
            Ok(CollabEnableReport { members: 0, stamped: 0 })
        }
        CollabState::Paused if sidecar_exists => {
            // Lossless pause: keep all history, just flip the flag off.
            let mut base = parse_collection_file(&storage.read_file(&col_arg).await?)?;
            let mut c = base.collaboration.take().unwrap_or_default();
            c.enabled = false;
            base.collaboration = Some(c);
            storage
                .write_file(&col_arg, &serialize_collection_file(&base)?)
                .await?;
            Ok(CollabEnableReport { members: 0, stamped: 0 })
        }
        // Paused-from-Disabled prepares collaboration inactive; Enabled is the
        // active path. Both need a handle and run the (fresh ∥ resume) setup.
        CollabState::Paused | CollabState::Enabled => {
            let h = resolve_handle(&root, &id, handle)?;
            let target_enabled = matches!(target, CollabState::Enabled);
            setup_collaboration(&state, &collection_path, &h, target_enabled, !sidecar_exists).await
        }
    }
}

/// Resolve the handle to attribute edits to: the explicitly-provided one
/// (trimmed, non-empty) wins, else the collection's pinned `me.json`
/// identity. Errors if neither is available — collaboration can't be enabled
/// without an attributable identity.
fn resolve_handle(root: &Path, id: &str, provided: Option<String>) -> Result<String> {
    if let Some(h) = provided {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return Ok(h);
        }
    }
    if let Some(me) = identity::load_me(&collab::collab_dir(root, id))? {
        if !me.handle.trim().is_empty() {
            return Ok(me.handle);
        }
    }
    Err(InkyCapError::BadRequest(
        "A collaborator handle is required to enable collaboration.".to_string(),
    ))
}

/// Set up (or resume) collaboration for a collection: stamp `collabid` +
/// `collection` membership on members, seed or load `versions.json`, pin the
/// caller's identity, index the shared bibliography, canonicalize the filter,
/// and write `collaboration.enabled = target_enabled`.
///
/// `fresh` seeds an empty sidecar (initial enable); otherwise the existing
/// sidecar is loaded so its clocks/hashes/tombstones survive a pause→resume,
/// and edits made while paused are folded in (lazy capture, as at package).
async fn setup_collaboration(
    state: &AppState,
    collection_path: &str,
    handle: &str,
    target_enabled: bool,
    fresh: bool,
) -> Result<CollabEnableReport> {
    let storage = state.get_storage().await?;
    let (root, col_abs, id) = collection_ids(state, collection_path).await?;
    let col_arg = sanitize_notebox_arg(collection_path)?;

    let content = storage.read_file(&col_arg).await?;
    let mut base = parse_collection_file(&content)?;

    // Collaborative collections must be filter-defined — packaging "all
    // notes" by accident would be a nasty surprise. The *current* filter
    // determines who gets migrated; it's then replaced by the canonical
    // property-based one below.
    let filters = base.filters.clone().ok_or_else(|| {
        InkyCapError::BadRequest(
            "This collection has no membership filter. Add one before enabling collaboration."
                .to_string(),
        )
    })?;

    let name = collection_membership_name(&col_abs);
    let mut versions = if fresh {
        VersionsFile::new(id.clone())
    } else {
        VersionsFile::load(&collab::versions_path(&root, &id))?.ok_or_else(|| {
            InkyCapError::BadRequest(
                "No collaboration history to resume for this collection.".to_string(),
            )
        })?
    };

    // Stamp collabid + the `collection` membership property on every current
    // member, using the (canonical, on resume) filter to find them.
    let sync =
        sync_membership(state, &root, &col_abs, &filters, &name, handle, &mut versions).await?;

    // On resume, capture edits made while paused so they travel on the next
    // package — the same lazy, hash-based capture used at package/import time.
    if !fresh {
        let collabid_paths = collabid_path_map(state, &root).await;
        bump_local_edits(&mut versions, &root, handle, &collabid_paths);
    }

    // Index the shared bibliography so the first import can already detect bib
    // additions/conflicts (the section is otherwise empty until the first
    // package).
    let bib_source = base
        .collaboration
        .as_ref()
        .and_then(|c| c.bibliography_file.clone())
        .or_else(|| base.bibliography_file.clone());
    if let Some(b) = bib_source {
        if let Ok(text) = storage.read_file(&PathBuf::from(&b)).await {
            bibliography::refresh_bib_versions(&mut versions.bibliography, &text, handle);
        }
    }

    // Persist the sidecar and the local identity.
    versions.save(&collab::versions_path(&root, &id))?;
    let dir = collab::collab_dir(&root, &id);
    identity::save_me(
        &dir,
        &identity::LocalIdentity {
            handle: handle.to_string(),
        },
    )?;

    // Lock membership to the location-independent property filter. We just
    // stamped `collection: ("<name>")` on exactly the current members, so
    // this matches the same set immediately — but going forward membership
    // travels with the note (its property) instead of depending on where a
    // collaborator files it. Folder/path filters can't survive free
    // reorganization, which is why the user's filter is replaced rather than
    // augmented.
    base.filters = Some(canonical_membership_filter(&name));
    // Set the flag, preserving any existing import_folder, and carrying the
    // collection's bibliography as the shared one when none is set yet.
    let mut collab_cfg = base.collaboration.clone().unwrap_or_default();
    collab_cfg.enabled = target_enabled;
    if collab_cfg.bibliography_file.is_none() {
        collab_cfg.bibliography_file = base.bibliography_file.clone();
    }
    base.collaboration = Some(collab_cfg);
    let new_content = serialize_collection_file(&base)?;
    storage.write_file(&col_arg, &new_content).await?;

    Ok(CollabEnableReport {
        members: versions.notes.len(),
        stamped: sync.stamped,
    })
}

/// Result of a [`sync_membership`] pass.
struct MembershipSync {
    /// Notes newly recorded in the sidecar (not previously tracked).
    #[allow(dead_code)]
    tracked_added: usize,
    /// Notes that received a freshly-minted `collabid`.
    stamped: usize,
    /// Collabids of the collection's *current* members (filter matches).
    /// Lets the packager ship only members — a note removed from the
    /// collection stops travelling without deleting collaborators' copies.
    member_collabids: HashSet<String>,
}

/// Bring `versions` up to date with the collection's *current* members
/// (filter-evaluated): stamp a `collabid` and the `collection` membership
/// property on any member that lacks them, and record any member not yet
/// tracked. Shared by `collab_enable` (initial population) and
/// `collab_package` (so notes added to the collection after enabling are
/// picked up and travel).
///
/// Stamping the `collection` property makes membership location-independent:
/// after `collab_enable` canonicalizes the filter to
/// `collection.contains("<name>")`, a member is defined by its property, not
/// its folder, so a collaborator can reorganize freely. At package time the
/// canonical filter already requires the property, so the stamp is a no-op
/// there.
///
/// Does not remove notes that have left the filter — membership shrink is a
/// separate concern. Edits to already-tracked notes are captured by
/// [`bump_local_edits`], not here.
///
/// Stamps are written to note source via `NoteboxStorage`; the file watcher
/// reindexes them (we skip an inline reindex to avoid O(N²) work on large
/// collections — `collabid_path_map` reads the index lazily when needed).
async fn sync_membership(
    state: &AppState,
    root: &Path,
    col_abs: &Path,
    filters: &FilterGroup,
    collection_name: &str,
    handle: &str,
    versions: &mut VersionsFile,
) -> Result<MembershipSync> {
    use crate::typst_pipeline::note_rewriter::update_note_property;
    let storage = state.get_storage().await?;

    struct MemberSnapshot {
        abs: PathBuf,
        rel: String,
        zid: Option<String>,
        collabid: Option<String>,
        collections: Vec<String>,
    }
    // Snapshot members under the index read lock; release before I/O.
    let members: Vec<MemberSnapshot> = {
        let index = state.property_index.read().await;
        index
            .notes
            .values()
            .filter(|n| evaluate_filter_group(filters, n, col_abs))
            .map(|n| {
                let rel = n.path.strip_prefix(root).unwrap_or(&n.path);
                MemberSnapshot {
                    abs: n.path.clone(),
                    rel: to_frontend_string(rel),
                    zid: prop_string(&n.properties, "zid"),
                    collabid: prop_string(&n.properties, "collabid"),
                    collections: prop_string_list(&n.properties, "collection"),
                }
            })
            .collect()
    };

    let zid_pattern = state.settings.read().await.files.zid_pattern.clone();
    // Disambiguate ZIDs minted within this single run (same-second clashes).
    let mut mint_counter = 0u64;
    let mut stamped = 0usize;
    let mut tracked_added = 0usize;
    let mut member_collabids = HashSet::new();

    for m in &members {
        // Resolve (or mint) the note's collabid; decide what to stamp.
        let (collabid, stamp_collabid) = match &m.collabid {
            Some(existing) => (existing.clone(), false),
            None => {
                let zid = m.zid.clone().unwrap_or_else(|| {
                    mint_counter += 1;
                    format!("{}{:03}", crate::scaffolds::generate_zid(&zid_pattern), mint_counter)
                });
                (identity::make_collabid(&zid, handle), true)
            }
        };
        member_collabids.insert(collabid.clone());
        let stamp_collection = !m.collections.iter().any(|c| c == collection_name);

        // One read + one write per note when anything needs stamping.
        if stamp_collabid || stamp_collection {
            let mut body = storage.read_file(&m.abs).await?;
            if stamp_collabid {
                body = update_note_property(
                    &body,
                    "collabid",
                    &PropertyValue::String(collabid.clone()),
                );
            }
            if stamp_collection {
                let mut list = m.collections.clone();
                list.push(collection_name.to_string());
                let value =
                    PropertyValue::List(list.into_iter().map(PropertyValue::String).collect());
                body = update_note_property(&body, "collection", &value);
            }
            storage.write_file(&m.abs, &body).await?;
            if stamp_collabid {
                stamped += 1;
            }
        }

        if !versions.notes.contains_key(&collabid) {
            let body = storage.read_file(&m.abs).await?;
            versions.record_edit(&collabid, handle, &m.rel, collab::content_hash(&body));
            tracked_added += 1;
        }
    }

    Ok(MembershipSync { tracked_added, stamped, member_collabids })
}

/// Build the version view that travels in a package: live entries for
/// current `members`, plus *all* tombstones (so deletes still propagate).
///
/// A live note that is no longer a member is omitted. The receiver reads
/// its absence as "absence is not deletion" (see `review::classify_note`)
/// and keeps its own copy — so removing a note from a collaborative
/// collection stops sharing it without destroying collaborators' copies.
/// That's deliberately distinct from deleting the note, which records a
/// tombstone that *does* propagate.
fn package_versions_view(local: &VersionsFile, members: &HashSet<String>) -> VersionsFile {
    let mut view = local.clone();
    view.notes
        .retain(|id, nv| nv.is_deleted() || members.contains(id));
    view
}

/// Read collaboration status for a collection.
#[tauri::command]
pub async fn collab_status(
    collection_path: String,
    state: State<'_, AppState>,
) -> Result<CollabStatus> {
    let storage = state.get_storage().await?;
    let (root, _abs, id) = collection_ids(&state, &collection_path).await?;
    let col_arg = sanitize_notebox_arg(&collection_path)?;

    let base = parse_collection_file(&storage.read_file(&col_arg).await?)?;
    let enabled = base
        .collaboration
        .as_ref()
        .map(|c| c.enabled)
        .unwrap_or(false);

    let versions = VersionsFile::load(&collab::versions_path(&root, &id))?;
    let sidecar_exists = versions.is_some();
    let note_count = versions
        .map(|v| v.notes.values().filter(|n| !n.is_deleted()).count())
        .unwrap_or(0);
    let handle = identity::load_me(&collab::collab_dir(&root, &id))?.map(|m| m.handle);

    // Paused vs Disabled is told apart by the sidecar's presence — both have
    // `enabled == false`.
    let collab_state = if enabled {
        CollabState::Enabled
    } else if sidecar_exists {
        CollabState::Paused
    } else {
        CollabState::Disabled
    };

    Ok(CollabStatus {
        enabled,
        state: collab_state,
        handle,
        note_count,
    })
}

/// Set the receiver-controlled folder where notes new to this machine are
/// written on import. An empty value clears the override, reverting to the
/// `Collaboration/<name>` default. The value is sanitized to a
/// notebox-root-relative path; this is purely local (it never travels in a
/// package), so each collaborator organizes their own tree.
#[tauri::command]
pub async fn collab_set_import_folder(
    collection_path: String,
    folder: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let storage = state.get_storage().await?;
    let col_arg = sanitize_notebox_arg(&collection_path)?;
    let mut base = parse_collection_file(&storage.read_file(&col_arg).await?)?;

    let cleaned = sanitize_relfolder(&folder);
    let mut collab = base.collaboration.take().unwrap_or_default();
    collab.import_folder = if cleaned.is_empty() { None } else { Some(cleaned) };
    base.collaboration = Some(collab);

    storage
        .write_file(&col_arg, &serialize_collection_file(&base)?)
        .await?;
    Ok(())
}

/// Build a package zip for a collaborative collection at `output_path`.
#[tauri::command]
pub async fn collab_package(
    collection_path: String,
    output_path: String,
    state: State<'_, AppState>,
) -> Result<PackageReport> {
    let storage = state.get_storage().await?;
    let (root, col_abs, id) = collection_ids(&state, &collection_path).await?;
    let col_arg = sanitize_notebox_arg(&collection_path)?;

    let base = parse_collection_file(&storage.read_file(&col_arg).await?)?;
    if !base.collaboration.as_ref().map(|c| c.enabled).unwrap_or(false) {
        return Err(InkyCapError::BadRequest(
            "Collaboration isn't enabled for this collection.".to_string(),
        ));
    }

    // Your edits are captured into the clock here (lazily, by content
    // hash) so they actually travel — there's no per-save hook. Requires a
    // pinned handle to attribute the bump.
    let handle = identity::load_me(&collab::collab_dir(&root, &id))?
        .map(|m| m.handle)
        .ok_or_else(|| {
            InkyCapError::BadRequest(
                "Set your collaborator handle before packaging.".to_string(),
            )
        })?;
    let mut versions = VersionsFile::load(&collab::versions_path(&root, &id))?
        .ok_or_else(|| InkyCapError::BadRequest("Missing version sidecar.".to_string()))?;

    // Pick up notes added to the collection since it was enabled (stamp +
    // record them), then capture edits to already-tracked notes. The
    // collabid→path map follows any notes the user has since moved, so a
    // relocated note's edits still travel and its recorded path stays fresh.
    // Save once.
    let name = collection_membership_name(&col_abs);
    let members = if let Some(filters) = base.filters.clone() {
        let sync =
            sync_membership(&state, &root, &col_abs, &filters, &name, &handle, &mut versions)
                .await?;
        Some(sync.member_collabids)
    } else {
        None
    };
    let collabid_paths = collabid_path_map(&state, &root).await;
    bump_local_edits(&mut versions, &root, &handle, &collabid_paths);

    // Keep the sidecar's bibliography index in step with the shared `.bib`
    // before it travels, so the receiver can detect added/changed entries
    // (the bib section is otherwise empty and bib review is a no-op).
    let bib_rel = base
        .collaboration
        .as_ref()
        .and_then(|c| c.bibliography_file.clone())
        .or_else(|| base.bibliography_file.clone());
    if let Some(b) = &bib_rel {
        if let Ok(text) = storage.read_file(&PathBuf::from(b)).await {
            bibliography::refresh_bib_versions(&mut versions.bibliography, &text, &handle);
        }
    }

    // The on-disk sidecar keeps tracking everything (so a note re-added to
    // the collection resumes from its existing history).
    versions.save(&collab::versions_path(&root, &id))?;

    // What travels is a member-only view: a note whose `collection` property
    // was cleared is no longer a member and is omitted, so it stops sharing
    // without deleting collaborators' copies. Tombstones still travel. With
    // no filter (shouldn't happen once collaborative) we fall back to all.
    let package_versions = match &members {
        Some(m) => package_versions_view(&versions, m),
        None => versions.clone(),
    };

    // Files: every live member note + the `.collection` file + the shared
    // bibliography + any attachments the notes reference. `added` dedupes
    // so a file referenced by several notes (or that is also the bib) is
    // packaged once.
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut added: HashSet<String> = HashSet::new();
    let mut notes_manifest: Vec<PackagedNote> = Vec::new();
    let mut attachment_refs: BTreeSet<String> = BTreeSet::new();

    for (collabid, nv) in &package_versions.notes {
        if nv.is_deleted() {
            continue;
        }
        let abs = root.join(&nv.path);
        if !abs.exists() {
            continue;
        }
        files.push((nv.path.clone(), abs));
        added.insert(nv.path.clone());
        notes_manifest.push(PackagedNote {
            collabid: collabid.clone(),
            relpath: nv.path.clone(),
        });

        // Discover attachment references (image/read/embed/bibliography).
        if let Ok(content) = storage.read_file(&PathBuf::from(&nv.path)).await {
            for raw in crate::typst_pipeline::path_rebase::extract_referenced_paths(&content) {
                if let Some(rel) = collab::attachments::resolve_attachment_relpath(&nv.path, &raw) {
                    attachment_refs.insert(rel);
                }
            }
        }
    }

    let col_rel = to_frontend_string(col_abs.strip_prefix(&root).unwrap_or(&col_abs));
    files.push((col_rel.clone(), col_abs.clone()));
    added.insert(col_rel.clone());

    // `bib_rel` was resolved above (for the sidecar refresh); reuse it.
    if let Some(b) = &bib_rel {
        if let Ok(babs) = storage.resolve_path(&PathBuf::from(b)) {
            if babs.exists() {
                files.push((b.clone(), babs));
                added.insert(b.clone());
            }
        }
    }

    // Add referenced attachments that exist and aren't already in the
    // package (as a note, the collection file, or the bibliography).
    let mut attachments: Vec<String> = Vec::new();
    for att in attachment_refs {
        if added.contains(&att) {
            continue;
        }
        let abs = root.join(&att);
        if abs.exists() {
            files.push((att.clone(), abs));
            added.insert(att.clone());
            attachments.push(att);
        }
    }

    let manifest = PackageManifest {
        schema: package::PACKAGE_SCHEMA,
        collection_id: id,
        collection_relpath: col_rel,
        bibliography_relpath: bib_rel,
        notes: notes_manifest,
        attachments,
    };
    let note_count = manifest.notes.len();
    let dest = PathBuf::from(&output_path);

    // The zip write is blocking; keep it off the async reactor.
    tokio::task::spawn_blocking(move || {
        package::write_package(&dest, &manifest, &package_versions, &files, None)
    })
    .await
    .map_err(|e| InkyCapError::ExportFailed(format!("package task panicked: {e}")))??;

    Ok(PackageReport {
        path: output_path,
        note_count,
    })
}

/// Drop sidecar entries for notes the user has genuinely deleted locally,
/// so they're re-offered on the next import rather than silently skipped as
/// "already accepted". A note counts as still present when its `collabid`
/// is in the live index (`collabid_paths`) *or* a file still sits at its
/// recorded path — the latter covers the brief window after a stamp before
/// the watcher has reindexed. Tombstones are always kept (a deleted note
/// legitimately has no file). For surviving live notes, the recorded path
/// is refreshed to the index's current location so a *moved* note isn't
/// dropped and re-added as a duplicate.
///
/// Placement now follows identity, not the filesystem: collections are
/// filter views, not containers, so deleting/recreating one — or
/// reorganizing the tree — must not lose version history while the notes
/// (and collaborators) still exist. Only the comparison copy is reconciled
/// here; the persisted sidecar is updated on apply / package.
fn reconcile_local(
    mut local: VersionsFile,
    root: &Path,
    collabid_paths: &HashMap<String, String>,
) -> VersionsFile {
    local
        .notes
        .retain(|id, nv| nv.is_deleted() || collabid_paths.contains_key(id) || root.join(&nv.path).exists());
    for (id, nv) in local.notes.iter_mut() {
        if nv.is_deleted() {
            continue;
        }
        if let Some(current) = collabid_paths.get(id) {
            nv.path = current.clone();
        }
    }
    local
}

/// Capture local edits into the vector clock lazily, by content hash: for
/// each live tracked note, follow it to its current location (by collabid,
/// since the user may have moved it), refresh the recorded path, and — if
/// the content hash differs from the recorded one — bump the clock under
/// `handle` and update the hash. Returns true if anything changed (so the
/// caller can persist).
///
/// This stands in for a per-save hook. Rather than coupling the editor to
/// the collab layer and re-evaluating filters on every keystroke, we
/// reconcile the clock with reality at the two moments it matters:
/// packaging (so our edits travel to collaborators) and importing (so a
/// concurrent local edit surfaces as a conflict instead of being silently
/// overwritten by the incoming version).
fn bump_local_edits(
    local: &mut VersionsFile,
    root: &Path,
    handle: &str,
    collabid_paths: &HashMap<String, String>,
) -> bool {
    let mut changed = false;
    for (id, nv) in local.notes.iter_mut() {
        if nv.is_deleted() {
            continue;
        }
        // Follow the note to wherever the receiver keeps it now.
        if let Some(current) = collabid_paths.get(id) {
            if nv.path != *current {
                nv.path = current.clone();
                changed = true;
            }
        }
        let Ok(content) = std::fs::read_to_string(root.join(&nv.path)) else {
            continue;
        };
        let h = collab::content_hash(&content);
        if nv.hash.as_deref() != Some(h.as_str()) {
            nv.clock.bump(handle);
            nv.hash = Some(h);
            changed = true;
        }
    }
    changed
}

/// Extract `pkg` into the collection's staging directory, persist the
/// incoming sidecar for a later apply, and classify the changes against
/// local state. Shared by `collab_import` (into an existing collection)
/// and `collab_import_package` (into a freshly-created one).
async fn stage_and_review(
    state: &AppState,
    root: &Path,
    id: &str,
    pkg: &Path,
    handle: Option<&str>,
) -> Result<review::ReviewResult> {
    let collabid_paths = collabid_path_map(state, root).await;
    let local = VersionsFile::load(&collab::versions_path(root, id))?
        .unwrap_or_else(|| VersionsFile::new(id.to_string()));
    let mut local = reconcile_local(local, root, &collabid_paths);

    // Fold the importer's own edits into their clock first, so a note they
    // changed locally compares as concurrent (a conflict) against an
    // incoming change rather than being silently overwritten. This also
    // follows any note the importer has moved, keeping its recorded path
    // current so it isn't re-offered as a duplicate.
    if let Some(h) = handle {
        if bump_local_edits(&mut local, root, h, &collabid_paths) {
            local.save(&collab::versions_path(root, id))?;
        }
    }

    let staging = collab::collab_dir(root, id).join(INCOMING_DIR);
    // Clear any prior staging so a fresh import doesn't see stale files.
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }

    let pkg_buf = pkg.to_path_buf();
    let staging_for_task = staging.clone();
    let staged = tokio::task::spawn_blocking(move || {
        package::read_package(&pkg_buf, &staging_for_task, None)
    })
    .await
    .map_err(|e| InkyCapError::ExportFailed(format!("import task panicked: {e}")))??;

    // Persist the incoming sidecar and manifest so the apply call (or a
    // later resume) can read them without re-opening the package.
    staged.versions.save(&staging.join(INCOMING_VERSIONS))?;
    let manifest_json = serde_json::to_vec_pretty(&staged.manifest)?;
    std::fs::write(staging.join(INCOMING_MANIFEST), manifest_json)?;

    Ok(review::compute_review(&local, &staged.versions))
}

/// Import a package into an existing collection: extract to staging and
/// classify incoming changes. Does **not** touch the working notebox —
/// call `collab_review_apply` to act on the result.
#[tauri::command]
pub async fn collab_import(
    collection_path: String,
    package_path: String,
    state: State<'_, AppState>,
) -> Result<review::ReviewResult> {
    let (root, _abs, id) = collection_ids(&state, &collection_path).await?;
    let handle = identity::load_me(&collab::collab_dir(&root, &id))?.map(|m| m.handle);
    stage_and_review(&state, &root, &id, &PathBuf::from(&package_path), handle.as_deref()).await
}

/// Import a package without a pre-existing collection: peek the manifest,
/// create the bundled collection (with its filter intact) if this notebox
/// doesn't already have one by that name, then stage + classify. Returns
/// the (possibly newly created) collection so the UI can open it; the
/// pending review can then be resumed there via `collab_pending_review`.
#[tauri::command]
pub async fn collab_import_package(
    package_path: String,
    state: State<'_, AppState>,
) -> Result<ImportPackageResult> {
    let storage = state.get_storage().await?;
    let root = notebox_root(&state).await?;
    let pkg = PathBuf::from(&package_path);

    // Phase 1 — peek the manifest and ensure the target collection exists.
    let pkg_for_manifest = pkg.clone();
    let manifest =
        tokio::task::spawn_blocking(move || package::read_manifest(&pkg_for_manifest, None))
            .await
            .map_err(|e| InkyCapError::ExportFailed(format!("manifest read panicked: {e}")))??;

    let name = std::path::Path::new(&manifest.collection_relpath)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InkyCapError::BadRequest("Package has no collection name.".into()))?;

    let col_rel = format!(
        "{}/{}.collection",
        crate::notebox_package::collections_relpath(),
        name
    );
    let col_arg = sanitize_notebox_arg(&col_rel)?;

    let created = if storage.exists(&col_arg).await {
        false
    } else {
        // Pull the bundled `.collection` straight out of the package and
        // write it — its filter and the imported notes' properties agree,
        // so membership resolves correctly after apply.
        let pkg_for_file = pkg.clone();
        let rel = manifest.collection_relpath.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            package::read_packaged_file(&pkg_for_file, &rel, None)
        })
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("collection read panicked: {e}")))??;
        let content = String::from_utf8(bytes)
            .map_err(|e| InkyCapError::BadRequest(format!("bundled collection not UTF-8: {e}")))?;
        storage.write_file(&col_arg, &content).await?;
        state
            .collection_files
            .write()
            .await
            .push(storage.resolve_path(&col_arg)?);
        true
    };

    // Phase 2 — stage and review against local state.
    let col_abs = storage.resolve_path(&col_arg)?;
    let id = collab::collection_id(&root, &col_abs);
    let handle = identity::load_me(&collab::collab_dir(&root, &id))?.map(|m| m.handle);
    let review = stage_and_review(&state, &root, &id, &pkg, handle.as_deref()).await?;

    Ok(ImportPackageResult {
        collection_path: to_frontend_string(&col_abs),
        collection_name: name,
        created,
        review,
    })
}

/// Re-classify the staged-but-not-yet-applied import for a collection, if
/// one exists. Lets the review survive navigating away and reopening the
/// collection (and powers the import-into-new-collection flow, which
/// opens the collection after staging). Returns `None` when nothing is
/// staged.
#[tauri::command]
pub async fn collab_pending_review(
    collection_path: String,
    state: State<'_, AppState>,
) -> Result<Option<review::ReviewResult>> {
    let (root, _abs, id) = collection_ids(&state, &collection_path).await?;
    let inc = collab::collab_dir(&root, &id)
        .join(INCOMING_DIR)
        .join(INCOMING_VERSIONS);
    let Some(incoming) = VersionsFile::load(&inc)? else {
        return Ok(None);
    };
    let collabid_paths = collabid_path_map(&state, &root).await;
    let local = VersionsFile::load(&collab::versions_path(&root, &id))?
        .unwrap_or_else(|| VersionsFile::new(id));
    let local = reconcile_local(local, &root, &collabid_paths);
    Ok(Some(review::compute_review(&local, &incoming)))
}

/// The local + staged-incoming content for one note in a staged import,
/// powering the side-by-side review diff. Either side may be absent: an
/// `Added` note has no local copy; a `Deleted` change has no incoming body.
#[derive(Debug, Serialize)]
pub struct ReviewDetail {
    pub collabid: String,
    /// Notebox-relative path of the local copy, if one exists.
    pub local_path: Option<String>,
    /// Current local note content, or `None` for a note new to this machine.
    pub local_content: Option<String>,
    /// Incoming (staged) note content, or `None` when the incoming side is a
    /// deletion tombstone.
    pub incoming_content: Option<String>,
}

/// Read the local + staged-incoming content for one note, for the review
/// diff. Read-only: touches no working files, applies nothing.
#[tauri::command]
pub async fn collab_review_detail(
    collection_path: String,
    collabid: String,
    state: State<'_, AppState>,
) -> Result<ReviewDetail> {
    let storage = state.get_storage().await?;
    let (root, _abs, id) = collection_ids(&state, &collection_path).await?;
    let staging = collab::collab_dir(&root, &id).join(INCOMING_DIR);

    let incoming = VersionsFile::load(&staging.join(INCOMING_VERSIONS))?
        .ok_or_else(|| InkyCapError::BadRequest("No staged import to review.".to_string()))?;

    // Incoming (staged) content — absent for a tombstone or an unknown entry.
    let incoming_content = match incoming.notes.get(&collabid) {
        Some(inc) if !inc.is_deleted() => std::fs::read_to_string(staging.join(&inc.path)).ok(),
        _ => None,
    };

    // Local content — the receiver's own copy located by collabid (follows
    // moves), if any. Absent for an Added note. `rel` is notebox-relative for
    // the storage read; the returned `local_path` is an absolute frontend
    // string so the caller can open it as an editor tab directly.
    let rel = collabid_path_map(&state, &root).await.get(&collabid).cloned();
    let local_content = match &rel {
        Some(rel) => storage.read_file(&PathBuf::from(rel)).await.ok(),
        None => None,
    };
    let local_path = rel.map(|r| to_frontend_string(&root.join(r)));

    Ok(ReviewDetail { collabid, local_path, local_content, incoming_content })
}

/// Apply a set of review decisions from the staged import to the working
/// notebox. Accepts write through `NoteboxStorage`; rejects/skips leave
/// the working copy untouched. Updates the local sidecar with the merged
/// clocks of accepted notes.
#[tauri::command]
pub async fn collab_review_apply(
    collection_path: String,
    decisions: Vec<ReviewDecision>,
    bib_decisions: Vec<BibDecision>,
    state: State<'_, AppState>,
) -> Result<ApplyReport> {
    let storage = state.get_storage().await?;
    let (root, col_abs, id) = collection_ids(&state, &collection_path).await?;
    let col_arg = sanitize_notebox_arg(&collection_path)?;

    // Per-key bibliography conflict resolutions (keys absent ⇒ keep local).
    let bib_choices: HashMap<String, bibliography::ConflictChoice> = bib_decisions
        .iter()
        .map(|d| {
            let c = if d.take_incoming {
                bibliography::ConflictChoice::TakeIncoming
            } else {
                bibliography::ConflictChoice::KeepLocal
            };
            (d.key.clone(), c)
        })
        .collect();

    // Where notes new to this machine land. Existing notes are updated in
    // place (see below), so this only governs first-time arrivals.
    let mut base = parse_collection_file(&storage.read_file(&col_arg).await?)?;
    let name = collection_membership_name(&col_abs);
    let import_folder = import_folder_for(&base, &name);

    let mut local = VersionsFile::load(&collab::versions_path(&root, &id))?
        .unwrap_or_else(|| VersionsFile::new(id.clone()));

    let staging = collab::collab_dir(&root, &id).join(INCOMING_DIR);
    let incoming = VersionsFile::load(&staging.join(INCOMING_VERSIONS))?
        .ok_or_else(|| InkyCapError::BadRequest("No staged import to apply.".to_string()))?;
    // The manifest names the bundled bib + attachments (read once, used by
    // both the bib merge and the attachment copy below).
    let manifest: Option<package::PackageManifest> = std::fs::read(staging.join(INCOMING_MANIFEST))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());

    // Authoritative "where do I keep this note" map, by collabid. A note's
    // location is purely local, so an incoming change is written to the
    // receiver's own copy — never to the sender's path.
    let collabid_paths = collabid_path_map(&state, &root).await;

    let mut report = ApplyReport::default();
    // Declined changes to record in the rejection-log note: (target, reason).
    // Collected here and written once after the loop.
    let mut rejections: Vec<(String, String)> = Vec::new();

    for decision in &decisions {
        let Some(inc) = incoming.notes.get(&decision.collabid) else {
            continue;
        };
        let existing = collabid_paths.get(&decision.collabid).cloned();
        match decision.action {
            DecisionAction::Skip => report.skipped += 1,
            DecisionAction::Reject => {
                report.rejected += 1;
                // The note's display name is its filename stem (titles drive
                // filenames in InkyCap); prefer the receiver's own copy when
                // they have one, else the sender's path.
                let target_path = existing.clone().unwrap_or_else(|| inc.path.clone());
                let target = Path::new(&target_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| target_path.clone());
                rejections.push((target, decision.reason.clone().unwrap_or_default()));

                // Resolve the rejection: fold the incoming clock into our local
                // entry while keeping our own content. This records that we've
                // seen — and declined — their version, so it doesn't re-offer
                // on the next import (a deliberate, final "keep mine"). A note
                // we never tracked (a declined Added note) gets a content-less
                // entry carrying just the seen clock, so the same skip applies.
                let entry = local.notes.entry(decision.collabid.clone()).or_insert_with(|| {
                    NoteVersion {
                        clock: VectorClock::new(),
                        path: existing.clone().unwrap_or_default(),
                        hash: None,
                        tombstone: None,
                    }
                });
                entry.clock.merge(&inc.clock);
            }
            DecisionAction::Accept => {
                if inc.is_deleted() {
                    // Adopt the deletion: remove the receiver's own copy
                    // (wherever they keep it) and carry the tombstone into
                    // the local sidecar.
                    if let Some(rel) = existing.as_deref() {
                        storage.delete_file(&PathBuf::from(rel)).await?;
                        // Drop it from the in-memory indexes so the
                        // collection view reflects the deletion without a
                        // restart.
                        state.remove_from_indices(&root.join(rel)).await;
                    }
                    local.notes.insert(decision.collabid.clone(), inc.clone());
                    report.deleted += 1;
                } else {
                    // Copy the staged content to the receiver's copy if they
                    // have one (update in place), else to the import folder
                    // (new note), suffixing only to avoid clobbering a
                    // *different* local note.
                    let staged_file = staging.join(&inc.path);
                    let body = std::fs::read_to_string(&staged_file).map_err(|e| {
                        InkyCapError::FileNotFound(format!("staged {}: {e}", inc.path))
                    })?;

                    let birth = identity::birth_author(&decision.collabid).unwrap_or("peer");
                    let dest_rel = apply::place_incoming(
                        existing.as_deref(),
                        &inc.path,
                        &import_folder,
                        birth,
                        &|p| root.join(p).exists(),
                    );

                    storage.write_file(&PathBuf::from(&dest_rel), &body).await?;
                    // Reindex now so the collection's filter (evaluated
                    // against the in-memory property index) sees the new
                    // note immediately — without this the collection looks
                    // empty until the next notebox open.
                    state.reindex_note(&root.join(&dest_rel), &body).await;

                    let entry = local
                        .notes
                        .entry(decision.collabid.clone())
                        .or_insert_with(|| inc.clone());
                    entry.clock.merge(&inc.clock);
                    entry.path = dest_rel;
                    entry.hash = inc.hash.clone();
                    entry.tombstone = None;
                    report.applied += 1;
                }
            }
        }
    }

    // Record declined changes in the collection's rejection-log note — a
    // local-audit note in the import folder (NOT a collection member, so it
    // never travels back in a package). Each reject appends a Typst-native
    // `#review-reject(...)` entry; the note is created with a header on the
    // first rejection. Done once after the loop so multiple rejects share a
    // single read/append/write, and reindexed so it appears without a restart.
    if !rejections.is_empty() {
        let by = identity::load_me(&collab::collab_dir(&root, &id))?.map(|me| me.handle);
        let on = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
        let log_rel = format!(
            "{import_folder}/{}.typ",
            crate::typst_pipeline::review::rejection_log_title(&name)
        );
        let log_path = PathBuf::from(&log_rel);
        let mut content = storage.read_file(&log_path).await.ok();
        for (target, reason) in &rejections {
            let entry = crate::typst_pipeline::review::review_reject_call(
                target,
                reason,
                by.as_deref(),
                Some(&on),
            );
            content = Some(crate::typst_pipeline::review::append_to_rejection_log(
                content.as_deref(),
                &entry,
                &name,
            ));
        }
        if let Some(content) = content {
            storage.write_file(&log_path, &content).await?;
            state.reindex_note(&root.join(&log_rel), &content).await;
        }
    }

    // Bibliography: union-by-key merge the incoming shared `.bib` into ours.
    // Additions are taken; same-key/divergent-content conflicts are resolved
    // per the user's `bib_choices` (default keep-local). Refreshes the
    // sidecar's bib index from the merged result so the next comparison is
    // accurate.
    if let Some(inc_bib_rel) = manifest.as_ref().and_then(|m| m.bibliography_relpath.clone()) {
        if let Ok(incoming_bib) = std::fs::read_to_string(staging.join(&inc_bib_rel)) {
            // Where our shared bib lives. If we have none configured, adopt
            // the sender's relpath so both sides converge on one file.
            let local_bib_rel = base
                .collaboration
                .as_ref()
                .and_then(|c| c.bibliography_file.clone())
                .or_else(|| base.bibliography_file.clone())
                .unwrap_or_else(|| inc_bib_rel.clone());
            let local_bib = storage
                .read_file(&PathBuf::from(&local_bib_rel))
                .await
                .unwrap_or_default();

            match bibliography::merge_bibtex(&local_bib, &incoming_bib, &bib_choices) {
                Ok(merged) => {
                    if merged.bibtex != local_bib {
                        storage
                            .write_file(&PathBuf::from(&local_bib_rel), &merged.bibtex)
                            .await?;
                    }
                    // Rebuild the sidecar bib index from the merged hashes,
                    // preserving `added_by` (local first, then incoming).
                    let mut next = std::collections::BTreeMap::new();
                    for (key, hash) in merged.hashes {
                        let added_by = local
                            .bibliography
                            .0
                            .get(&key)
                            .or_else(|| incoming.bibliography.0.get(&key))
                            .map(|m| m.added_by.clone())
                            .unwrap_or_else(|| "peer".to_string());
                        next.insert(key, crate::collab::versions::BibEntryMeta { hash, added_by });
                    }
                    local.bibliography.0 = next;
                    report.bib_added = merged.added.len();

                    // First bib to arrive at a collection that had none:
                    // record where it now lives so future packages carry it.
                    let needs_adopt = base
                        .collaboration
                        .as_ref()
                        .map(|c| c.bibliography_file.is_none())
                        .unwrap_or(false)
                        && base.bibliography_file.is_none();
                    if needs_adopt {
                        if let Some(c) = base.collaboration.as_mut() {
                            c.bibliography_file = Some(local_bib_rel.clone());
                        }
                        storage
                            .write_file(&col_arg, &serialize_collection_file(&base)?)
                            .await?;
                    }
                }
                Err(e) => {
                    // A malformed bib on either side shouldn't sink the whole
                    // apply — the notes are already written. Surface it in
                    // the log and leave the local bib untouched.
                    log::warn!("collab: bibliography merge skipped: {e}");
                }
            }
        }
    }

    // Bring along referenced attachments. Assets aren't clock-versioned, so
    // we compare bytes: write when the file is missing locally OR its content
    // differs from the incoming one — so an *updated* attachment propagates
    // (previously skip-if-present meant edits never travelled). Identical
    // content is left untouched (no needless rewrite). A genuine local-vs-
    // incoming divergence is resolved take-incoming; there's no per-attachment
    // review yet (binary assets, no clock — see the design's open questions).
    // Done once after the note decisions, since attachments aren't tied to a
    // single note in the manifest.
    if let Some(manifest) = &manifest {
        for att in &manifest.attachments {
            let Ok(incoming) = std::fs::read(staging.join(att)) else {
                continue;
            };
            let differs = match std::fs::read(root.join(att)) {
                Ok(local) => local != incoming,
                Err(_) => true, // missing locally
            };
            if differs {
                storage.write_file_bytes(&PathBuf::from(att), &incoming).await?;
            }
        }
    }

    local.save(&collab::versions_path(&root, &id))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::{
        bump_local_edits, package_versions_view, reconcile_local, sanitize_relfolder,
        tombstone_in_sidecars,
    };
    use crate::collab::content_hash;
    use crate::collab::identity::{save_me, LocalIdentity};
    use crate::collab::versions::VersionsFile;
    use std::collections::{HashMap, HashSet};

    /// No moves: a collabid→path map that just mirrors the recorded paths,
    /// so the path-follow logic is a no-op and these tests exercise edit
    /// detection / retention alone.
    fn no_moves(v: &VersionsFile) -> HashMap<String, String> {
        v.notes
            .iter()
            .filter(|(_, nv)| !nv.is_deleted())
            .map(|(id, nv)| (id.clone(), nv.path.clone()))
            .collect()
    }

    #[test]
    fn bump_detects_edited_notes_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/x.typ"), "v1").unwrap();

        let mut v = VersionsFile::new("c");
        v.record_edit("z-x", "alice", "notes/x.typ", content_hash("v1"));
        let before = v.notes["z-x"].clock.get("bob");
        let paths = no_moves(&v);

        // No edit yet → no bump.
        assert!(!bump_local_edits(&mut v, root, "bob", &paths));
        assert_eq!(v.notes["z-x"].clock.get("bob"), before);

        // Edit the file → bump under bob, hash updated.
        std::fs::write(root.join("notes/x.typ"), "v2").unwrap();
        assert!(bump_local_edits(&mut v, root, "bob", &paths));
        assert_eq!(v.notes["z-x"].clock.get("bob"), before + 1);
        assert_eq!(v.notes["z-x"].hash.as_deref(), Some(content_hash("v2").as_str()));

        // Re-run with no further change → idempotent.
        assert!(!bump_local_edits(&mut v, root, "bob", &paths));
    }

    #[test]
    fn bump_follows_a_moved_note_to_its_current_path() {
        // The receiver moved the note; the index reports the new location.
        // bump must read the moved file, refresh the recorded path, and
        // capture the edit there — never read the stale recorded path.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("moved")).unwrap();
        std::fs::write(root.join("moved/x.typ"), "relocated-edit").unwrap();

        let mut v = VersionsFile::new("c");
        // Sidecar still records the old (sender's) path.
        v.record_edit("z-x", "alice", "sender/x.typ", content_hash("orig"));

        let mut paths = HashMap::new();
        paths.insert("z-x".to_string(), "moved/x.typ".to_string());

        assert!(bump_local_edits(&mut v, root, "bob", &paths));
        assert_eq!(v.notes["z-x"].path, "moved/x.typ", "path refreshed to current");
        assert_eq!(
            v.notes["z-x"].hash.as_deref(),
            Some(content_hash("relocated-edit").as_str())
        );
    }

    #[test]
    fn reconcile_keeps_indexed_present_and_tombstones_drops_truly_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // One note present at its recorded path, one only in the index (at a
        // moved path), one truly gone, one tombstoned.
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/here.typ"), "body").unwrap();

        let mut v = VersionsFile::new("c");
        v.record_edit("z-here", "alice", "notes/here.typ", content_hash("body"));
        v.record_edit("z-moved", "alice", "old/moved.typ", content_hash("m"));
        v.record_edit("z-gone", "alice", "notes/gone.typ", content_hash("x"));
        v.record_edit("z-dead", "alice", "notes/dead.typ", content_hash("y"));
        v.record_delete("z-dead", "alice");

        // Index reports z-moved at a new path (file need not exist at the
        // recorded path); z-here also present; z-gone absent everywhere.
        let mut paths = HashMap::new();
        paths.insert("z-moved".to_string(), "new/moved.typ".to_string());
        paths.insert("z-here".to_string(), "notes/here.typ".to_string());

        let r = reconcile_local(v, root, &paths);
        assert!(r.notes.contains_key("z-here"), "present file kept");
        assert!(r.notes.contains_key("z-moved"), "moved-but-indexed kept");
        assert_eq!(r.notes["z-moved"].path, "new/moved.typ", "path refreshed");
        assert!(!r.notes.contains_key("z-gone"), "truly-gone dropped");
        assert!(r.notes.contains_key("z-dead"), "tombstone kept");
    }

    #[test]
    fn package_view_ships_members_and_tombstones_not_dropped_members() {
        // Live member A, live note B no longer in the collection, deleted
        // note C. The package ships A (member) and C (tombstone, so the
        // delete propagates) but NOT B — removing B from the collection
        // stops sharing it without deleting collaborators' copies.
        let mut v = VersionsFile::new("c");
        v.record_edit("z-a", "alice", "a.typ", content_hash("a"));
        v.record_edit("z-b", "alice", "b.typ", content_hash("b"));
        v.record_edit("z-c", "alice", "c.typ", content_hash("c"));
        v.record_delete("z-c", "alice");

        let members: HashSet<String> = ["z-a".to_string()].into_iter().collect();
        let view = package_versions_view(&v, &members);

        assert!(view.notes.contains_key("z-a"), "member shipped");
        assert!(!view.notes.contains_key("z-b"), "dropped member not shipped");
        assert!(view.notes.contains_key("z-c"), "tombstone still propagates");
        // The on-disk sidecar is untouched — B keeps its history for re-add.
        assert!(v.notes.contains_key("z-b"));
    }

    #[test]
    fn tombstone_in_sidecars_marks_tracked_collections_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let collab_root = root.join(".inkycap").join("collab");

        // A: tracks z-x live + has identity → tombstoned.
        let a = collab_root.join("aaaa");
        std::fs::create_dir_all(&a).unwrap();
        let mut va = VersionsFile::new("aaaa");
        va.record_edit("z-x", "alice", "x.typ", content_hash("x"));
        va.record_edit("z-y", "alice", "y.typ", content_hash("y"));
        va.save(&a.join("versions.json")).unwrap();
        save_me(&a, &LocalIdentity { handle: "alice".into() }).unwrap();

        // B: tracks z-x live but NO identity → skipped (can't attribute).
        let b = collab_root.join("bbbb");
        std::fs::create_dir_all(&b).unwrap();
        let mut vb = VersionsFile::new("bbbb");
        vb.record_edit("z-x", "bob", "x.typ", content_hash("x"));
        vb.save(&b.join("versions.json")).unwrap();

        // C: has identity but doesn't track z-x → untouched.
        let c = collab_root.join("cccc");
        std::fs::create_dir_all(&c).unwrap();
        let mut vc = VersionsFile::new("cccc");
        vc.record_edit("z-z", "alice", "z.typ", content_hash("z"));
        vc.save(&c.join("versions.json")).unwrap();
        save_me(&c, &LocalIdentity { handle: "alice".into() }).unwrap();

        let n = tombstone_in_sidecars(root, "z-x").unwrap();
        assert_eq!(n, 1, "only A (tracked + identity) tombstoned");

        let va2 = VersionsFile::load(&a.join("versions.json")).unwrap().unwrap();
        assert!(va2.notes["z-x"].is_deleted(), "A's z-x tombstoned");
        assert!(!va2.notes["z-y"].is_deleted(), "A's other note untouched");

        let vb2 = VersionsFile::load(&b.join("versions.json")).unwrap().unwrap();
        assert!(!vb2.notes["z-x"].is_deleted(), "B skipped — no identity");
    }

    #[test]
    fn tombstone_in_sidecars_is_noop_without_collab_root() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(tombstone_in_sidecars(dir.path(), "z-x").unwrap(), 0);
    }

    #[test]
    fn sanitize_relfolder_strips_escapes_and_normalizes() {
        assert_eq!(sanitize_relfolder("Collaboration/paper"), "Collaboration/paper");
        assert_eq!(sanitize_relfolder("/etc/passwd"), "etc/passwd");
        assert_eq!(sanitize_relfolder("../../escape"), "escape");
        assert_eq!(sanitize_relfolder("a/../b"), "a/b");
        assert_eq!(sanitize_relfolder(""), "");
        assert_eq!(sanitize_relfolder("./x"), "x");
    }
}
