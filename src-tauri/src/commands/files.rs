use std::path::PathBuf;
use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::{NoteMetadata, PropertyValue};
use crate::state::{AppState, NoteboxSession};
use crate::storage::sanitize_notebox_arg;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter;
use crate::typst_pipeline::source_structure;

pub use crate::storage::traits::FileTreeNode;

#[derive(serde::Serialize)]
pub struct LinkInfo {
    pub path: String,
    pub name: String,
    /// Unix epoch seconds. Zero when stat is unavailable (file deleted
    /// between index time and IPC call) — the Links pane's mtime/ctime
    /// sort treats 0 as "unknown" and pushes the entry to the bottom.
    pub modified_time: u64,
    pub created_time: u64,
    /// The linked note's `#note(zid:)`, when present. `None` for notes
    /// without a zid — the Links pane's zid sort pushes those to the end.
    pub zid: Option<String>,
}

fn file_times(path: &std::path::Path) -> (u64, u64) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (0, 0),
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ctime = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (mtime, ctime)
}

/// Read the UTF-8 content of a file in the notebox. Requires an open notebox.
#[tauri::command]
pub async fn read_file_content(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    storage.read_file(&path_buf).await
}

/// Return the notebox's directory tree as a flat list of nodes. Requires an open notebox.
#[tauri::command]
pub async fn get_file_tree(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<FileTreeNode>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let mut tree = storage.get_file_tree().await?;

    // Enrich note nodes with their `zid` so the file tree can sort by it.
    // The storage walk doesn't read note metadata; join against the property
    // index here under a single brief read lock (a hashmap lookup per node,
    // no extra file I/O).
    {
        let index = session.property_index.read().await;
        enrich_tree_zids(&mut tree, &index);
    }
    Ok(tree)
}

/// Recursively fill each file node's `zid` from the property index. Directory
/// nodes never carry a zid; their children are walked instead.
fn enrich_tree_zids(
    nodes: &mut [FileTreeNode],
    index: &crate::scanner::property_index::PropertyIndex,
) {
    for node in nodes.iter_mut() {
        if let Some(children) = node.children.as_mut() {
            enrich_tree_zids(children, index);
        } else {
            node.zid = index
                .notes
                .get(&PathBuf::from(&node.path))
                .and_then(|m| m.zid());
        }
    }
}

/// Return parsed `#note(...)` metadata for a file, falling back to on-demand reindex if not yet cached.
#[tauri::command]
pub async fn get_file_metadata(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<NoteMetadata, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_buf = sanitize_notebox_arg(&path)?;

    {
        let index = session.property_index.read().await;
        if let Some(meta) = index.notes.get(&path_buf).cloned() {
            return Ok(meta);
        }
    }

    // Fallback: file isn't in the index yet (initial notebox scan may have
    // missed it, or it was created out-of-band). Read it and reindex on
    // demand so the panel doesn't stay permanently blank until the user
    // edits the file.
    let storage = session.get_storage().await?;
    let content = storage.read_file(&path_buf).await?;
    session.reindex_note(&path_buf, &content).await;

    let index = session.property_index.read().await;
    index
        .notes
        .get(&path_buf)
        .cloned()
        .ok_or(InkyCapError::FileNotFound(path))
}

