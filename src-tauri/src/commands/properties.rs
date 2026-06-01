// Tauri commands for bulk operations on note properties and tags
// plus the global property type registry.
//
// These commands mutate every note (and optionally .collection file) in the
// notebox that references the targeted key or tag. They go through the
// same per-note `reindex_note` path as individual edits so the in-memory
// indexes and the persistent metadata cache stay coherent.

use std::collections::HashMap;
use std::path::PathBuf;

use regex::Regex;
use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::PropertyValue;
use crate::property_types::{coerce_value, is_system_property, PropertyType};
use crate::state::{AppState, NoteboxSession};
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter;

// ── Property type registry ────────────────────────────────────────────

/// Return the notebox's property type registry (key to declared type mapping). Requires an open notebox.
#[tauri::command]
pub async fn get_property_types(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<HashMap<String, PropertyType>, InkyCapError> {
    let session = state.session(window.label()).await;
    let reg = session.property_types.read().await;
    Ok(reg.all())
}

/// Return the set of built-in system property keys whose types are fixed and
/// cannot be reassigned by the user. The markdown-import mapping dialog uses
/// this to lock the type column for these targets.
#[tauri::command]
pub async fn get_system_property_keys() -> Result<Vec<String>, InkyCapError> {
    Ok(crate::property_types::SYSTEM_PROPERTY_KEYS
        .iter()
        .map(|k| k.to_string())
        .collect())
}

/// Set the declared type for a property key and rewrite that key in
/// every note that has it, coercing each value to the new type. When
/// `ty` is `Auto` the registry entry is stored but no files are
/// rewritten — Auto means "leave values alone and let the editor
/// guess from the actual YAML type".
#[tauri::command]
pub async fn set_property_type(
    key: String,
    ty: PropertyType,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    // System properties have fixed types — the UI shouldn't let users
    // change them, but enforce it at the boundary too.
    if is_system_property(&key) {
        return Err(InkyCapError::BadRequest(format!(
            "Cannot change type of system property '{}'",
            key
        )));
    }
    {
        let mut reg = session.property_types.write().await;
        reg.set(key.clone(), ty);
        reg.save();
    }

    if matches!(ty, PropertyType::Auto) {
        return Ok(());
    }

    let targets: Vec<(PathBuf, PropertyValue)> = {
        let index = session.property_index.read().await;
        index
            .notes
            .values()
            .filter_map(|n| n.properties.get(&key).map(|v| (n.path.clone(), v.clone())))
            .collect()
    };

    let storage = session.get_storage().await?;
    for (path, value) in targets {
        let coerced = coerce_value(&value, ty);
        let content = storage.read_file(&path).await?;
        let updated = note_rewriter::update_note_property(&content, &key, &coerced);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            session.reindex_note(&path, &updated).await;
        }
    }
    Ok(())
}

// ── Property key rename / delete ──────────────────────────────────────

/// Rename a property key across every note that has it.
/// Also rewrites textual references in `.collection` collection files and
/// moves the type registry entry so the new key inherits the old key's
/// declared type.
#[tauri::command]
pub async fn rename_property_key(
    old_key: String,
    new_key: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let old_key = old_key.trim().to_string();
    let new_key = new_key.trim().to_string();
    if old_key.is_empty() || new_key.is_empty() || old_key == new_key {
        return Ok(());
    }

    {
        let mut reg = session.property_types.write().await;
        reg.rename(&old_key, &new_key);
        reg.save();
    }

    // Notes — rewrite #note(...) properties.
    let targets: Vec<(PathBuf, PropertyValue)> = {
        let index = session.property_index.read().await;
        index
            .notes
            .values()
            .filter_map(|n| {
                n.properties
                    .get(&old_key)
                    .map(|v| (n.path.clone(), v.clone()))
            })
            .collect()
    };

    let storage = session.get_storage().await?;
    for (path, value) in targets {
        let content = storage.read_file(&path).await?;
        let without_old = note_rewriter::remove_note_property(&content, &old_key);
        let updated = note_rewriter::update_note_property(&without_old, &new_key, &value);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            session.reindex_note(&path, &updated).await;
        }
    }

    // Explicitly purge the old key from the global property_keys set
    {
        let mut index = session.property_index.write().await;
        index.property_keys.remove(&old_key);
    }

    // .collection files — textual replacement of whole-word key references.
    rewrite_collection_files(&session, |text| replace_word(text, &old_key, &new_key)).await?;

    Ok(())
}

