// ---------------------------------------------------------------------------
// Journal Scroll — unified ScrollQuery primitive.
//
// The Journal Scroll view (and internal sub-queries like the right-panel
// "Scroll Context" tab and the wikilink-routing `queryResultIncludes` check)
// issue queries against the in-memory `PropertyIndex` / `LinkIndex` through
// this single command. The frontend pill exposes a curated subset of the
// filter variants (Date / Tree / Properties); LinkedFrom, LinkedTo, and
// PropertyAny exist so the right-panel sub-panes and routing logic can build
// on the same primitive without each defining its own ad-hoc command.
// ---------------------------------------------------------------------------

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::{NoteMetadata, PropertyValue};
use crate::scanner::property_index::PropertyIndex;
use crate::state::AppState;
use crate::storage::sanitize_vault_arg;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ScrollQuery {
    pub filter: ScrollFilter,
    pub sort: ScrollSort,
    pub anchor: String,
    /// Signed offset relative to the anchor's position in the sorted result.
    /// Negative = before, zero = anchor row, positive = after.
    pub offset: i32,
    pub limit: usize,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScrollFilter {
    /// All notes in the vault.
    All,
    /// Notes within a folder (recursive when set).
    Folder { path: PathBuf, recursive: bool },
    /// Notes whose property `name` equals `value`. List-valued properties
    /// match when any element equals `value`. `name == "tags"` consults the
    /// index's tag map for O(1) lookup.
    PropertyEq { name: String, value: PropertyValue },
    /// Notes that have any non-empty value for property `name`.
    PropertyAny { name: String },
    /// Notes that `source` links to (outgoing wikilinks from `source`).
    LinkedFrom { source: PathBuf },
    /// Notes that link to `target` (backlinks of `target`).
    LinkedTo { target: PathBuf },
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScrollSort {
    /// Sort by a property value (lexicographic string compare).
    Property { name: String, direction: SortDir },
    /// Sort by title (case-insensitive).
    Title { direction: SortDir },
    /// Sort by ZID (descending — most recent first).
    Zid,
}

#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScrollEntry {
    pub path: String,
    pub title: String,
}

#[tauri::command]
pub async fn run_scroll_query(
    query: ScrollQuery,
    state: State<'_, AppState>,
) -> Result<Vec<ScrollEntry>, InkyCapError> {
    let anchor_path = sanitize_vault_arg(&query.anchor)?;
    let sorted = build_sorted(&query.filter, &query.sort, &state).await?;
    Ok(slice_around_anchor(&sorted, &anchor_path, query.offset, query.limit))
}

/// Locate `target` within the same sorted result set `run_scroll_query`
/// would produce, returning its offset relative to `anchor` (negative =
/// before, zero = anchor row, positive = after). Returns `Ok(None)` when
/// the target isn't in the result.
///
/// Used by the Journal Scroll wikilink-click handler: if the user clicks a
/// wikilink whose target is in the current scroll's query but not yet
/// loaded, the frontend pages in that direction until the target loads,
/// then smooth-scrolls to it. Without this, the click falls through to a
/// new tab even when the target is just past the loaded window.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FindInScrollQuery {
    pub filter: ScrollFilter,
    pub sort: ScrollSort,
    pub anchor: String,
    pub target: String,
}

#[tauri::command]
pub async fn find_offset_in_scroll_query(
    query: FindInScrollQuery,
    state: State<'_, AppState>,
) -> Result<Option<i32>, InkyCapError> {
    let anchor_path = sanitize_vault_arg(&query.anchor)?;
    let target_path = sanitize_vault_arg(&query.target)?;
    let sorted = build_sorted(&query.filter, &query.sort, &state).await?;
    let anchor_str = anchor_path.display().to_string();
    let target_str = target_path.display().to_string();
    let anchor_idx = sorted.iter().position(|e| e.path == anchor_str);
    let target_idx = sorted.iter().position(|e| e.path == target_str);
    match (anchor_idx, target_idx) {
        (Some(a), Some(t)) => Ok(Some((t as i64 - a as i64) as i32)),
        // Target not in result.
        (_, None) => Ok(None),
        // Anchor not in result (shouldn't happen for a normal scroll, but
        // we treat the anchor as offset 0 by convention so target's index
        // becomes its absolute offset).
        (None, Some(t)) => Ok(Some(t as i32)),
    }
}