/// Stat a list of linked notes into [`LinkInfo`] rows. The filesystem stats
/// run on a blocking pool — never on the async worker, and never while holding
/// the `link_index` / `property_index` read lock (a concurrent reindex needs
/// the write lock). Callers snapshot the `(path, zid)` pairs off the indexes
/// first, then call this; `zid` is read from the property index because it
/// lives in the note's `#note(...)` metadata, not on the filesystem.
async fn link_infos_for(paths: Vec<(PathBuf, Option<String>)>) -> Vec<LinkInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|(p, zid)| {
                let name = p
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let (mtime, ctime) = file_times(&p);
                LinkInfo {
                    path: to_frontend_string(&p),
                    name,
                    modified_time: mtime,
                    created_time: ctime,
                    zid,
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Pair each path with the `zid` recorded in the property index, snapshotting
/// under a brief read lock so no lock is held across the stat I/O that
/// [`link_infos_for`] performs.
async fn paths_with_zid(
    session: &NoteboxSession,
    paths: Vec<PathBuf>,
) -> Vec<(PathBuf, Option<String>)> {
    let index = session.property_index.read().await;
    paths
        .into_iter()
        .map(|p| {
            let zid = index.notes.get(&p).and_then(|m| m.zid());
            (p, zid)
        })
        .collect()
}

/// Return all notes that link to the given file path via wikilinks.
#[tauri::command]
pub async fn get_backlinks(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<LinkInfo>, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_buf = sanitize_notebox_arg(&path)?;

    // Snapshot the path list, then drop the index lock before any stat I/O.
    let backlinks = {
        let link_index = session.link_index.read().await;
        link_index.get_backlinks(&path_buf)
    };
    Ok(link_infos_for(paths_with_zid(&session, backlinks).await).await)
}

/// Return all notes that the given file links to via wikilinks.
#[tauri::command]
pub async fn get_forward_links(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<LinkInfo>, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_buf = sanitize_notebox_arg(&path)?;

    // Snapshot the path list, then drop the index lock before any stat I/O.
    let links = {
        let link_index = session.link_index.read().await;
        link_index.get_forward_links(&path_buf)
    };
    Ok(link_infos_for(paths_with_zid(&session, links).await).await)
}

/// One entry in the Outbound Links section of the right-panel Links tab.
/// Combines wikilink-target resolution with file stat in one IPC so the
/// frontend doesn't have to fan out per-target requests just to sort by
/// modified/created time.
///
/// `path` / `modified_time` / `created_time` / `name` are populated only
/// when the target resolves to a real note. For unresolved targets,
/// `name` holds the raw wikilink text (for "Create" affordance) and
/// `path` is empty.
#[derive(serde::Serialize)]
pub struct OutboundLink {
    /// Raw wikilink target as authored in the source note.
    pub target: String,
    /// Absolute path of the resolved note, or empty string when unresolved.
    pub path: String,
    pub name: String,
    pub resolved: bool,
    pub modified_time: u64,
    pub created_time: u64,
    /// The resolved note's `#note(zid:)`, when present. Always `None` for
    /// unresolved targets (no note to read it from).
    pub zid: Option<String>,
}

/// Return every wikilink target from the note's `#note(...)` metadata,
/// resolved to a file when possible. Replaces the previous frontend
/// loop of `getFileMetadata` → `resolveWikilink` per target so the
/// Links pane can sort by mtime/ctime without N extra round-trips.
#[tauri::command]
pub async fn get_outbound_links(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<OutboundLink>, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_buf = sanitize_notebox_arg(&path)?;

    // Read raw wikilink targets from the note's metadata, falling back to
    // an on-demand reindex if the property index hasn't seen this file
    // yet (matches `get_file_metadata`'s behaviour).
    let raw_targets: Vec<String> = {
        let prop_index = session.property_index.read().await;
        if let Some(meta) = prop_index.notes.get(&path_buf) {
            meta.links.clone()
        } else {
            drop(prop_index);
            let storage = session.get_storage().await?;
            let content = storage.read_file(&path_buf).await?;
            session.reindex_note(&path_buf, &content).await;
            let prop_index = session.property_index.read().await;
            prop_index
                .notes
                .get(&path_buf)
                .map(|m| m.links.clone())
                .unwrap_or_default()
        }
    };

    // Snapshot all known note paths plus their zids once to feed the stem
    // resolver in a single allocation rather than re-snapping per-target.
    let (all_paths, zid_by_path): (
        Vec<PathBuf>,
        std::collections::HashMap<PathBuf, Option<String>>,
    ) = {
        let prop_index = session.property_index.read().await;
        let paths: Vec<PathBuf> = prop_index.notes.keys().cloned().collect();
        let zids = prop_index
            .notes
            .iter()
            .map(|(p, m)| (p.clone(), m.zid()))
            .collect();
        (paths, zids)
    };

    // Dedup raw targets — a note may wikilink to the same target several
    // times but we only want one row in the panel.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<OutboundLink> = Vec::new();
    for raw in raw_targets {
        if !seen.insert(raw.clone()) {
            continue;
        }
        let target_name = raw.split("::").next().unwrap_or(&raw);
        let target_name = target_name.split('#').next().unwrap_or(target_name).trim();
        if target_name.is_empty() {
            continue;
        }
        let target_lower = target_name.to_lowercase();

        let mut matches: Vec<&PathBuf> = all_paths
            .iter()
            .filter(|p| {
                p.file_stem()
                    .map(|s| s.to_string_lossy().to_lowercase() == target_lower)
                    .unwrap_or(false)
            })
            .collect();

        if matches.is_empty() {
            out.push(OutboundLink {
                target: raw.clone(),
                path: String::new(),
                name: raw,
                resolved: false,
                modified_time: 0,
                created_time: 0,
                zid: None,
            });
            continue;
        }

        matches.sort_by_key(|p| p.components().count());
        let resolved_path = matches[0].clone();
        let name = resolved_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (mtime, ctime) = file_times(&resolved_path);
        let zid = zid_by_path.get(&resolved_path).cloned().flatten();
        out.push(OutboundLink {
            target: raw,
            path: to_frontend_string(&resolved_path),
            name,
            resolved: true,
            modified_time: mtime,
            created_time: ctime,
            zid,
        });
    }
    Ok(out)
}

/// Write file content to disk. Used by the frontend auto-save.
#[tauri::command]
pub async fn write_file_content(
    path: String,
    content: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        // Documentation notebox: keep the edit in the editor for the session
        // but never persist it. A silent Ok keeps autosave seamless while
        // nothing reaches disk, so reopening the manual is always pristine.
        return Ok(());
    }
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    storage.write_file(&path_buf, &content).await?;

    // Re-index the note after saving
    reindex_note(&path_buf, &content, &session).await;

    Ok(())
}

/// Update a single `#note(...)` property and write back to disk.
/// Uses raw string manipulation for round-trip safety.
#[tauri::command]
pub async fn update_property(
    path: String,
    key: String,
    value: PropertyValue,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        // Ephemeral like content writes (see write_file_content): the property
        // panel reflects the change for the session but nothing is saved.
        return Ok(());
    }
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;

    let content = storage.read_file(&path_buf).await?;
    // Ensure the inkycap-notebox import is present before the rewriter
    // synthesizes a `#note(...)` call. Without this, a note that has no
    // import yet gets a `#note(...)` call referencing an unbound symbol —
    // `typst query` fails on reindex, and the new property never reaches
    // the property index, leaving the panel blank after first add.
    let content = crate::notebox_package::ensure_import(&content);
    let updated = note_rewriter::update_note_property(&content, &key, &value);
    storage.write_file(&path_buf, &updated).await?;

    // Re-index after property change
    reindex_note(&path_buf, &updated, &session).await;

    Ok(())
}

