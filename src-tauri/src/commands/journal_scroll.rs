use std::path::PathBuf;
use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::PropertyValue;
use crate::state::AppState;
use crate::storage::sanitize_vault_arg;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct JournalScrollConfig {
    pub date_sort: Option<String>,
    pub tree_scope: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct JournalScrollEntry {
    pub path: String,
    pub title: String,
}

/// Return an ordered list of files for journal scroll mode.
///
/// `anchor_path` is the file the user currently has open. `mode` is one of
/// "date", "tree", or "tag". `offset` is relative to the anchor file's
/// position in the sorted sequence (negative = before, positive = after).
/// `limit` caps how many entries are returned.
#[tauri::command]
pub async fn get_journal_scroll_files(
    anchor_path: String,
    mode: String,
    config: JournalScrollConfig,
    offset: i32,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<JournalScrollEntry>, InkyCapError> {
    let index = state.property_index.read().await;
    let anchor = sanitize_vault_arg(&anchor_path)?;

    match mode.as_str() {
        "date" => build_date_sequence(&index, &anchor, &config, offset, limit),
        "tree" => build_tree_sequence(&index, &anchor, &config, offset, limit),
        "tag" => build_tag_sequence(&index, &anchor, offset, limit),
        _ => Err(InkyCapError::InvalidPath(format!(
            "Unknown journal scroll mode: {}",
            mode
        ))),
    }
}

fn get_title(note: &crate::models::note::NoteMetadata) -> String {
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

fn extract_zid(note: &crate::models::note::NoteMetadata) -> Option<String> {
    // Check ZID property first
    if let Some(PropertyValue::String(zid)) = note.properties.get("ZID") {
        if zid.len() >= 14 && zid.chars().all(|c| c.is_ascii_digit()) {
            return Some(zid.clone());
        }
    }
    if let Some(PropertyValue::String(zid)) = note.properties.get("zid") {
        if zid.len() >= 14 && zid.chars().all(|c| c.is_ascii_digit()) {
            return Some(zid.clone());
        }
    }
    // Check ZID as number (YAML may parse it as a number)
    if let Some(PropertyValue::Number(n)) = note.properties.get("ZID") {
        let s = format!("{:.0}", n);
        if s.len() >= 14 {
            return Some(s);
        }
    }
    if let Some(PropertyValue::Number(n)) = note.properties.get("zid") {
        let s = format!("{:.0}", n);
        if s.len() >= 14 {
            return Some(s);
        }
    }
    // Fall back to filename
    let stem = note.path.file_stem()?.to_string_lossy();
    let re = regex::Regex::new(r"\d{14}").ok()?;
    re.find(&stem).map(|m| m.as_str().to_string())
}

fn slice_around_anchor(
    sorted: &[JournalScrollEntry],
    anchor: &PathBuf,
    offset: i32,
    limit: usize,
) -> Vec<JournalScrollEntry> {
    let anchor_str = anchor.display().to_string();
    let anchor_idx = sorted
        .iter()
        .position(|e| e.path == anchor_str)
        .unwrap_or(0);

    let start_idx = (anchor_idx as i64 + offset as i64).max(0) as usize;
    let end_idx = (start_idx + limit).min(sorted.len());

    sorted[start_idx..end_idx].to_vec()
}

fn build_date_sequence(
    index: &crate::scanner::property_index::PropertyIndex,
    anchor: &PathBuf,
    config: &JournalScrollConfig,
    offset: i32,
    limit: usize,
) -> Result<Vec<JournalScrollEntry>, InkyCapError> {
    let date_sort = config
        .date_sort
        .as_deref()
        .unwrap_or("created");

    let mut entries: Vec<(String, JournalScrollEntry)> = index
        .notes
        .values()
        .filter_map(|note| {
            let sort_key = match date_sort {
                "modified" => note
                    .properties
                    .get("file.mtime")
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_default(),
                "zid" => extract_zid(note).unwrap_or_default(),
                _ => note
                    .properties
                    .get("file.ctime")
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_default(),
            };
            if sort_key.is_empty() {
                return None;
            }
            Some((
                sort_key,
                JournalScrollEntry {
                    path: note.path.display().to_string(),
                    title: get_title(note),
                },
            ))
        })
        .collect();

    // Reverse chronological (newest first)
    entries.sort_by(|a, b| b.0.cmp(&a.0));

    let sorted: Vec<JournalScrollEntry> = entries.into_iter().map(|(_, e)| e).collect();
    Ok(slice_around_anchor(&sorted, anchor, offset, limit))
}

fn build_tree_sequence(
    index: &crate::scanner::property_index::PropertyIndex,
    anchor: &PathBuf,
    config: &JournalScrollConfig,
    offset: i32,
    limit: usize,
) -> Result<Vec<JournalScrollEntry>, InkyCapError> {
    let tree_scope = config.tree_scope.as_deref().unwrap_or("folder");
    let anchor_folder = anchor.parent().unwrap_or(anchor);

    let mut entries: Vec<JournalScrollEntry> = index
        .notes
        .values()
        .filter(|note| {
            let note_folder = note.path.parent().unwrap_or(&note.path);
            match tree_scope {
                "recursive" => note.path.starts_with(anchor_folder),
                _ => note_folder == anchor_folder,
            }
        })
        .map(|note| JournalScrollEntry {
            path: note.path.display().to_string(),
            title: get_title(note),
        })
        .collect();

    // Alphabetical by title (case-insensitive)
    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));

    Ok(slice_around_anchor(&entries, anchor, offset, limit))
}

fn build_tag_sequence(
    index: &crate::scanner::property_index::PropertyIndex,
    anchor: &PathBuf,
    offset: i32,
    limit: usize,
) -> Result<Vec<JournalScrollEntry>, InkyCapError> {
    let anchor_note = index
        .notes
        .get(anchor)
        .ok_or_else(|| InkyCapError::FileNotFound(anchor.display().to_string()))?;

    let anchor_tags: std::collections::HashSet<&String> =
        anchor_note.tags.iter().collect();

    if anchor_tags.is_empty() {
        return Ok(vec![JournalScrollEntry {
            path: anchor.display().to_string(),
            title: get_title(anchor_note),
        }]);
    }

    let mut entries: Vec<JournalScrollEntry> = index
        .notes
        .values()
        .filter(|note| note.tags.iter().any(|t| anchor_tags.contains(t)))
        .map(|note| JournalScrollEntry {
            path: note.path.display().to_string(),
            title: get_title(note),
        })
        .collect();

    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));

    Ok(slice_around_anchor(&entries, anchor, offset, limit))
}