/// Build the full sorted candidate list for a query. Shared by
/// `run_scroll_query` and `find_offset_in_scroll_query` so both surfaces
/// see the same sorted ordering — diverging here would let the
/// in-result-extension wikilink path target an entry the scroll itself
/// would never page to.
async fn build_sorted(
    filter: &ScrollFilter,
    sort: &ScrollSort,
    state: &State<'_, AppState>,
) -> Result<Vec<ScrollEntry>, InkyCapError> {
    // Filters that need the link index read it first per the lock-ordering
    // invariant in `state::AppState` (link_index < property_index).
    let linked_paths: Option<Vec<PathBuf>> = match filter {
        ScrollFilter::LinkedFrom { source } => {
            let link_index = state.link_index.read().await;
            Some(link_index.get_forward_links(source))
        }
        ScrollFilter::LinkedTo { target } => {
            let link_index = state.link_index.read().await;
            Some(link_index.get_backlinks(target))
        }
        _ => None,
    };

    let index = state.property_index.read().await;

    let candidates: Vec<&NoteMetadata> = match filter {
        ScrollFilter::All => index.notes.values().collect(),
        ScrollFilter::Folder { path, recursive } => {
            collect_folder_notes(&index, path, *recursive)
        }
        ScrollFilter::PropertyEq { name, value } => {
            collect_property_eq(&index, name, value)
        }
        ScrollFilter::PropertyAny { name } => collect_property_any(&index, name),
        ScrollFilter::LinkedFrom { .. } | ScrollFilter::LinkedTo { .. } => linked_paths
            .as_ref()
            .expect("linked_paths populated above")
            .iter()
            .filter_map(|p| index.notes.get(p))
            .collect(),
    };

    let mut keyed: Vec<(String, ScrollEntry)> = candidates
        .into_iter()
        .filter_map(|note| {
            let key = sort_key(note, sort)?;
            Some((
                key,
                ScrollEntry {
                    path: note.path.display().to_string(),
                    title: get_title(note),
                },
            ))
        })
        .collect();

    let direction = sort_direction(sort);
    keyed.sort_by(|a, b| match direction {
        SortDir::Asc => a.0.cmp(&b.0),
        SortDir::Desc => b.0.cmp(&a.0),
    });

    Ok(keyed.into_iter().map(|(_, e)| e).collect())
}

// === Connection flags ===
//
// Encodes how each candidate entry relates to the scroll's anchor. The
// frontend's pill-level "Connections" toggle gates whether the resulting
// CSS classes are styled — flags are always computed cheaply from the
// in-memory `LinkIndex` + property tags. Source of truth for the
// `entry--*` classes in `JournalScrollView`.

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionFlags {
    pub path: String,
    pub is_anchor: bool,
    /// Entry contains a wikilink pointing TO the anchor (entry ∈ anchor.backlinks).
    pub links_to_anchor: bool,
    /// Anchor contains a wikilink pointing TO the entry (entry ∈ anchor.forward).
    pub linked_from_anchor: bool,
    /// Entry's tag set overlaps with the anchor's.
    pub shares_tags: bool,
}