/// Set (or clear) a note's document-level recurrence rule
/// (`#note(recurrence: (…))`). Passing `None` removes the argument. The rule is
/// structured, not a generic scalar property, so it bypasses `update_property`
/// and writes the Typst dict directly via the raw-argument upsert — keeping it
/// out of the generic property surfaces while sharing the same round-trip-safe
/// rewriter.
#[tauri::command]
pub async fn set_note_recurrence(
    path: String,
    recurrence: Option<crate::models::recurrence::Recurrence>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Ok(());
    }
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;

    let content = storage.read_file(&path_buf).await?;
    let content = crate::notebox_package::ensure_import(&content);
    let updated = match recurrence {
        Some(rule) => {
            note_rewriter::set_note_property_raw(&content, "recurrence", &rule.to_typst_source())
        }
        None => note_rewriter::remove_note_property(&content, "recurrence"),
    };
    storage.write_file(&path_buf, &updated).await?;

    reindex_note(&path_buf, &updated, &session).await;

    Ok(())
}

/// Read a notebox media file as raw bytes, returned to the webview as an
/// ArrayBuffer (no base64 inflation). The frontend wraps these in a `blob:`
/// URL to play `#video` / `#audio`: WebKitGTK doesn't reliably stream media
/// through Tauri's custom asset protocol (images work, media silently fails),
/// but blob URLs play everywhere. `target` is a notebox-root-absolute path
/// like `/Assets/clip.mp4`; traversal is blocked by `validate_notebox_path`.
#[tauri::command]
pub async fn read_media_bytes(
    target: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<tauri::ipc::Response, InkyCapError> {
    let session = state.session(window.label()).await;
    // Clone the root and drop the lock before any filesystem work — media can
    // be hundreds of MB, and we must not hold the notebox_root read lock (or
    // block the async worker) across the read.
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let clean = target.split('|').next().unwrap_or(&target).trim();
    let stripped = clean.trim_start_matches('/').trim_start_matches('\\');
    let candidate = root.join(stripped);
    let resolved = crate::storage::path::validate_notebox_path(&root, &candidate)?;
    if !resolved.is_file() {
        return Err(InkyCapError::InvalidPath(format!("Not a file: {target}")));
    }
    let bytes = tokio::fs::read(&resolved).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Resolve an embed target to an absolute notebox file path, or `None` when
/// nothing matches. Two forms, mirroring how notes reference attachments:
///
/// - **Path form** (`/Assets/foo.png`, `Assets/foo.png`): a notebox-root-
///   relative path with the leading slash optional, matching Typst's own
///   `#image("/Assets/foo.png")` semantics. Resolved directly; `..` traversal
///   is rejected by `validate_notebox_path`.
/// - **Bare filename** (`foo.png`): searched across the whole notebox by name
///   (case-insensitive, shortest path wins).
///
/// Shared by [`resolve_embed_path`] (hands the path string to the frontend) and
/// [`read_embed_bytes`] (streams the bytes to the webview) so both honour the
/// exact same resolution rules.
async fn resolve_embed_target(
    target: &str,
    storage: &crate::storage::local::LocalNoteboxStorage,
    root: &std::path::Path,
) -> Result<Option<PathBuf>, InkyCapError> {
    // Strip any size suffix (e.g. "image.png|400" -> "image.png")
    let clean_target = target.split('|').next().unwrap_or(target).trim();

    // Path form: resolve directly, skipping the filename search.
    if clean_target.contains('/') || clean_target.contains('\\') {
        let stripped = clean_target
            .trim_start_matches('/')
            .trim_start_matches('\\');
        let candidate = root.join(stripped);
        if let Ok(resolved) = crate::storage::path::validate_notebox_path(root, &candidate) {
            if resolved.is_file() {
                return Ok(Some(resolved));
            }
        }
        return Ok(None);
    }

    // Bare filename — search the whole notebox by name.
    let ext = std::path::Path::new(clean_target)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();

    if ext.is_empty() {
        return Ok(None);
    }

    let pattern = format!("*.{}", ext);
    let files = storage.list_files(root, &pattern).await?;

    // Find by filename match (case-insensitive, shortest path wins)
    let target_lower = clean_target.to_lowercase();
    let mut best: Option<PathBuf> = None;

    for path in &files {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if name == target_lower {
            let is_shorter = match &best {
                Some(prev) => path.to_string_lossy().len() < prev.to_string_lossy().len(),
                None => true,
            };
            if is_shorter {
                best = Some(path.clone());
            }
        }
    }

    Ok(best)
}

/// Resolve an embed target (e.g. "image.png") to an absolute file path string
/// for the frontend. See [`resolve_embed_target`] for the resolution rules.
#[tauri::command]
pub async fn resolve_embed_path(
    target: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let resolved = resolve_embed_target(&target, &storage, root).await?;
    Ok(resolved.map(|p| to_frontend_string(&p)))
}

/// Read an embedded image as raw bytes, returned to the webview as an
/// ArrayBuffer the visual editor wraps in a `blob:` URL.
///
/// The visual-editor image widgets load attachments this way rather than via
/// `convertFileSrc`: Tauri's custom asset protocol is unreliable across
/// platforms for embedded files (media silently fails on WebKitGTK — see
/// [`read_media_bytes`] — and images fail on Windows, where the canonicalized
/// `\\?\` path is matched against the scope glob and the load is denied). A
/// blob URL sidesteps the asset protocol, its scope check, and its
/// separator/verbatim-prefix matching entirely, so it renders identically on
/// every OS. `target` accepts the same path / bare-filename forms as
/// [`resolve_embed_path`]; traversal is blocked by `validate_notebox_path`.
#[tauri::command]
pub async fn read_embed_bytes(
    target: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<tauri::ipc::Response, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    // Clone the root and drop the lock before the read so a large attachment
    // doesn't hold the notebox_root lock across filesystem I/O.
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let resolved = resolve_embed_target(&target, &storage, &root)
        .await?
        .ok_or_else(|| InkyCapError::InvalidPath(format!("Embed not found: {target}")))?;

    let bytes = tokio::fs::read(&resolved).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Resolve a wikilink target string to a file path.
/// Returns the full file path if found, None if unresolved.
#[tauri::command]
pub async fn resolve_wikilink(
    target: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let link_index = session.link_index.read().await;
    let prop_index = session.property_index.read().await;
    let all_paths: Vec<PathBuf> = prop_index.notes.keys().cloned().collect();
    drop(prop_index);
    drop(link_index);

    // Strip heading references: note::heading or note#heading -> note
    let target_name = target.split("::").next().unwrap_or(&target);
    let target_name = target_name.split('#').next().unwrap_or(target_name).trim();
    if target_name.is_empty() {
        return Ok(None);
    }

    let target_lower = target_name.to_lowercase();
    let mut matches: Vec<&PathBuf> = all_paths
        .iter()
        .filter(|p| {
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase() == target_lower)
                .unwrap_or(false)
        })
        .collect();

    if matches.is_empty() {
        return Ok(None);
    }

    matches.sort_by_key(|p| p.components().count());
    Ok(Some(to_frontend_string(matches[0])))
}

/// Find an existing note anywhere in the notebox whose wikilink stem matches
/// `name` (case-insensitively), returning the shortest-path match.
///
/// Note filenames are unique across the whole notebox: wikilinks resolve by
/// stem (see [`crate::link_index`]), so the same stem in two different folders
/// makes `[[Name]]` ambiguous and surfaces the note twice. The note-creation
/// paths use this to open the existing note instead of writing a duplicate.
/// `name` may carry a trailing `.typ`; it is normalized through `note_stem`.
pub(crate) async fn existing_note_with_stem(
    session: &NoteboxSession,
    name: &str,
) -> Option<PathBuf> {
    let want = crate::link_index::note_stem(std::path::Path::new(name)).to_lowercase();
    if want.is_empty() {
        return None;
    }
    let index = session.property_index.read().await;
    index
        .notes
        .keys()
        .filter(|p| crate::link_index::note_stem(p).to_lowercase() == want)
        .min_by_key(|p| p.components().count())
        .cloned()
}

/// Create a new note file. Returns the full path of the created file.
/// If scaffold_content is provided, it is used as the initial content.
/// Otherwise the file starts with the inkycap-notebox import line.
///
/// Filenames are notebox-globally unique (wikilinks resolve by stem; see
/// [`existing_note_with_stem`]). Re-creating a note at the exact same path
/// opens it. A name that collides with a note in a *different* folder returns
/// [`InkyCapError::NoteNameConflict`] (carrying the existing path) instead of
/// duplicating — the frontend prompts the user to open it or rename.
#[tauri::command]
pub async fn create_note(
    name: String,
    folder: String,
    scaffold_content: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    // Build the target path
    let dir = if folder.is_empty() {
        root.clone()
    } else {
        root.join(&folder)
    };

    // Ensure the filename ends with .typ
    let filename = if name.ends_with(".typ") {
        name.clone()
    } else {
        format!("{}.typ", name)
    };

    let file_path = dir.join(&filename);

    // A note already sitting at this exact path (same folder, same name) is
    // expected reuse — open it rather than fail or duplicate.
    if file_path.exists() {
        return Ok(to_frontend_string(&file_path));
    }
    // A note with this name living in a *different* folder is a real conflict:
    // filenames are notebox-globally unique (wikilinks resolve by stem), so a
    // second one would make `[[Name]]` ambiguous. Don't decide for the user —
    // signal the conflict with the existing path so the frontend can ask
    // whether to open it or pick a different name.
    if let Some(existing) = existing_note_with_stem(&session, &filename).await {
        return Err(InkyCapError::NoteNameConflict(to_frontend_string(
            &existing,
        )));
    }

    // storage.write_file creates any missing parent directories through the
    // same validated path pipeline, so no std::fs bypass is needed here.
    let import_line = crate::notebox_package::import_line();
    let content = scaffold_content.unwrap_or_else(|| format!("{import_line}\n\n"));
    // Ensure the import line is present even when scaffold_content is
    // provided (scaffolds authored by users may not include it).
    let content = if !content.contains(&import_line) {
        format!("{import_line}\n\n{content}")
    } else {
        content
    };
    storage.write_file(&file_path, &content).await?;

    // Index the new note
    reindex_note(&file_path, &content, &session).await;

    Ok(to_frontend_string(&file_path))
}

/// Get a text preview of a note (first N characters, preamble stripped).
#[tauri::command]
pub async fn get_note_preview(
    path: String,
    max_chars: Option<usize>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path_buf).await?;

    let max = max_chars.unwrap_or(200);
    let body = crate::notebox_package::strip_note_preamble(&content);
    let preview: String = body.chars().take(max).collect();
    Ok(preview)
}

/// Heading info returned to the frontend.
#[derive(serde::Serialize)]
pub struct HeadingInfo {
    pub level: u8,
    pub text: String,
    pub label: Option<String>,
}

/// Get all headings from a note file. Used for heading autocomplete
/// and label lookup. Parses Typst `= heading` syntax.
#[tauri::command]
pub async fn get_note_headings(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<HeadingInfo>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path_buf).await?;
    Ok(extract_headings(&content))
}