/// Delete a property key from every note and strip any
/// `.collection` references. The type registry entry for the key is removed.
#[tauri::command]
pub async fn delete_property_key(
    key: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Ok(());
    }

    {
        let mut reg = session.property_types.write().await;
        reg.clear(&key);
        reg.save();
    }

    let targets: Vec<PathBuf> = {
        let index = session.property_index.read().await;
        index
            .notes
            .values()
            .filter(|n| n.properties.contains_key(&key))
            .map(|n| n.path.clone())
            .collect()
    };

    let storage = session.get_storage().await?;
    for path in targets {
        let content = storage.read_file(&path).await?;
        let updated = note_rewriter::remove_note_property(&content, &key);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            session.reindex_note(&path, &updated).await;
        }
    }

    rewrite_collection_files(&session, |text| strip_word_line(text, &key)).await?;

    Ok(())
}

/// Remove a single property from one file only. Used by the per-row
/// "Remove" action in the right-panel properties view.
#[tauri::command]
pub async fn remove_property_from_file(
    path: String,
    key: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path_buf).await?;
    let updated = note_rewriter::remove_note_property(&content, &key);
    if updated != content {
        storage.write_file(&path_buf, &updated).await?;
        session.reindex_note(&path_buf, &updated).await;
    }
    Ok(())
}

/// Return the ordered list of property keys exactly as they appear in
/// the file's `#note(...)` call. Used by the right panel to render rows
/// in source order rather than fighting the user's drag-and-drop layout.
#[tauri::command]
pub async fn get_property_order(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path_buf).await?;
    Ok(note_rewriter::extract_note_properties(&content)
        .into_iter()
        .map(|(k, _)| k)
        .collect())
}

/// Reorder properties inside the `#note(...)` call of a single file to
/// match `order`. Keys present in the file but missing from `order` are
/// appended in their original position; keys in `order` not present in
/// the file are silently skipped.
#[tauri::command]
pub async fn reorder_properties(
    path: String,
    order: Vec<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path_buf).await?;
    let updated = note_rewriter::reorder_note_properties(&content, &order);
    if updated != content {
        storage.write_file(&path_buf, &updated).await?;
        session.reindex_note(&path_buf, &updated).await;
    }
    Ok(())
}

/// Return the distinct values currently used for `key` across the notebox,
/// sorted alphabetically. List values are exploded — each member becomes a
/// separate entry — so the picker for `tags`, `status`, etc. can show the
/// universe of choices the user has previously committed to.
///
/// Non-string scalars (numbers, booleans) are stringified. `link-ref`-shaped
/// strings keep their `[[Target]]` form.
#[tauri::command]
pub async fn get_property_values(
    key: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = std::collections::BTreeSet::new();
    let index = session.property_index.read().await;
    for note in index.notes.values() {
        let Some(value) = note.properties.get(&key) else {
            continue;
        };
        push_property_strings(value, &mut seen);
    }
    Ok(seen.into_iter().collect())
}

fn push_property_strings(value: &PropertyValue, out: &mut std::collections::BTreeSet<String>) {
    match value {
        PropertyValue::String(s) if !s.is_empty() => {
            out.insert(s.clone());
        }
        PropertyValue::Number(n) => {
            out.insert(if *n == (*n as i64) as f64 {
                (*n as i64).to_string()
            } else {
                n.to_string()
            });
        }
        PropertyValue::Bool(b) => {
            out.insert(b.to_string());
        }
        PropertyValue::List(items) => {
            for item in items {
                push_property_strings(item, out);
            }
        }
        _ => {}
    }
}

// ── Tag rename / delete ───────────────────────────────────────────────

/// Rename a tag across all notes and collection files in the notebox. Requires an open notebox.
#[tauri::command]
pub async fn rename_tag(
    old_tag: String,
    new_tag: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let old_tag = sanitize_tag(&old_tag);
    let new_tag = sanitize_tag(&new_tag);
    if old_tag.is_empty() || new_tag.is_empty() || old_tag == new_tag {
        return Ok(());
    }

    let targets: Vec<PathBuf> = {
        let index = session.property_index.read().await;
        index.tags.get(&old_tag).cloned().unwrap_or_default()
    };

    let storage = session.get_storage().await?;
    for path in targets {
        let content = storage.read_file(&path).await?;
        let updated = rewrite_tag_in_content(&content, &old_tag, Some(&new_tag));
        if updated != content {
            storage.write_file(&path, &updated).await?;
            session.reindex_note(&path, &updated).await;
        }
    }

    // .collection files: best-effort literal replacement of the tag name
    // inside quoted strings. Filter expressions like
    // `file.tags.contains("rust")` will be updated; bare references
    // won't, because they'd be indistinguishable from property keys.
    rewrite_collection_files(&session, |text| replace_quoted(text, &old_tag, &new_tag)).await?;

    Ok(())
}