#[tauri::command]
pub async fn compute_connection_flags(
    anchor: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionFlags>, InkyCapError> {
    let anchor_path = sanitize_vault_arg(&anchor)?;

    // Lock order: link_index before property_index (see AppState comment).
    let (outgoing, incoming) = {
        let link_index = state.link_index.read().await;
        let outgoing: HashSet<PathBuf> = link_index
            .get_forward_links(&anchor_path)
            .into_iter()
            .collect();
        let incoming: HashSet<PathBuf> = link_index
            .get_backlinks(&anchor_path)
            .into_iter()
            .collect();
        (outgoing, incoming)
    };

    let prop_index = state.property_index.read().await;
    let anchor_tags: HashSet<&String> = prop_index
        .notes
        .get(&anchor_path)
        .map(|n| n.tags.iter().collect())
        .unwrap_or_default();

    let mut out = Vec::with_capacity(paths.len());
    for p in &paths {
        let path = match sanitize_vault_arg(p) {
            Ok(pp) => pp,
            Err(_) => continue,
        };
        let entry_tags: HashSet<&String> = prop_index
            .notes
            .get(&path)
            .map(|n| n.tags.iter().collect())
            .unwrap_or_default();
        let shares_tags =
            !anchor_tags.is_empty() && anchor_tags.iter().any(|t| entry_tags.contains(*t));
        // The anchor is related to itself on every axis (it shares all its
        // own tags, may link to itself, etc.), but surfacing that as a
        // links/linked/shares decoration is noise — the `is_anchor` flag
        // already says everything. Zero the relational flags for the anchor
        // so it shows only the anchor badge.
        let is_anchor = path == anchor_path;
        out.push(ConnectionFlags {
            path: p.clone(),
            is_anchor,
            links_to_anchor: !is_anchor && incoming.contains(&path),
            linked_from_anchor: !is_anchor && outgoing.contains(&path),
            shares_tags: !is_anchor && shares_tags,
        });
    }
    Ok(out)
}

// === Filter helpers ===

fn collect_folder_notes<'a>(
    index: &'a PropertyIndex,
    folder: &Path,
    recursive: bool,
) -> Vec<&'a NoteMetadata> {
    index
        .notes
        .values()
        .filter(|note| {
            let parent = note.path.parent().unwrap_or(&note.path);
            if recursive {
                note.path.starts_with(folder)
            } else {
                parent == folder
            }
        })
        .collect()
}

fn collect_property_eq<'a>(
    index: &'a PropertyIndex,
    name: &str,
    value: &PropertyValue,
) -> Vec<&'a NoteMetadata> {
    // Tags live on `NoteMetadata.tags`, not in `properties`. The tag map
    // gives O(1) lookup for the common `tags == "<tag>"` query.
    if name == "tags" {
        if let PropertyValue::String(tag) = value {
            return index
                .tags
                .get(tag)
                .map(|ids| ids.iter().filter_map(|id| index.notes.get(id)).collect())
                .unwrap_or_default();
        }
    }
    index
        .notes
        .values()
        .filter(|note| {
            note.properties
                .get(name)
                .map(|prop| property_value_matches(prop, value))
                .unwrap_or(false)
        })
        .collect()
}

fn property_value_matches(prop: &PropertyValue, target: &PropertyValue) -> bool {
    match prop {
        PropertyValue::List(items) => items.iter().any(|item| item == target),
        _ => prop == target,
    }
}

fn collect_property_any<'a>(
    index: &'a PropertyIndex,
    name: &str,
) -> Vec<&'a NoteMetadata> {
    if name == "tags" {
        return index
            .notes
            .values()
            .filter(|note| !note.tags.is_empty())
            .collect();
    }
    index
        .notes
        .values()
        .filter(|note| {
            note.properties
                .get(name)
                .map(|prop| !prop.is_empty())
                .unwrap_or(false)
        })
        .collect()
}

// === Sort helpers ===

fn sort_key(note: &NoteMetadata, sort: &ScrollSort) -> Option<String> {
    match sort {
        ScrollSort::Property { name, .. } => note
            .properties
            .get(name)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty()),
        ScrollSort::Title { .. } => Some(get_title(note).to_lowercase()),
        ScrollSort::Zid => extract_zid(note),
    }
}

fn sort_direction(sort: &ScrollSort) -> SortDir {
    match sort {
        ScrollSort::Property { direction, .. } | ScrollSort::Title { direction, .. } => {
            *direction
        }
        // ZID is monotonic in time; most-recent-first is the only sensible
        // default and there is no UI surface that requests the other order.
        ScrollSort::Zid => SortDir::Desc,
    }
}

