use std::path::PathBuf;
use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::{NoteMetadata, PropertyValue};
use crate::typst_pipeline::note_rewriter;
use crate::state::AppState;
use crate::storage::sanitize_vault_arg;
use crate::storage::traits::VaultStorage;

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

/// Read the UTF-8 content of a file in the vault. Requires an open vault.
#[tauri::command]
pub async fn read_file_content(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = sanitize_vault_arg(&path)?;
    storage.read_file(&path_buf).await
}

/// Return the vault's directory tree as a flat list of nodes. Requires an open vault.
#[tauri::command]
pub async fn get_file_tree(
    state: State<'_, AppState>,
) -> Result<Vec<FileTreeNode>, InkyCapError> {
    let storage = state.get_storage().await?;
    storage.get_file_tree().await
}

/// Return parsed `#note(...)` metadata for a file, falling back to on-demand reindex if not yet cached.
#[tauri::command]
pub async fn get_file_metadata(
    path: String,
    state: State<'_, AppState>,
) -> Result<NoteMetadata, InkyCapError> {
    let path_buf = sanitize_vault_arg(&path)?;

    {
        let index = state.property_index.read().await;
        if let Some(meta) = index.notes.get(&path_buf).cloned() {
            return Ok(meta);
        }
    }

    // Fallback: file isn't in the index yet (initial vault scan may have
    // missed it, or it was created out-of-band). Read it and reindex on
    // demand so the panel doesn't stay permanently blank until the user
    // edits the file.
    let storage = state.get_storage().await?;
    let content = storage.read_file(&path_buf).await?;
    state.reindex_note(&path_buf, &content).await;

    let index = state.property_index.read().await;
    index
        .notes
        .get(&path_buf)
        .cloned()
        .ok_or_else(|| InkyCapError::FileNotFound(path))
}

