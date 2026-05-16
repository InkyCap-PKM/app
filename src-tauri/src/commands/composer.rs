use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;

/// Merge multiple notes into a single target file.
/// Content is concatenated in order with a separator between each.
/// Returns the path of the merged file.
#[tauri::command]
pub async fn merge_notes(
    paths: Vec<String>,
    target_path: String,
    delete_sources: bool,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    if paths.len() < 2 {
        return Err(InkyCapError::InvalidPath(
            "At least two notes are required to merge".to_string(),
        ));
    }

    let storage = state.get_storage().await?;

    let mut merged_content = String::new();
    let mut source_names = Vec::new();

    for (i, path_str) in paths.iter().enumerate() {
        let path = sanitize_notebox_arg(path_str)?;
        let content = storage.read_file(&path).await?;

        let body = if i > 0 {
            crate::notebox_package::strip_note_preamble(&content).to_string()
        } else {
            content.as_str().to_string()
        };

        if i > 0 && !merged_content.is_empty() {
            merged_content.push_str("\n\n---\n\n");
        }
        merged_content.push_str(&body);

        source_names.push(
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
        );
    }

    let target = sanitize_notebox_arg(&target_path)?;

    // storage.write_file validates the path against the notebox root and
    // creates any missing parent directories through the same validated
    // pipeline, so no std::fs bypass is needed here.
    storage.write_file(&target, &merged_content).await?;

    // Optionally delete source files (move to trash)
    if delete_sources {
        for path_str in &paths {
            let path = sanitize_notebox_arg(path_str)?;
            if path != target {
                let _ = trash::delete(&path);
            }
        }
    }

    // Re-index the merged file
    super::files::reindex_note_public(&target, &merged_content, &state).await;

    Ok(target_path)
}

/// Split a note at a heading, extracting that section into a new note.
/// Inserts a wikilink to the new note in place of the extracted section.
/// Returns the path of the newly created note.
#[tauri::command]
pub async fn split_note(
    path: String,
    heading: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let source_path = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&source_path).await?;

    let lines: Vec<&str> = content.lines().collect();

    // Find the heading line
    let heading_pattern = heading.trim();
    let mut start_idx = None;
    let mut heading_level = 0;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            let text = trimmed[hashes..].trim();
            if text == heading_pattern {
                start_idx = Some(i);
                heading_level = hashes;
                break;
            }
        }
    }

    let start = start_idx.ok_or_else(|| {
        InkyCapError::InvalidPath(format!("Heading '{}' not found in {}", heading, path))
    })?;

    // Find the end of this section (next heading at same or higher level)
    let mut end_idx = lines.len();
    for i in (start + 1)..lines.len() {
        let trimmed = lines[i].trim_start();
        if trimmed.starts_with('#') {
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            if hashes <= heading_level {
                end_idx = i;
                break;
            }
        }
    }

    // Extract the section
    let extracted_lines: Vec<&str> = lines[start..end_idx].to_vec();
    let extracted_content = format!(
        "---\n---\n\n{}",
        extracted_lines.join("\n").trim()
    );

    // Create a sanitized filename from the heading
    let new_name = sanitize_filename(&heading);
    let new_filename = format!("{}.md", new_name);

    // Put the new file in the same directory as the source
    let new_path = source_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new(""))
        .join(&new_filename);

    if new_path.exists() {
        return Err(InkyCapError::InvalidPath(format!(
            "File already exists: {}",
            new_path.display()
        )));
    }

    // Write the extracted content to the new file
    storage.write_file(&new_path, &extracted_content).await?;

    // Replace the extracted section in the original with a wikilink
    let wikilink = format!("![[{}]]", new_name);
    let mut result_lines: Vec<String> = Vec::new();
    for &line in &lines[..start] {
        result_lines.push(line.to_string());
    }
    result_lines.push(wikilink);
    for &line in &lines[end_idx..] {
        result_lines.push(line.to_string());
    }
    let remaining_content = result_lines.join("\n");

    storage.write_file(&source_path, &remaining_content).await?;

    // Re-index both files
    super::files::reindex_note_public(&source_path, &remaining_content, &state).await;
    super::files::reindex_note_public(&new_path, &extracted_content, &state).await;

    Ok(new_path.display().to_string())
}

/// Sanitize a string for use as a filename.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}