/// Project the parser's headings onto the shape the frontend consumes.
///
/// Which lines are headings is [`source_structure::headings`]'s call — the
/// same parser the compiler runs — so `= Example` inside a ``` fence never
/// reaches heading autocomplete as if it were a section.
fn extract_headings(content: &str) -> Vec<HeadingInfo> {
    source_structure::headings(content)
        .into_iter()
        .map(|h| HeadingInfo {
            // Typst doesn't cap heading depth; the outline UI indents by
            // level, so anything past 6 is clamped for display.
            level: h.level.min(6),
            text: h.text,
            label: h.label,
        })
        .collect()
}

/// A standalone `<label>` in a note, returned to the frontend.
#[derive(serde::Serialize)]
pub struct LabelInfo {
    pub name: String,
    /// The words the label tags, for showing the writer what they're linking to.
    pub context: String,
}

/// Get the standalone labels in a note — the ones a writer attached to prose, a
/// figure, or an equation, as opposed to a heading's own label, which
/// [`get_note_headings`] already reports. Drives the wikilink picker's label
/// list, so `[[Note::` can link to any anchor in the target note.
#[tauri::command]
pub async fn get_note_labels(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<LabelInfo>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path_buf).await?;
    Ok(source_structure::labels(&content)
        .into_iter()
        .map(|l| LabelInfo {
            name: l.name,
            context: l.context,
        })
        .collect())
}