/// Remove a tag from every note in the notebox that carries it. Requires an open notebox.
#[tauri::command]
pub async fn delete_tag(
    tag: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let tag = sanitize_tag(&tag);
    if tag.is_empty() {
        return Ok(());
    }

    let targets: Vec<PathBuf> = {
        let index = session.property_index.read().await;
        index.tags.get(&tag).cloned().unwrap_or_default()
    };

    let storage = session.get_storage().await?;
    for path in targets {
        let content = storage.read_file(&path).await?;
        let updated = rewrite_tag_in_content(&content, &tag, None);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            session.reindex_note(&path, &updated).await;
        }
    }

    // .collection: strip quoted literal references. Same caveats as rename.
    rewrite_collection_files(&session, |text| replace_quoted(text, &tag, "")).await?;

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────

fn sanitize_tag(s: &str) -> String {
    s.trim().trim_start_matches('#').to_string()
}

/// Rewrite inline `#tag` references in a note's content.
/// Pass `new_tag = None` to delete.
fn rewrite_tag_in_content(content: &str, old: &str, new_tag: Option<&str>) -> String {
    rewrite_inline_tag(content, old, new_tag)
}

/// Rewrite inline `#tag` references in the note body. Matches a tag
/// bounded by whitespace/start-of-line and a non-tag-continuation
/// character on the right, so `#old` is rewritten but `#older` is not.
fn rewrite_inline_tag(body: &str, old: &str, new_tag: Option<&str>) -> String {
    let pattern = format!(r"(^|[\s\(\[,])#{}(?P<end>[^\w/-]|$)", regex::escape(old));
    let re = Regex::new(&pattern).unwrap();
    re.replace_all(body, |caps: &regex::Captures| {
        let lead = &caps[1];
        let end = &caps["end"];
        match new_tag {
            Some(new) => format!("{}#{}{}", lead, new, end),
            None => format!("{}{}", lead, end),
        }
    })
    .into_owned()
}

/// Replace whole-word occurrences of `needle` with `replacement`.
/// Word boundaries are ASCII-only which matches how property keys are
/// typically spelled in both notes and .collection files.
fn replace_word(text: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let pattern = format!(r"\b{}\b", regex::escape(needle));
    let re = Regex::new(&pattern).unwrap();
    re.replace_all(text, replacement).into_owned()
}

/// Delete any line containing `needle` as a whole word. Used to strip
/// references to a deleted property key from .collection files.
fn strip_word_line(text: &str, needle: &str) -> String {
    let re = Regex::new(&format!(r"\b{}\b", regex::escape(needle))).unwrap();
    text.lines()
        .filter(|line| !re.is_match(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replace literal occurrences of `needle` *inside* single- or
/// double-quoted strings. Used for tag rename inside .collection filter
/// expressions like `file.tags.contains("rust")`.
fn replace_quoted(text: &str, needle: &str, replacement: &str) -> String {
    let escaped = regex::escape(needle);
    let patterns = [format!("\"{}\"", escaped), format!("'{}'", escaped)];
    let mut out = text.to_string();
    for pat in &patterns {
        let re = Regex::new(pat).unwrap();
        if replacement.is_empty() {
            out = re.replace_all(&out, "").into_owned();
        } else {
            let replacement_quoted = if pat.starts_with('"') {
                format!("\"{}\"", replacement)
            } else {
                format!("'{}'", replacement)
            };
            out = re
                .replace_all(&out, replacement_quoted.as_str())
                .into_owned();
        }
    }
    out
}

/// Apply a text transform to every `.collection` file in the notebox.
async fn rewrite_collection_files<F>(
    session: &NoteboxSession,
    transform: F,
) -> Result<(), InkyCapError>
where
    F: Fn(&str) -> String,
{
    let storage = session.get_storage().await?;
    let collection_paths: Vec<PathBuf> = session.collection_files.read().await.clone();
    for path in collection_paths {
        let content = match storage.read_file(&path).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        let updated = transform(&content);
        if updated != content {
            let _ = storage.write_file(&path, &updated).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_inline_tag_renames_exact_match() {
        let body = "Here is #foo and #foobar.";
        let out = rewrite_inline_tag(body, "foo", Some("bar"));
        assert!(out.contains("#bar"));
        assert!(out.contains("#foobar"));
    }

    #[test]
    fn rewrite_inline_tag_deletes() {
        let body = "Here is #foo end.";
        let out = rewrite_inline_tag(body, "foo", None);
        assert!(!out.contains("#foo"));
        assert!(out.contains("Here is"));
    }

    #[test]
    fn rewrite_tag_in_typst_content() {
        let content = "#import \"/.inkycap/notebox.typ\": *\n#note(\n  tags: (\"foo\", \"bar\"),\n)\n\nSome content with #foo inline.\n";
        let out = rewrite_tag_in_content(content, "foo", Some("baz"));
        assert!(out.contains("#baz inline"));
        assert!(!out.contains("#foo inline"));
    }

    #[test]
    fn rewrite_tag_deletes_in_content() {
        let content = "Some text #foo end.\n";
        let out = rewrite_tag_in_content(content, "foo", None);
        assert!(!out.contains("#foo"));
        assert!(out.contains("Some text"));
    }
}