fn get_title(note: &NoteMetadata) -> String {
    note.properties
        .get("title")
        .and_then(|v| {
            if let PropertyValue::String(s) = v {
                Some(s.clone())
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            note.path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
}

fn extract_zid(note: &NoteMetadata) -> Option<String> {
    // Explicit ZID property wins over the filename-derived ZID.
    for key in ["ZID", "zid"] {
        match note.properties.get(key) {
            Some(PropertyValue::String(zid)) => {
                if zid.len() >= 14 && zid.chars().all(|c| c.is_ascii_digit()) {
                    return Some(zid.clone());
                }
            }
            Some(PropertyValue::Number(n)) => {
                let s = format!("{:.0}", n);
                if s.len() >= 14 {
                    return Some(s);
                }
            }
            _ => {}
        }
    }
    let stem = note.path.file_stem()?.to_string_lossy();
    let re = regex::Regex::new(r"\d{14}").ok()?;
    re.find(&stem).map(|m| m.as_str().to_string())
}

/// Return the entries at sorted positions `[anchor_idx + offset, anchor_idx + offset + limit)`
/// that actually exist. Out-of-range positions are omitted (not shifted) —
/// this gives the frontend a strict pagination protocol where
/// `result.len() < limit` unambiguously means "this batch hit the edge".
/// Without strict semantics, a `loadMore("before")` request could leak
/// entries from past the anchor and corrupt the visible-window state.
fn slice_around_anchor(
    sorted: &[ScrollEntry],
    anchor: &Path,
    offset: i32,
    limit: usize,
) -> Vec<ScrollEntry> {
    let anchor_str = anchor.display().to_string();
    let anchor_idx = sorted
        .iter()
        .position(|e| e.path == anchor_str)
        .unwrap_or(0) as i64;
    let start = anchor_idx + offset as i64;
    let end = start + limit as i64;
    let len = sorted.len() as i64;
    let clamped_start = start.max(0).min(len) as usize;
    let clamped_end = end.max(0).min(len) as usize;
    if clamped_start >= clamped_end {
        return Vec::new();
    }
    sorted[clamped_start..clamped_end].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::note::PropertyValue;
    use std::collections::HashMap;

    fn note(path: &str, props: &[(&str, PropertyValue)], tags: &[&str]) -> NoteMetadata {
        let mut properties = HashMap::new();
        for (k, v) in props {
            properties.insert((*k).to_string(), v.clone());
        }
        NoteMetadata {
            path: PathBuf::from(path),
            properties,
            links: Vec::new(),
            tags: tags.iter().map(|t| (*t).to_string()).collect(),
        }
    }

    fn build_index(notes: Vec<NoteMetadata>) -> PropertyIndex {
        PropertyIndex::build(notes)
    }

    #[test]
    fn property_eq_on_tags_uses_tag_map() {
        let index = build_index(vec![
            note("/v/a.typ", &[], &["thesis", "draft"]),
            note("/v/b.typ", &[], &["draft"]),
            note("/v/c.typ", &[], &["thesis"]),
        ]);
        let value = PropertyValue::String("thesis".into());
        let mut hits: Vec<String> = collect_property_eq(&index, "tags", &value)
            .iter()
            .map(|n| n.path.display().to_string())
            .collect();
        hits.sort();
        assert_eq!(hits, vec!["/v/a.typ", "/v/c.typ"]);
    }

    #[test]
    fn property_eq_matches_list_membership() {
        let project = PropertyValue::List(vec![
            PropertyValue::String("thesis".into()),
            PropertyValue::String("side-quest".into()),
        ]);
        let index = build_index(vec![
            note(
                "/v/a.typ",
                &[("project", project.clone())],
                &[],
            ),
            note(
                "/v/b.typ",
                &[("project", PropertyValue::String("thesis".into()))],
                &[],
            ),
            note(
                "/v/c.typ",
                &[("project", PropertyValue::String("other".into()))],
                &[],
            ),
        ]);
        let value = PropertyValue::String("thesis".into());
        let mut hits: Vec<String> = collect_property_eq(&index, "project", &value)
            .iter()
            .map(|n| n.path.display().to_string())
            .collect();
        hits.sort();
        assert_eq!(hits, vec!["/v/a.typ", "/v/b.typ"]);
    }

    #[test]
    fn property_any_skips_empty_values() {
        let index = build_index(vec![
            note(
                "/v/a.typ",
                &[("project", PropertyValue::String("thesis".into()))],
                &[],
            ),
            note(
                "/v/b.typ",
                &[("project", PropertyValue::String(String::new()))],
                &[],
            ),
            note("/v/c.typ", &[], &[]),
        ]);
        let mut hits: Vec<String> = collect_property_any(&index, "project")
            .iter()
            .map(|n| n.path.display().to_string())
            .collect();
        hits.sort();
        assert_eq!(hits, vec!["/v/a.typ"]);
    }

    #[test]
    fn folder_filter_respects_recursion() {
        let index = build_index(vec![
            note("/v/notes/a.typ", &[], &[]),
            note("/v/notes/sub/b.typ", &[], &[]),
            note("/v/other/c.typ", &[], &[]),
        ]);
        let folder = PathBuf::from("/v/notes");

        let mut shallow: Vec<String> = collect_folder_notes(&index, &folder, false)
            .iter()
            .map(|n| n.path.display().to_string())
            .collect();
        shallow.sort();
        assert_eq!(shallow, vec!["/v/notes/a.typ"]);

        let mut deep: Vec<String> = collect_folder_notes(&index, &folder, true)
            .iter()
            .map(|n| n.path.display().to_string())
            .collect();
        deep.sort();
        assert_eq!(deep, vec!["/v/notes/a.typ", "/v/notes/sub/b.typ"]);
    }

    #[test]
    fn slice_around_anchor_uses_strict_offset_semantics() {
        let entries: Vec<ScrollEntry> = (0..5)
            .map(|i| ScrollEntry {
                path: format!("/v/{i}.typ"),
                title: format!("{i}"),
            })
            .collect();
        let anchor = PathBuf::from("/v/2.typ");

        // Anchor at idx 2; offset=-1, limit=3 → positions [1, 2, 3].
        let around = slice_around_anchor(&entries, &anchor, -1, 3);
        assert_eq!(
            around.iter().map(|e| e.path.clone()).collect::<Vec<_>>(),
            vec!["/v/1.typ", "/v/2.typ", "/v/3.typ"]
        );

        // Strict-before request: offset=-2, limit=2 → positions [0, 1].
        // This is what `loadMore("before")` will issue; it must not return
        // entries from past the anchor even when the requested window
        // overlaps with idx >= anchor.
        let strict_before = slice_around_anchor(&entries, &anchor, -2, 2);
        assert_eq!(
            strict_before
                .iter()
                .map(|e| e.path.clone())
                .collect::<Vec<_>>(),
            vec!["/v/0.typ", "/v/1.typ"]
        );

        // Partial clip at start: offset=-5, limit=5 → asks for [-3, 1],
        // gets [0, 1] (3 missing entries → result.len() < limit).
        let partial_before = slice_around_anchor(&entries, &anchor, -5, 5);
        assert_eq!(
            partial_before
                .iter()
                .map(|e| e.path.clone())
                .collect::<Vec<_>>(),
            vec!["/v/0.typ", "/v/1.typ"]
        );

        // Fully out of range before anchor → empty.
        let way_before = slice_around_anchor(&entries, &anchor, -10, 3);
        assert!(way_before.is_empty());

        // Past-the-end returns empty.
        let past_end = slice_around_anchor(&entries, &anchor, 10, 3);
        assert!(past_end.is_empty());
    }

    #[test]
    fn zid_extraction_prefers_property_over_filename() {
        let n = note(
            "/v/20260101000000-other.typ",
            &[(
                "ZID",
                PropertyValue::String("20260514000000".into()),
            )],
            &[],
        );
        assert_eq!(extract_zid(&n).as_deref(), Some("20260514000000"));

        let n2 = note("/v/20260101000000-something.typ", &[], &[]);
        assert_eq!(extract_zid(&n2).as_deref(), Some("20260101000000"));

        let n3 = note("/v/no-zid.typ", &[], &[]);
        assert_eq!(extract_zid(&n3), None);
    }
}