/// Ensure a heading in the target note has a `<label>` tag. If the heading
/// exists but lacks a label, one is auto-inserted. Returns the label that
/// was applied (existing or newly generated).
#[tauri::command]
pub async fn ensure_heading_label(
    path: String,
    heading_text: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path_buf).await?;

    let headings = source_structure::headings(&content);
    let heading_lower = heading_text.to_lowercase();

    let Some(matched) = headings
        .iter()
        .find(|h| h.text.to_lowercase() == heading_lower)
    else {
        return Ok(None);
    };

    if let Some(existing) = &matched.label {
        return Ok(Some(existing.clone()));
    }

    let label = heading_to_label(&heading_text, &headings);

    let new_content = insert_heading_label(&content, matched, &label);

    storage.write_file(&path_buf, &new_content).await?;
    reindex_note(&path_buf, &new_content, &session).await;
    Ok(Some(label))
}

/// Write ` <label>` onto the end of `heading`, returning the new source.
///
/// The insertion point is the byte offset the parser reports for the end of
/// the heading — no re-finding the line by prefix, so a look-alike line
/// elsewhere in the note can't be hit by mistake, and the rest of the file is
/// copied through byte for byte. Trailing spaces before the line break are
/// absorbed, so the result reads `= Title <label>`, not `= Title <label>   `.
fn insert_heading_label(
    content: &str,
    heading: &source_structure::SourceHeading,
    label: &str,
) -> String {
    let mut resume_at = heading.range.end;
    let bytes = content.as_bytes();
    while matches!(bytes.get(resume_at), Some(b' ') | Some(b'\t')) {
        resume_at += 1;
    }

    let mut out = String::with_capacity(content.len() + label.len() + 4);
    out.push_str(&content[..heading.range.end]);
    out.push_str(&format!(" <{label}>"));
    out.push_str(&content[resume_at..]);
    out
}