/// Return all notes that link to the given file path via wikilinks.
#[tauri::command]
pub async fn get_backlinks(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<LinkInfo>, InkyCapError> {
    let link_index = state.link_index.read().await;
    let path_buf = sanitize_vault_arg(&path)?;

    let backlinks = link_index.get_backlinks(&path_buf);
    Ok(backlinks
        .into_iter()
        .map(|p| {
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let (mtime, ctime) = file_times(&p);
            LinkInfo {
                path: p.display().to_string(),
                name,
                modified_time: mtime,
                created_time: ctime,
            }
        })
        .collect())
}

/// Return all notes that the given file links to via wikilinks.
#[tauri::command]
pub async fn get_forward_links(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<LinkInfo>, InkyCapError> {
    let link_index = state.link_index.read().await;
    let path_buf = sanitize_vault_arg(&path)?;

    let links = link_index.get_forward_links(&path_buf);
    Ok(links
        .into_iter()
        .map(|p| {
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let (mtime, ctime) = file_times(&p);
            LinkInfo {
                path: p.display().to_string(),
                name,
                modified_time: mtime,
                created_time: ctime,
            }
        })
        .collect())
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
}

/// Return every wikilink target from the note's `#note(...)` metadata,
/// resolved to a file when possible. Replaces the previous frontend
/// loop of `getFileMetadata` → `resolveWikilink` per target so the
/// Links pane can sort by mtime/ctime without N extra round-trips.
#[tauri::command]
pub async fn get_outbound_links(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<OutboundLink>, InkyCapError> {
    let path_buf = sanitize_vault_arg(&path)?;

    // Read raw wikilink targets from the note's metadata, falling back to
    // an on-demand reindex if the property index hasn't seen this file
    // yet (matches `get_file_metadata`'s behaviour).
    let raw_targets: Vec<String> = {
        let prop_index = state.property_index.read().await;
        if let Some(meta) = prop_index.notes.get(&path_buf) {
            meta.links.clone()
        } else {
            drop(prop_index);
            let storage = state.get_storage().await?;
            let content = storage.read_file(&path_buf).await?;
            state.reindex_note(&path_buf, &content).await;
            let prop_index = state.property_index.read().await;
            prop_index
                .notes
                .get(&path_buf)
                .map(|m| m.links.clone())
                .unwrap_or_default()
        }
    };

    // Snapshot all known note paths once to feed the stem resolver in a
    // single allocation rather than re-snapping per-target.
    let all_paths: Vec<PathBuf> = {
        let prop_index = state.property_index.read().await;
        prop_index.notes.keys().cloned().collect()
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
        out.push(OutboundLink {
            target: raw,
            path: resolved_path.display().to_string(),
            name,
            resolved: true,
            modified_time: mtime,
            created_time: ctime,
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
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = sanitize_vault_arg(&path)?;
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
    let path_buf = sanitize_vault_arg(&path)?;

    let content = storage.read_file(&path_buf).await?;
    // Ensure the inkycap-vault import is present before the rewriter
    // synthesizes a `#note(...)` call. Without this, a note that has no
    // import yet gets a `#note(...)` call referencing an unbound symbol —
    // `typst query` fails on reindex, and the new property never reaches
    // the property index, leaving the panel blank after first add.
    let content = crate::vault_package::ensure_import(&content);
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

    // If the target contains a path separator, treat it as a vault-root-
    // relative path (with or without a leading slash, matching Typst's own
    // `#image("/assets/foo.png")` semantics). Resolve directly and skip
    // the filename search. Defends against `..` traversal via
    // validate_vault_path.
    if clean_target.contains('/') || clean_target.contains('\\') {
        let stripped = clean_target.trim_start_matches('/').trim_start_matches('\\');
        let candidate = root.join(stripped);
        if let Ok(resolved) = crate::storage::path::validate_vault_path(root, &candidate) {
            if resolved.is_file() {
                return Ok(Some(resolved.display().to_string()));
            }
        }
        return Ok(None);
    }

    // Bare filename — search the whole vault by name.
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
    let path_buf = sanitize_vault_arg(&path)?;
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
    let path_buf = sanitize_vault_arg(&path)?;
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
    let path_buf = sanitize_vault_arg(&path)?;
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
) -> Result<Vec<AliasEntry>, InkyCapError> {
    let index = state.property_index.read().await;
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
                note_path: id.display().to_string(),
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
) -> Result<Option<BacklinkContext>, InkyCapError> {
    const CONTEXT_LINES: usize = 2;
    const MAX_SNIPPET_CHARS: usize = 200;

    let storage = state.get_storage().await?;
    let source = sanitize_vault_arg(&source_path)?;
    let target = sanitize_vault_arg(&target_path)?;

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
}

/// Find notes that mention the current note's filename stem as a phrase but
/// don't yet wikilink to it. Useful for surfacing missed link opportunities.
///
/// Strategy: phrase-search the vault for the stem via the existing inverted
/// index, then filter out (a) the current note itself, (b) any note already
/// known to link to it (resolved or unresolved targets that match by stem),
/// and (c) results whose only "match" is the wikilink call we'd otherwise
/// suggest creating. Result count is capped to keep the panel snappy on
/// large vaults.
#[tauri::command]
pub async fn get_potential_links(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<PotentialLink>, InkyCapError> {
    let path_buf = sanitize_vault_arg(&path)?;

    let stem = path_buf
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if stem.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Resolved backlinks: pre-existing inbound edges we should skip.
    let already_linking: std::collections::HashSet<PathBuf> = {
        let link_index = state.link_index.read().await;
        link_index
            .get_backlinks(&path_buf)
            .into_iter()
            .collect()
    };

    // Use the existing search engine so we benefit from the inverted index
    // rather than scanning every file's content on each call.
    let query = format!("\"{}\"", stem);
    let parsed = match crate::search::query::parse_query(&query) {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let results = {
        let engine = state.search_engine.read().await;
        engine.search(&parsed, 300)
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
            path: p.display().to_string(),
            name,
            line,
            context_before,
            context_after,
            // SearchResult uses i64 (Tantivy/Hayagriva legacy); clamp to
            // u64 to match the surrounding LinkInfo / FileTreeNode shape.
            // Negative timestamps would only appear for pre-1970 ctime
            // values, which we never see for vault files.
            modified_time: r.modified_time.max(0) as u64,
            created_time: r.created_time.max(0) as u64,
        });
    }
    Ok(out)
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
