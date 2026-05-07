use std::path::PathBuf;
use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::{NoteMetadata, PropertyValue};
use crate::typst_pipeline::note_rewriter;
use crate::state::AppState;
use crate::storage::traits::VaultStorage;

pub use crate::storage::traits::FileTreeNode;

#[derive(serde::Serialize)]
pub struct LinkInfo {
    pub path: String,
    pub name: String,
}

#[tauri::command]
pub async fn read_file_content(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = std::path::PathBuf::from(&path);
    storage.read_file(&path_buf).await
}

#[tauri::command]
pub async fn get_file_tree(
    state: State<'_, AppState>,
) -> Result<Vec<FileTreeNode>, InkyCapError> {
    let storage = state.get_storage().await?;
    storage.get_file_tree().await
}

#[tauri::command]
pub async fn get_file_metadata(
    path: String,
    state: State<'_, AppState>,
) -> Result<NoteMetadata, InkyCapError> {
    let index = state.property_index.read().await;
    let path_buf = std::path::PathBuf::from(&path);

    index
        .notes
        .get(&path_buf)
        .cloned()
        .ok_or_else(|| InkyCapError::FileNotFound(path))
}

#[tauri::command]
pub async fn get_backlinks(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<LinkInfo>, InkyCapError> {
    let link_index = state.link_index.read().await;
    let path_buf = std::path::PathBuf::from(&path);

    let backlinks = link_index.get_backlinks(&path_buf);
    Ok(backlinks
        .into_iter()
        .map(|p| {
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            LinkInfo {
                path: p.display().to_string(),
                name,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn get_forward_links(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<LinkInfo>, InkyCapError> {
    let link_index = state.link_index.read().await;
    let path_buf = std::path::PathBuf::from(&path);

    let links = link_index.get_forward_links(&path_buf);
    Ok(links
        .into_iter()
        .map(|p| {
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            LinkInfo {
                path: p.display().to_string(),
                name,
            }
        })
        .collect())
}

/// Write file content to disk. Used by the frontend auto-save.
#[tauri::command]
pub async fn write_file_content(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = std::path::PathBuf::from(&path);
    storage.write_file(&path_buf, &content).await?;

    // Re-index the note after saving
    reindex_note(&path_buf, &content, &state).await;

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
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = std::path::PathBuf::from(&path);

    let content = storage.read_file(&path_buf).await?;
    let updated = note_rewriter::update_note_property(&content, &key, &value);
    storage.write_file(&path_buf, &updated).await?;

    // Re-index after property change
    reindex_note(&path_buf, &updated, &state).await;

    Ok(())
}

/// Resolve an embed target (e.g. "image.png") to an absolute file path.
/// Searches all files in the vault by filename (case-insensitive, shortest path).
#[tauri::command]
pub async fn resolve_embed_path(
    target: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, InkyCapError> {
    let storage = state.get_storage().await?;
    let vault_root = state.vault_root.read().await;
    let root = vault_root
        .as_ref()
        .ok_or(InkyCapError::VaultNotOpen)?;

    // Strip any size suffix (e.g. "image.png|400" -> "image.png")
    let clean_target = target.split('|').next().unwrap_or(&target).trim();

    // Search for the file by walking the vault
    // Use list_files with the file extension
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

    Ok(best.map(|p: PathBuf| p.display().to_string()))
}

/// Resolve a wikilink target string to a file path.
/// Returns the full file path if found, None if unresolved.
#[tauri::command]
pub async fn resolve_wikilink(
    target: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, InkyCapError> {
    let link_index = state.link_index.read().await;
    let prop_index = state.property_index.read().await;
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
    Ok(Some(matches[0].display().to_string()))
}

/// Create a new note file. Returns the full path of the created file.
/// If scaffold_content is provided, it is used as the initial content.
/// Otherwise the file starts with the inkycap-vault import line.
#[tauri::command]
pub async fn create_note(
    name: String,
    folder: String,
    scaffold_content: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let vault_root = state.vault_root.read().await;
    let root = vault_root.as_ref().ok_or(InkyCapError::VaultNotOpen)?;

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

    // Don't overwrite existing files
    if file_path.exists() {
        return Err(InkyCapError::InvalidPath(format!(
            "File already exists: {}",
            file_path.display()
        )));
    }

    // storage.write_file creates any missing parent directories through the
    // same validated path pipeline, so no std::fs bypass is needed here.
    let import_line = crate::vault_package::import_line();
    let content = scaffold_content.unwrap_or_else(|| {
        format!("{import_line}\n\n")
    });
    // Ensure the import line is present even when scaffold_content is
    // provided (scaffolds authored by users may not include it).
    let content = if !content.contains(&import_line) {
        format!("{import_line}\n\n{content}")
    } else {
        content
    };
    storage.write_file(&file_path, &content).await?;

    // Index the new note
    reindex_note(&file_path, &content, &state).await;

    Ok(file_path.display().to_string())
}

/// Get a text preview of a note (first N characters, preamble stripped).
#[tauri::command]
pub async fn get_note_preview(
    path: String,
    max_chars: Option<usize>,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;

    let max = max_chars.unwrap_or(200);
    let body = crate::vault_package::strip_note_preamble(&content);
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
) -> Result<Vec<HeadingInfo>, InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    Ok(extract_headings(&content))
}

fn extract_headings(content: &str) -> Vec<HeadingInfo> {
    let re = regex::Regex::new(r"^(=+)\s+(.+?)(?:\s+<([^>]+)>)?\s*$").unwrap();
    content
        .lines()
        .filter_map(|line| {
            let caps = re.captures(line)?;
            let level = caps[1].len().min(6) as u8;
            let text = caps[2].trim().to_string();
            let label = caps.get(3).map(|m| m.as_str().to_string());
            Some(HeadingInfo { level, text, label })
        })
        .collect()
}

/// Ensure a heading in the target note has a `<label>` tag. If the heading
/// exists but lacks a label, one is auto-inserted. Returns the label that
/// was applied (existing or newly generated).
#[tauri::command]
pub async fn ensure_heading_label(
    path: String,
    heading_text: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;

    let headings = extract_headings(&content);
    let heading_lower = heading_text.to_lowercase();

    let matched = headings.iter().find(|h| h.text.to_lowercase() == heading_lower);
    let Some(matched) = matched else {
        return Ok(None);
    };

    if let Some(ref existing) = matched.label {
        return Ok(Some(existing.clone()));
    }

    let label = heading_to_label(&heading_text, &headings);

    let mut new_content = String::with_capacity(content.len() + label.len() + 4);
    let eq_prefix = "=".repeat(matched.level as usize);
    let target_prefix = format!("{eq_prefix} {}", matched.text);

    let mut found = false;
    for line in content.lines() {
        if !found && line.trim_start().starts_with(&target_prefix) {
            new_content.push_str(&line.trim_end().to_string());
            new_content.push_str(&format!(" <{label}>"));
            found = true;
        } else {
            new_content.push_str(line);
        }
        new_content.push('\n');
    }
    if content.ends_with('\n') && new_content.ends_with("\n\n") {
        new_content.pop();
    }
    if !content.ends_with('\n') && new_content.ends_with('\n') {
        new_content.pop();
    }

    if found {
        storage.write_file(&path_buf, &new_content).await?;
        reindex_note(&path_buf, &new_content, &state).await;
        Ok(Some(label))
    } else {
        Ok(None)
    }
}

fn heading_to_label(text: &str, existing_headings: &[HeadingInfo]) -> String {
    let base: String = text
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() { Some(c.to_lowercase().next().unwrap_or(c)) }
            else if c == ' ' || c == '-' || c == '_' { Some('-') }
            else { None }
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

/// Get the context line(s) where `source_path` links to `target_path`.
/// Returns the first line containing a wikilink to the target file.
#[tauri::command]
pub async fn get_backlink_context(
    source_path: String,
    target_path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, InkyCapError> {
    let storage = state.get_storage().await?;
    let source = std::path::PathBuf::from(&source_path);
    let target = std::path::PathBuf::from(&target_path);

    let content = storage.read_file(&source).await?;

    // Extract the target filename (without extension) for matching wikilinks
    let target_name = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // Search for wikilinks referencing the target
    for line in content.lines() {
        let lower = line.to_lowercase();
        // Check for [[target_name]] or [[target_name|...]] or [[target_name#...]]
        if lower.contains(&format!("[[{}", target_name)) {
            let trimmed = line.trim();
            // Return a snippet: first 150 chars of the line
            let snippet = if trimmed.len() > 150 {
                format!("{}...", &trimmed[..150])
            } else {
                trimmed.to_string()
            };
            return Ok(Some(snippet));
        }
    }

    Ok(None)
}

/// Thin wrapper kept for the benefit of other command modules that
/// historically called this symbol. New call sites should prefer
/// `state.reindex_note(...)` directly — this helper exists only to avoid a
/// sprawling rename.
pub async fn reindex_note_public(
    path: &std::path::Path,
    content: &str,
    state: &State<'_, AppState>,
) {
    state.reindex_note(path, content).await;
}

/// Local alias for the unified indexing helper on [`AppState`], retained so
/// this module's existing call sites read naturally.
async fn reindex_note(
    path: &std::path::Path,
    content: &str,
    state: &State<'_, AppState>,
) {
    state.reindex_note(path, content).await;
}