fn heading_to_label(text: &str, existing_headings: &[source_structure::SourceHeading]) -> String {
    let base: String = text
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() {
                Some(c.to_lowercase().next().unwrap_or(c))
            } else if c == ' ' || c == '-' || c == '_' {
                Some('-')
            } else {
                None
            }
        })
        .collect();
    let base = base.trim_matches('-').to_string();
    if base.is_empty() {
        return "heading".to_string();
    }

    let existing_labels: Vec<&str> = existing_headings
        .iter()
        .filter_map(|h| h.label.as_deref())
        .collect();

    if !existing_labels.contains(&base.as_str()) {
        return base;
    }

    for i in 2..100 {
        let candidate = format!("{base}-{i}");
        if !existing_labels.contains(&candidate.as_str()) {
            return candidate;
        }
    }
    base
}

/// Alias entry returned to the frontend for autocomplete.
#[derive(serde::Serialize)]
pub struct AliasEntry {
    pub alias: String,
    pub note_name: String,
    pub note_path: String,
}

/// Get all note aliases for wikilink autocomplete.
#[tauri::command]
pub async fn get_all_aliases(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<AliasEntry>, InkyCapError> {
    let session = state.session(window.label()).await;
    let index = session.property_index.read().await;
    let mut entries = Vec::new();
    for (alias, ids) in index.aliases_iter() {
        for id in ids {
            let name = id
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            entries.push(AliasEntry {
                alias: alias.to_string(),
                note_name: name,
                note_path: to_frontend_string(id),
            });
        }
    }
    Ok(entries)
}

/// Multi-line excerpt of a backlink. `line` is the line that mentions the
/// target; `context_before` / `context_after` carry up to 2 surrounding
/// lines each so the Links pane can show extra context when the user
/// toggles "more context" on. All strings are trimmed of trailing
/// whitespace but left-padding (indentation) is preserved.
#[derive(serde::Serialize)]
pub struct BacklinkContext {
    pub line: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

/// Get the context lines where `source_path` links to `target_path`.
/// Returns the first wikilink-bearing line plus up to two lines of
/// surrounding context on each side. Matches both the `[[target]]`
/// markdown shortcut and the canonical `#wikilink("target")` call.
#[tauri::command]
pub async fn get_backlink_context(
    source_path: String,
    target_path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<BacklinkContext>, InkyCapError> {
    let session = state.session(window.label()).await;
    const CONTEXT_LINES: usize = 2;
    const MAX_SNIPPET_CHARS: usize = 200;

    let storage = session.get_storage().await?;
    let source = sanitize_notebox_arg(&source_path)?;
    let target = sanitize_notebox_arg(&target_path)?;

    let content = storage.read_file(&source).await?;

    let target_name = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if target_name.is_empty() {
        return Ok(None);
    }
    let bracket_marker = format!("[[{}", target_name);
    let call_marker = format!("#wikilink(\"{}", target_name);

    let lines: Vec<&str> = content.lines().collect();
    for (idx, line) in lines.iter().enumerate() {
        let lower = line.to_lowercase();
        if !(lower.contains(&bracket_marker) || lower.contains(&call_marker)) {
            continue;
        }
        let snippet = trim_snippet(line, MAX_SNIPPET_CHARS);
        let before_start = idx.saturating_sub(CONTEXT_LINES);
        let context_before: Vec<String> = lines[before_start..idx]
            .iter()
            .map(|l| trim_snippet(l, MAX_SNIPPET_CHARS))
            .collect();
        let after_end = (idx + 1 + CONTEXT_LINES).min(lines.len());
        let context_after: Vec<String> = lines[idx + 1..after_end]
            .iter()
            .map(|l| trim_snippet(l, MAX_SNIPPET_CHARS))
            .collect();
        return Ok(Some(BacklinkContext {
            line: snippet,
            context_before,
            context_after,
        }));
    }

    Ok(None)
}

/// Trim trailing whitespace and truncate to a printable character budget,
/// appending an ellipsis when the original was longer. UTF-8 safe: works
/// on `chars()` so a multi-byte glyph at the boundary isn't sliced.
fn trim_snippet(line: &str, max_chars: usize) -> String {
    let trimmed = line.trim_end();
    let char_count = trimmed.chars().count();
    if char_count <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('\u{2026}');
    out
}

/// One entry in the "Potential Links" list shown beneath Outbound Links
/// in the right-panel Links tab. Returned by [`get_potential_links`]:
/// a note that mentions the current note's name but does not have a
/// resolved wikilink to it.
#[derive(serde::Serialize)]
pub struct PotentialLink {
    pub path: String,
    pub name: String,
    /// First matching line (trimmed). Empty string when the search engine
    /// returned a filter-only hit with no text match — those still satisfy
    /// the phrase predicate but have nothing useful to render.
    pub line: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
    pub modified_time: u64,
    pub created_time: u64,
    /// The mentioning note's `#note(zid:)`, when present. `None` pushes the
    /// row to the end of the Links pane's zid sort.
    pub zid: Option<String>,
}

/// Find notes that mention the current note's filename stem as a phrase but
/// don't yet wikilink to it. Useful for surfacing missed link opportunities.
///
/// Strategy: phrase-search the notebox for the stem via the existing inverted
/// index, then filter out (a) the current note itself, (b) any note already
/// known to link to it (resolved or unresolved targets that match by stem),
/// and (c) results whose only "match" is the wikilink call we'd otherwise
/// suggest creating. Result count is capped to keep the panel snappy on
/// large noteboxes.
#[tauri::command]
pub async fn get_potential_links(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<PotentialLink>, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_buf = sanitize_notebox_arg(&path)?;

    let stem = path_buf
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if stem.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Resolved backlinks: pre-existing inbound edges we should skip.
    let already_linking: std::collections::HashSet<PathBuf> = {
        let link_index = session.link_index.read().await;
        link_index.get_backlinks(&path_buf).into_iter().collect()
    };

    // Use the existing search engine so we benefit from the inverted index
    // rather than scanning every file's content on each call.
    let query = format!("\"{}\"", stem);
    let parsed = match crate::search::query::parse_query(&query) {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let results = {
        let engine = session.search_engine.read().await;
        engine.search(&parsed, 300)
    };

    // Snapshot zids for the mentioning notes once so the loop below — which
    // has no await points — never holds a lock across its work.
    let zid_by_path: std::collections::HashMap<PathBuf, Option<String>> = {
        let prop_index = session.property_index.read().await;
        prop_index
            .notes
            .iter()
            .map(|(p, m)| (p.clone(), m.zid()))
            .collect()
    };

    let stem_lower = stem.to_lowercase();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut out: Vec<PotentialLink> = Vec::new();
    for r in results {
        let p = PathBuf::from(&r.path);
        if p == path_buf {
            continue;
        }
        if already_linking.contains(&p) {
            continue;
        }
        // Drop matches that occur *inside* a wikilink call — those represent
        // the link we'd be suggesting the user create, not a plain mention.
        let line_lower = r.line_text.to_lowercase();
        let wikilink_call = format!("#wikilink(\"{}", stem_lower);
        let wikilink_bracket = format!("[[{}", stem_lower);
        if line_lower.contains(&wikilink_call) || line_lower.contains(&wikilink_bracket) {
            continue;
        }
        if !seen.insert(p.clone()) {
            continue;
        }
        let name = p
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        const MAX_SNIPPET: usize = 200;
        let line = trim_snippet(&r.line_text, MAX_SNIPPET);
        let context_before: Vec<String> = r
            .context_before
            .iter()
            .map(|s| trim_snippet(s, MAX_SNIPPET))
            .collect();
        let context_after: Vec<String> = r
            .context_after
            .iter()
            .map(|s| trim_snippet(s, MAX_SNIPPET))
            .collect();
        out.push(PotentialLink {
            path: to_frontend_string(&p),
            name,
            line,
            context_before,
            context_after,
            // SearchResult uses i64 (Tantivy/Hayagriva legacy); clamp to
            // u64 to match the surrounding LinkInfo / FileTreeNode shape.
            // Negative timestamps would only appear for pre-1970 ctime
            // values, which we never see for notebox files.
            modified_time: r.modified_time.max(0) as u64,
            created_time: r.created_time.max(0) as u64,
            zid: zid_by_path.get(&p).cloned().flatten(),
        });
    }
    Ok(out)
}

/// Thin wrapper kept for the benefit of other command modules that
/// historically called this symbol. New call sites should prefer
/// `session.reindex_note(...)` directly — this helper exists only to avoid a
/// sprawling rename.
pub async fn reindex_note_public(path: &std::path::Path, content: &str, session: &NoteboxSession) {
    session.reindex_note(path, content).await;
}

/// Local alias for the unified indexing helper on [`AppState`], retained so
/// this module's existing call sites read naturally.
async fn reindex_note(path: &std::path::Path, content: &str, session: &NoteboxSession) {
    session.reindex_note(path, content).await;
}

#[cfg(test)]
mod heading_tests {
    use super::*;

    /// The shape from issue #21: a fence nested in a list, holding a line that
    /// looks exactly like a top-level heading.
    const ISSUE_21: &str = "= Headline\n- Bullet\n  - ```\n= Not a headliner\n```\n";

    #[test]
    fn extract_headings_ignores_a_heading_inside_a_fence() {
        let found = extract_headings(ISSUE_21);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "Headline");
        assert_eq!(found[0].level, 1);
    }

    #[test]
    fn extract_headings_reads_levels_labels_and_clamps_depth_for_the_ui() {
        let found = extract_headings("= One <one>\n\n== Two\n\n========= Deep\n");
        assert_eq!(found[0].label.as_deref(), Some("one"));
        assert_eq!(found[0].text, "One");
        assert_eq!(found[1].level, 2);
        assert_eq!(
            found[2].level, 6,
            "9 markers clamp to the UI's deepest indent"
        );
    }

    #[test]
    fn insert_heading_label_writes_at_the_heading_end() {
        let content = "= Intro\n\nbody\n\n== Later\n";
        let heading = &source_structure::headings(content)[0];
        assert_eq!(
            insert_heading_label(content, heading, "intro"),
            "= Intro <intro>\n\nbody\n\n== Later\n"
        );
    }

    #[test]
    fn insert_heading_label_absorbs_trailing_spaces_and_keeps_the_rest_byte_for_byte() {
        // Trailing whitespace on the heading line goes; a CRLF line ending
        // further down stays, because the rest of the file is copied, not
        // re-joined line by line.
        let content = "= Intro   \r\nbody\r\n";
        let heading = &source_structure::headings(content)[0];
        assert_eq!(
            insert_heading_label(content, heading, "intro"),
            "= Intro <intro>\r\nbody\r\n"
        );
    }

    #[test]
    fn insert_heading_label_targets_the_parsed_heading_not_a_look_alike_line() {
        // The fence holds a line identical to the real heading. Splicing by
        // byte range can't hit it; the old prefix search could.
        let content = "```\n= Intro\n```\n\n= Intro\n";
        let heading = &source_structure::headings(content)[0];
        assert_eq!(
            insert_heading_label(content, heading, "intro"),
            "```\n= Intro\n```\n\n= Intro <intro>\n"
        );
    }
}
