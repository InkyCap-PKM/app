// Tauri commands for bulk operations on note properties and tags
// plus the global property type registry.
//
// These commands mutate every note (and optionally .collection file) in the
// vault that references the targeted key or tag. They go through the
// same per-note `reindex_note` path as individual edits so the in-memory
// indexes and the persistent metadata cache stay coherent.

use std::collections::HashMap;
use std::path::PathBuf;

use regex::Regex;
use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::PropertyValue;
use crate::property_types::{coerce_value, PropertyType};
use crate::typst_pipeline::note_rewriter;
use crate::state::AppState;
use crate::storage::traits::VaultStorage;

// ── Property type registry ────────────────────────────────────────────

#[tauri::command]
pub async fn get_property_types(
    state: State<'_, AppState>,
) -> Result<HashMap<String, PropertyType>, InkyCapError> {
    let reg = state.property_types.read().await;
    Ok(reg.all())
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
) -> Result<(), InkyCapError> {
    {
        let mut reg = state.property_types.write().await;
        reg.set(key.clone(), ty);
        reg.save();
    }

    if matches!(ty, PropertyType::Auto) {
        return Ok(());
    }

    let targets: Vec<(PathBuf, PropertyValue)> = {
        let index = state.property_index.read().await;
        index
            .notes
            .values()
            .filter_map(|n| n.properties.get(&key).map(|v| (n.path.clone(), v.clone())))
            .collect()
    };

    let storage = state.get_storage().await?;
    for (path, value) in targets {
        let coerced = coerce_value(&value, ty);
        let content = storage.read_file(&path).await?;
        let updated = note_rewriter::update_note_property(&content, &key, &coerced);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            state.reindex_note(&path, &updated).await;
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
) -> Result<(), InkyCapError> {
    let old_key = old_key.trim().to_string();
    let new_key = new_key.trim().to_string();
    if old_key.is_empty() || new_key.is_empty() || old_key == new_key {
        return Ok(());
    }

    {
        let mut reg = state.property_types.write().await;
        reg.rename(&old_key, &new_key);
        reg.save();
    }

    // Notes — rewrite #note(...) properties.
    let targets: Vec<(PathBuf, PropertyValue)> = {
        let index = state.property_index.read().await;
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

    let storage = state.get_storage().await?;
    for (path, value) in targets {
        let content = storage.read_file(&path).await?;
        let without_old = note_rewriter::remove_note_property(&content, &old_key);
        let updated = note_rewriter::update_note_property(&without_old, &new_key, &value);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            state.reindex_note(&path, &updated).await;
        }
    }

    // Explicitly purge the old key from the global property_keys set
    {
        let mut index = state.property_index.write().await;
        index.property_keys.remove(&old_key);
    }

    // .collection files — textual replacement of whole-word key references.
    rewrite_collection_files(&state, |text| replace_word(text, &old_key, &new_key)).await?;

    Ok(())
}

/// Delete a property key from every note and strip any
/// `.collection` references. The type registry entry for the key is removed.
#[tauri::command]
pub async fn delete_property_key(
    key: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Ok(());
    }

    {
        let mut reg = state.property_types.write().await;
        reg.clear(&key);
        reg.save();
    }

    let targets: Vec<PathBuf> = {
        let index = state.property_index.read().await;
        index
            .notes
            .values()
            .filter(|n| n.properties.contains_key(&key))
            .map(|n| n.path.clone())
            .collect()
    };

    let storage = state.get_storage().await?;
    for path in targets {
        let content = storage.read_file(&path).await?;
        let updated = note_rewriter::remove_note_property(&content, &key);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            state.reindex_note(&path, &updated).await;
        }
    }

    rewrite_collection_files(&state, |text| strip_word_line(text, &key)).await?;

    Ok(())
}

/// Remove a single property from one file only. Used by the per-row
/// "Remove" action in the right-panel properties view.
#[tauri::command]
pub async fn remove_property_from_file(
    path: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let updated = note_rewriter::remove_note_property(&content, &key);
    if updated != content {
        storage.write_file(&path_buf, &updated).await?;
        state.reindex_note(&path_buf, &updated).await;
    }
    Ok(())
}

// ── Tag rename / delete ───────────────────────────────────────────────

#[tauri::command]
pub async fn rename_tag(
    old_tag: String,
    new_tag: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let old_tag = sanitize_tag(&old_tag);
    let new_tag = sanitize_tag(&new_tag);
    if old_tag.is_empty() || new_tag.is_empty() || old_tag == new_tag {
        return Ok(());
    }

    let targets: Vec<PathBuf> = {
        let index = state.property_index.read().await;
        index
            .tags
            .get(&old_tag)
            .cloned()
            .unwrap_or_default()
    };

    let storage = state.get_storage().await?;
    for path in targets {
        let content = storage.read_file(&path).await?;
        let updated = rewrite_tag_in_content(&content, &old_tag, Some(&new_tag));
        if updated != content {
            storage.write_file(&path, &updated).await?;
            state.reindex_note(&path, &updated).await;
        }
    }

    // .collection files: best-effort literal replacement of the tag name
    // inside quoted strings. Filter expressions like
    // `file.tags.contains("rust")` will be updated; bare references
    // won't, because they'd be indistinguishable from property keys.
    rewrite_collection_files(&state, |text| {
        replace_quoted(text, &old_tag, &new_tag)
    })
    .await?;

    Ok(())
}

#[tauri::command]
pub async fn delete_tag(
    tag: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let tag = sanitize_tag(&tag);
    if tag.is_empty() {
        return Ok(());
    }

    let targets: Vec<PathBuf> = {
        let index = state.property_index.read().await;
        index.tags.get(&tag).cloned().unwrap_or_default()
    };

    let storage = state.get_storage().await?;
    for path in targets {
        let content = storage.read_file(&path).await?;
        let updated = rewrite_tag_in_content(&content, &tag, None);
        if updated != content {
            storage.write_file(&path, &updated).await?;
            state.reindex_note(&path, &updated).await;
        }
    }

    // .collection: strip quoted literal references. Same caveats as rename.
    rewrite_collection_files(&state, |text| replace_quoted(text, &tag, "")).await?;

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
    let patterns = [
        format!("\"{}\"", escaped),
        format!("'{}'", escaped),
    ];
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
            out = re.replace_all(&out, replacement_quoted.as_str()).into_owned();
        }
    }
    out
}

/// Apply a text transform to every `.collection` file in the vault.
async fn rewrite_collection_files<F>(
    state: &State<'_, AppState>,
    transform: F,
) -> Result<(), InkyCapError>
where
    F: Fn(&str) -> String,
{
    let storage = state.get_storage().await?;
    let collection_paths: Vec<PathBuf> = state.collection_files.read().await.clone();
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
        let content = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n#note(\n  tags: (\"foo\", \"bar\"),\n)\n\nSome content with #foo inline.\n";
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
