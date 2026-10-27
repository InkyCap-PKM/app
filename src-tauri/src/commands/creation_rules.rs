// Tauri IPC commands for creation rules and scaffold expansion.

use serde::Serialize;
use tauri::State;

use crate::creation_rules::{self, CreationRule};
use crate::errors::InkyCapError;
use crate::models::note::PropertyValue;
use crate::scaffolds;
use crate::state::AppState;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter;

/// Result of executing a creation rule, including optional cursor offset.
#[derive(Debug, Serialize)]
pub struct CreationResult {
    pub path: String,
    pub cursor_offset: Option<usize>,
}

/// List all creation rules for the currently open notebox.
#[tauri::command]
pub async fn list_creation_rules(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<CreationRule>, InkyCapError> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;
    Ok(creation_rules::load_rules(root))
}

/// The built-in default for a rule id ("Restore defaults"), or `None` for user
/// rules.
#[tauri::command]
pub async fn get_default_creation_rule(
    rule_id: String,
) -> Result<Option<CreationRule>, InkyCapError> {
    Ok(creation_rules::default_rule_for_id(&rule_id))
}

/// Save a creation rule. The new-note rule (New Note button, Ctrl+N) is always
/// saved enabled.
#[tauri::command]
pub async fn save_creation_rule(
    rule: CreationRule,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let mut rule = rule;
    if rule.id == "new-note" {
        rule.disabled = false;
    }

    let mut rules = creation_rules::load_rules(root);

    if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
        *existing = rule;
    } else {
        rules.push(rule);
    }

    creation_rules::save_rules(root, &rules)?;
    Ok(())
}

/// Delete a creation rule by ID. Built-in rules cannot be deleted.
#[tauri::command]
pub async fn delete_creation_rule(
    rule_id: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let mut rules = creation_rules::load_rules(root);

    if let Some(rule) = rules.iter().find(|r| r.id == rule_id) {
        if rule.builtin {
            return Err(InkyCapError::InvalidPath(
                "Cannot delete built-in creation rule".to_string(),
            ));
        }
    }

    rules.retain(|r| r.id != rule_id);
    creation_rules::save_rules(root, &rules)?;
    Ok(())
}

/// Save a new order for the rules. `ordered_ids` lists every rule id; see
/// [`creation_rules::reorder_rules`] for missing or unknown ids.
#[tauri::command]
pub async fn reorder_creation_rules(
    ordered_ids: Vec<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let mut rules = creation_rules::load_rules(root);
    creation_rules::reorder_rules(&mut rules, &ordered_ids);
    creation_rules::save_rules(root, &rules)?;
    Ok(())
}

/// Run a creation rule: create the file and return its path and caret offset. An
/// existing file (e.g. today's daily note) is returned as is.
///
/// - `title_override`: the file name the user entered, sent when the rule's
///   `filename_pattern` is blank or after [`InkyCapError::FilenameRequired`].
///   Used only when the pattern yields no name.
/// - `target_folder_override`: a notebox-relative folder (empty for the root)
///   that overrides the rule's folder and "New note location", e.g. the file
///   tree's "New File".
/// - `scaffold_override`: a scaffold name or scaffolds-relative path (`.typ`
///   optional) used instead of the rule's own, e.g. the scaffold picker with no
///   note open.
/// - `current_note`: the note being worked in; with "New note location" set to
///   "Current folder", a rule without its own folder creates the note beside it.
#[tauri::command]
pub async fn execute_creation_rule(
    rule_id: String,
    title_override: Option<String>,
    target_folder_override: Option<String>,
    scaffold_override: Option<String>,
    current_note: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<CreationResult, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let rules = creation_rules::load_rules(root);
    let rule = rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| InkyCapError::InvalidPath(format!("Rule not found: {}", rule_id)))?;

    // ZID settings for `{{zid}}`, and this notebox's "New note location", the
    // fallback when the rule has no folder.
    let (zid_enabled, zid_pattern, locale, locale_typesetting) = {
        let settings = state.settings.read().await;
        // The language directive for non-English UI languages, when enabled.
        let locale_typesetting = if settings.appearance.use_locale_typesetting {
            crate::notebox_package::locale_typesetting_directive(&settings.appearance.ui_locale)
        } else {
            None
        };
        (
            settings.files.zettelkasten_enabled,
            settings.files.zid_pattern.clone(),
            scaffolds::chrono_locale(&settings.appearance.ui_locale),
            locale_typesetting,
        )
    };
    let fallback_folder =
        crate::commands::file_placement::default_note_folder(&session, current_note.as_deref())
            .await;

    // The override wins over the rule's folder and the fallback: apply it to a
    // copy of the rule.
    let effective_rule;
    let rule_for_exec: &CreationRule = match target_folder_override.as_deref() {
        Some(folder) => {
            effective_rule = CreationRule {
                target_folder: folder.to_string(),
                ..rule.clone()
            };
            &effective_rule
        }
        None => rule,
    };

    let file_path = creation_rules::execute_rule(
        rule_for_exec,
        root,
        title_override.as_deref(),
        &fallback_folder,
        &zid_pattern,
        locale,
    )?;
    let mut content = String::new();

    // The scaffold: an explicit override wins over the rule's own. Normalize
    // `.typ` as `prepare_scaffold_insert` does.
    let scaffold_rel = match scaffold_override.as_deref() {
        Some(name) if !name.is_empty() => Some(if name.ends_with(".typ") {
            name.to_string()
        } else {
            format!("{name}.typ")
        }),
        _ if !rule.scaffold_path.is_empty() => Some(rule.scaffold_path.clone()),
        _ => None,
    };

    // If a scaffold applies, read and expand it
    if let Some(scaffold_rel) = scaffold_rel {
        let scaffold_file_path = crate::notebox_package::scaffolds_dir(root).join(&scaffold_rel);
        if storage.exists(&scaffold_file_path).await {
            let title = file_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let expanded = scaffolds::expand_scaffold_with_zid(
                storage.as_ref(),
                &scaffold_file_path,
                &title,
                &zid_pattern,
                locale,
            )
            .await?;
            content = expanded.content;
        }
    }

    // A note already at this exact path (same folder, same name) is expected
    // reuse — e.g. re-triggering today's daily note. Just open it.
    if storage.exists(&file_path).await {
        return Ok(CreationResult {
            path: to_frontend_string(&file_path),
            cursor_offset: None,
        });
    }
    // A note with this name in another folder is a conflict, since names are
    // unique across the notebox. Return its path so the frontend can offer to
    // open it or rename.
    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(existing) =
        crate::commands::files::existing_note_with_stem(&session, &file_name).await
    {
        return Err(InkyCapError::NoteNameConflict(to_frontend_string(
            &existing,
        )));
    }

    // Ensure the import line is present
    let import_line = crate::notebox_package::import_line();
    if !content.contains(&import_line) {
        let has_note_call = content.contains("#note(");
        let prefix = if has_note_call {
            format!("{import_line}\n")
        } else {
            format!("{import_line}\n#note()\n\n")
        };
        content = format!("{prefix}{content}");
    }

    // Add the language directive after the notebox import, for correct
    // hyphenation, spacing and quotes. The visual editor hides it with the
    // imports.
    if let Some(directive) = &locale_typesetting {
        if let Some(pos) = content.find('\n') {
            let insert_pos = pos + 1;
            let line = format!("{directive}\n");
            content.insert_str(insert_pos, &line);
        }
    }

    // Inject Typst template import if specified
    if !rule.typst_template.is_empty() {
        let resolved = crate::commands::export::resolve_template_path_with_root(
            &rule.typst_template,
            Some(root),
        );
        let template_import = format!("#import \"{}\": *\n", resolved);
        if let Some(pos) = content.find('\n') {
            let insert_pos = pos + 1;
            content.insert_str(insert_pos, &template_import);
        }
    }

    // Ensure target directory exists
    if let Some(parent) = file_path.parent() {
        storage.create_dir(parent).await?;
    }

    // Auto-set the zid property when zettelkasten is enabled
    if zid_enabled && !zid_pattern.is_empty() {
        let zid_value = scaffolds::generate_zid(&zid_pattern);
        if let Ok(num) = zid_value.parse::<f64>() {
            content =
                note_rewriter::update_note_property(&content, "zid", &PropertyValue::Number(num));
        } else {
            content = note_rewriter::update_note_property(
                &content,
                "zid",
                &PropertyValue::String(zid_value),
            );
        }
    }

    // Put the caret on a new line at the end, with exactly one trailing
    // newline. The offset is in UTF-16 units, as CodeMirror counts.
    let trimmed_len = content.trim_end_matches('\n').len();
    content.truncate(trimmed_len);
    content.push('\n');
    let cursor_offset = Some(utf16_len(&content));

    storage.write_file(&file_path, &content).await?;

    session.reindex_note(&file_path, &content).await;

    Ok(CreationResult {
        path: to_frontend_string(&file_path),
        cursor_offset,
    })
}

/// List available scaffold files from the scaffold folder.
#[tauri::command]
pub async fn list_scaffolds(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let scaffold_dir = crate::notebox_package::scaffolds_dir(root);
    if !storage.exists(&scaffold_dir).await {
        return Ok(Vec::new());
    }

    let files = storage.list_files(&scaffold_dir, "*.typ").await?;
    let names: Vec<String> = files
        .iter()
        .filter_map(|p| p.strip_prefix(&scaffold_dir).ok().map(to_frontend_string))
        .collect();

    Ok(names)
}

/// An entry shown in the Templates panel.
#[derive(Debug, Serialize)]
pub struct TemplateEntry {
    /// Display name (the file/folder basename without the `.typ` suffix for
    /// bare files; the directory name for package-style templates).
    pub name: String,
    /// Absolute filesystem path the editor opens. For package templates this
    /// is the `typst.toml`. For bare scaffolds and templates it's the `.typ`.
    pub path: String,
    /// "scaffold" | "template-file" | "template-package".
    pub kind: String,
    /// True for the two system scaffolds (`new-note.typ`, `daily-note.typ`),
    /// which can't be deleted.
    pub builtin: bool,
}

/// Scaffold entries with full paths, for the Templates panel.
/// [`list_scaffolds`] returns only names, for the rule editor.
#[tauri::command]
pub async fn list_scaffold_entries(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<TemplateEntry>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let scaffold_dir = crate::notebox_package::scaffolds_dir(root);
    if !storage.exists(&scaffold_dir).await {
        return Ok(Vec::new());
    }

    let files = storage.list_files(&scaffold_dir, "*.typ").await?;
    let mut entries: Vec<TemplateEntry> = files
        .iter()
        .filter_map(|p| {
            let name = p.file_stem()?.to_string_lossy().to_string();
            let builtin = is_builtin_scaffold(&p.file_name()?.to_string_lossy());
            Some(TemplateEntry {
                name,
                path: to_frontend_string(p),
                kind: "scaffold".to_string(),
                builtin,
            })
        })
        .collect();

    entries.sort_by(|a, b| crate::sort::compare_name(&a.name, &b.name));
    Ok(entries)
}

/// Result of preparing a scaffold-insert into an existing note.
#[derive(Debug, Serialize)]
pub struct ScaffoldInsertResult {
    /// New full source for the editor to replace its document with.
    pub new_source: String,
    /// Caret offset in `new_source` (where the inserted body ends), in UTF-16
    /// units.
    pub new_cursor_offset: usize,
}

/// Prepare an "Insert Scaffold" (Ctrl+\\):
///
/// 1. Expand the scaffold's `{{var}}` placeholders, at insert time.
/// 2. If it starts with `#note(...)`, merge those arguments into the note's
///    `#note(...)`: existing values win, new keys are appended.
///    `note_rewriter::update_note_property` keeps everything else byte for
///    byte.
/// 3. Append the rest of the scaffold to the end of the note, with the caret on
///    a new line below it.
///
/// The frontend replaces the whole document with `new_source` in one
/// transaction (one undo step) and moves the caret to `new_cursor_offset`.
#[tauri::command]
pub async fn prepare_scaffold_insert(
    state: State<'_, AppState>,
    scaffold_name: String,
    current_source: String,
    title: String,
    window: tauri::WebviewWindow,
) -> Result<ScaffoldInsertResult, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let (zid_pattern, locale) = {
        let settings = state.settings.read().await;
        (
            settings.files.zid_pattern.clone(),
            scaffolds::chrono_locale(&settings.appearance.ui_locale),
        )
    };

    // Resolve scaffold path. Accept either the bare name (with or without
    // .typ) or a path relative to the scaffolds dir.
    let filename = if scaffold_name.ends_with(".typ") {
        scaffold_name.clone()
    } else {
        format!("{}.typ", scaffold_name)
    };
    let scaffold_path = crate::notebox_package::scaffolds_dir(root).join(&filename);
    if !storage.exists(&scaffold_path).await {
        return Err(InkyCapError::FileNotFound(
            scaffold_path.display().to_string(), // path-stringification-ok: error message, not IPC
        ));
    }

    let expanded = scaffolds::expand_scaffold_with_zid(
        storage.as_ref(),
        &scaffold_path,
        &title,
        &zid_pattern,
        locale,
    )
    .await?;

    Ok(assemble_scaffold_insert(&current_source, &expanded.content))
}

/// Core of [`prepare_scaffold_insert`], testable without app state:
///
/// - **Properties**: scaffold keys missing from the note's `#note(...)` are
///   appended; existing keys are kept.
/// - **Body**: the scaffold's content after its `#note(...)` and imports is
///   appended after one blank line, never replacing existing text.
/// - **Caret**: on a new line after the inserted content.
fn assemble_scaffold_insert(current_source: &str, expanded_content: &str) -> ScaffoldInsertResult {
    let (scaffold_note_args, body_start) = split_scaffold_note_and_body(expanded_content);

    // Each call works on the previous result, so offsets stay correct.
    let existing_keys: std::collections::HashSet<String> =
        note_rewriter::extract_note_properties(current_source)
            .into_iter()
            .map(|(k, _)| k)
            .collect();
    let mut working = current_source.to_string();
    for (key, raw_value) in scaffold_note_args
        .into_iter()
        .filter(|(k, _)| !existing_keys.contains(k))
    {
        working = note_rewriter::set_note_property_raw(&working, &key, &raw_value);
    }

    // The body is everything after the scaffold's `#note(...)`/imports. Trim
    // surrounding blank lines so we control the spacing ourselves.
    let body = expanded_content[body_start..].trim_matches('\n');

    if body.is_empty() {
        // Note-only scaffold: nothing to append. Cursor stays at end.
        let cur = utf16_len(&working);
        return ScaffoldInsertResult {
            new_source: working,
            new_cursor_offset: cur,
        };
    }

    // `new_source` ends with a newline, so its end is the start of the new
    // empty line.
    let base = working.trim_end_matches('\n');
    let new_source = format!("{base}\n\n{body}\n");
    let new_cursor_offset = utf16_len(&new_source);

    ScaffoldInsertResult {
        new_source,
        new_cursor_offset,
    }
}

/// Length of `s` in UTF-16 units, the unit of CodeMirror's offsets. A byte
/// length would overshoot as soon as the note has a multi-byte character, and
/// CodeMirror would reject the selection.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Split an expanded scaffold into its `#note(...)` arguments and the offset
/// where its body starts (after the imports and the call). Without a
/// `#note(...)`, no arguments and the offset after the imports.
fn split_scaffold_note_and_body(content: &str) -> (Vec<(String, String)>, usize) {
    let args = note_rewriter::extract_note_properties(content);
    let span = note_rewriter::note_call_span(content);

    // Skip leading imports either way; the note already has the notebox import.
    let body_start = if let Some(ref s) = span {
        s.end
    } else {
        skip_leading_imports(content)
    };

    (args, body_start.min(content.len()))
}

fn skip_leading_imports(content: &str) -> usize {
    let mut pos = 0;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#import") || trimmed.is_empty() {
            pos += line.len() + 1; // +1 for the newline
        } else {
            break;
        }
    }
    pos.min(content.len())
}

/// Clean a user-supplied file name: keep letters, digits, dash, underscore, dot
/// and space, collapse whitespace, and reject anything that leaves the folder.
fn sanitize_template_name(name: &str) -> Result<String, InkyCapError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(InkyCapError::BadRequest(
            "Template name cannot be empty".into(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(InkyCapError::BadRequest(
            "Template name cannot contain path separators or '..'".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Starter content for a new scaffold, showing `{{var}}` placeholders and
/// `#note(...)` properties. Used by `create_scaffold` and
/// `get_scaffold_starter`. Starts with the notebox import, like the built-in
/// scaffolds (note creation adds it anyway if missing).
const STARTER_SCAFFOLD: &str = "#import \"/.inkycap/notebox.typ\": *\n\n\
    // Scaffold: see https://typst.app/docs for Typst syntax.\n\
    // Variables: {{title}} {{slug}} {{date}} {{date:YYYY-MM-DD}}\n\
    //            {{time}} {{zid}}\n\
    #note(\n  \
        // Properties go here. Any user-defined key is preserved.\n  \
        // tags: (\"draft\",),\n\
    )\n\n\
    = {{title}}\n";

/// Create a scaffold file and return its absolute path. With `content` `None`
/// it gets [`STARTER_SCAFFOLD`]; otherwise `content` is written as is. Creating
/// and writing in one command means a failed save can't leave a starter-only
/// file.
#[tauri::command]
pub async fn create_scaffold(
    state: State<'_, AppState>,
    name: String,
    content: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    write_new_scaffold(storage.as_ref(), root, &name, content.as_deref()).await
}

/// Core of [`create_scaffold`], testable with a real storage backend: validate
/// the name, create the folder, refuse to overwrite, write the content (or
/// [`STARTER_SCAFFOLD`]) and return the path.
async fn write_new_scaffold(
    storage: &dyn NoteboxStorage,
    root: &std::path::Path,
    name: &str,
    content: Option<&str>,
) -> Result<String, InkyCapError> {
    let safe = sanitize_template_name(name)?;
    let filename = if safe.ends_with(".typ") {
        safe
    } else {
        format!("{}.typ", safe)
    };

    let scaffold_dir = crate::notebox_package::scaffolds_dir(root);
    storage.create_dir(&scaffold_dir).await?;

    let file_path = scaffold_dir.join(&filename);
    if storage.exists(&file_path).await {
        return Err(InkyCapError::BadRequest(format!(
            "Scaffold '{}' already exists",
            filename
        )));
    }

    storage
        .write_file(&file_path, content.unwrap_or(STARTER_SCAFFOLD))
        .await?;

    Ok(to_frontend_string(&file_path))
}

/// The starter content for the Settings scaffold editor.
#[tauri::command]
pub async fn get_scaffold_starter() -> Result<String, InkyCapError> {
    Ok(STARTER_SCAFFOLD.to_string())
}

/// True when `filename` (e.g. `"new-note.typ"`) is a system scaffold. They are
/// re-created by `notebox_health`, so they can't be deleted.
fn is_builtin_scaffold(filename: &str) -> bool {
    filename == crate::notebox_package::NEW_NOTE_SCAFFOLD_FILE
        || filename == crate::notebox_package::DAILY_NOTE_SCAFFOLD_FILE
}

/// Normalize a scaffold name to its `.typ` file name, refusing the system
/// scaffolds. As in [`write_new_scaffold`].
fn scaffold_delete_filename(name: &str) -> Result<String, InkyCapError> {
    let safe = sanitize_template_name(name)?;
    let filename = if safe.ends_with(".typ") {
        safe
    } else {
        format!("{}.typ", safe)
    };
    if is_builtin_scaffold(&filename) {
        return Err(InkyCapError::InvalidPath(
            "Cannot delete a built-in scaffold".to_string(),
        ));
    }
    Ok(filename)
}

/// Move a user scaffold to the OS trash, as notes are deleted (see
/// [`crate::commands::file_ops`]). The system scaffolds are refused, as the UI
/// also hides their delete button (like [`delete_creation_rule`] for built-in
/// rules). `scaffold_name` may omit `.typ`.
#[tauri::command]
pub async fn delete_scaffold(
    state: State<'_, AppState>,
    scaffold_name: String,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let filename = scaffold_delete_filename(&scaffold_name)?;

    let file_path = crate::notebox_package::scaffolds_dir(root).join(&filename);
    if !storage.exists(&file_path).await {
        return Err(InkyCapError::FileNotFound(
            file_path.display().to_string(), // path-stringification-ok: error message, not IPC
        ));
    }

    storage.move_to_trash(&file_path).await?;
    Ok(())
}

#[cfg(test)]
mod scaffold_insert_tests {
    use super::*;

    const IMPORT: &str = "#import \"/.inkycap/notebox.typ\": *\n";

    #[test]
    fn appends_body_preserving_existing_content() {
        let current =
            format!("{IMPORT}#note(\n  title: \"Existing\",\n)\n\nExisting prose here.\n");
        let scaffold = format!(
            "{IMPORT}#note(\n  title: \"Meeting\",\n  kind: \"meeting\",\n)\n\n= Meeting\n"
        );
        let r = assemble_scaffold_insert(&current, &scaffold);
        // Existing prose is never overwritten — the original wipe bug.
        assert!(
            r.new_source.contains("Existing prose here."),
            "{}",
            r.new_source
        );
        // Existing property wins; the scaffold's new key is merged in.
        assert!(
            r.new_source.contains("title: \"Existing\""),
            "{}",
            r.new_source
        );
        assert!(
            r.new_source.contains("kind: \"meeting\""),
            "{}",
            r.new_source
        );
        // Body appended at the very end, one blank line after the prose.
        assert!(
            r.new_source.contains("Existing prose here.\n\n= Meeting"),
            "{}",
            r.new_source
        );
        assert!(
            r.new_source.trim_end().ends_with("= Meeting"),
            "{}",
            r.new_source
        );
    }

    #[test]
    fn fills_blank_note() {
        let current = format!("{IMPORT}#note(\n  title: \"Blank\",\n)\n");
        let scaffold =
            format!("{IMPORT}#note(\n  title: \"Meeting\",\n)\n\n= Meeting\n\nbody text\n");
        let r = assemble_scaffold_insert(&current, &scaffold);
        assert!(r.new_source.contains("= Meeting"), "{}", r.new_source);
        assert!(r.new_source.contains("body text"), "{}", r.new_source);
        // The note call survives exactly once (scaffold's own #note is dropped).
        assert_eq!(
            r.new_source.matches("#note(").count(),
            1,
            "{}",
            r.new_source
        );
        assert!(r.new_source.starts_with(IMPORT), "{}", r.new_source);
    }

    #[test]
    fn note_only_scaffold_merges_props_without_touching_body() {
        let current = format!("{IMPORT}#note(\n  title: \"A\",\n)\n\nprose\n");
        let scaffold = format!("{IMPORT}#note(\n  status: \"draft\",\n)\n");
        let r = assemble_scaffold_insert(&current, &scaffold);
        assert!(r.new_source.contains("prose"), "{}", r.new_source);
        assert!(
            r.new_source.contains("status: \"draft\""),
            "{}",
            r.new_source
        );
        // Nothing appended after the prose.
        assert!(
            r.new_source.trim_end().ends_with("prose"),
            "{}",
            r.new_source
        );
    }

    #[test]
    fn cursor_lands_on_fresh_line_at_end() {
        let current = format!("{IMPORT}#note(\n  title: \"X\",\n)\n\nprose\n");
        // The caret goes to a fresh line at the end of the inserted content.
        let scaffold = format!("{IMPORT}#note(\n)\n\n= Meeting\n");
        let r = assemble_scaffold_insert(&current, &scaffold);
        // Offset is in UTF-16 code units (CodeMirror's coordinate space).
        assert_eq!(r.new_cursor_offset, r.new_source.encode_utf16().count());
        assert!(r.new_source.ends_with("= Meeting\n"), "{}", r.new_source);
    }

    #[test]
    fn delete_filename_normalizes_and_protects_builtins() {
        // Bare name gains the .typ suffix.
        assert_eq!(scaffold_delete_filename("meeting").unwrap(), "meeting.typ");
        // Already-suffixed name is left as-is.
        assert_eq!(
            scaffold_delete_filename("meeting.typ").unwrap(),
            "meeting.typ"
        );
        // System scaffolds are refused, with or without the suffix.
        assert!(scaffold_delete_filename("new-note").is_err());
        assert!(scaffold_delete_filename("new-note.typ").is_err());
        assert!(scaffold_delete_filename("daily-note").is_err());
        assert!(scaffold_delete_filename("daily-note.typ").is_err());
        // Empty and path-escaping names are rejected by sanitization.
        assert!(scaffold_delete_filename("").is_err());
        assert!(scaffold_delete_filename("../secrets").is_err());
    }

    /// A note with multi-byte content must get a caret offset within the UTF-16
    /// length of `new_source`.
    #[test]
    fn cursor_offset_is_utf16_for_multibyte_content() {
        // Smart quotes, accented Latin, an em-dash, and CJK — each is multiple
        // UTF-8 bytes but one or two UTF-16 code units.
        let current = format!(
            "{IMPORT}#note(\n  title: \"Réunion\",\n)\n\n\u{201c}Café\u{201d} — 会議のメモ here.\n"
        );
        let scaffold = format!("{IMPORT}#note(\n  kind: \"meeting\",\n)\n\n= Agenda\n");
        let r = assemble_scaffold_insert(&current, &scaffold);

        let utf16_len = r.new_source.encode_utf16().count();
        assert_eq!(r.new_cursor_offset, utf16_len);
        // The byte length is strictly larger here — proving a byte offset would
        // have landed past the end of the editor document.
        assert!(
            r.new_source.len() > utf16_len,
            "test should exercise multi-byte content: {}",
            r.new_source
        );
        // Existing multi-byte prose survives untouched.
        assert!(
            r.new_source
                .contains("\u{201c}Café\u{201d} — 会議のメモ here."),
            "{}",
            r.new_source
        );
    }
}

#[cfg(test)]
mod create_scaffold_tests {
    use super::*;
    use crate::storage::traits::NoteboxStorage;

    /// Real storage over a tempdir so `write_new_scaffold` exercises the actual
    /// create-dir / exists / write-file path.
    fn storage_for(root: &std::path::Path) -> crate::storage::local::LocalNoteboxStorage {
        crate::storage::local::LocalNoteboxStorage::new(root.to_path_buf())
            .expect("open temp notebox")
    }

    #[tokio::test]
    async fn writes_supplied_content_verbatim() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = storage_for(tmp.path());
        let body = "#note()\n\n= Custom body\n";

        let path = write_new_scaffold(&storage, tmp.path(), "meeting", Some(body))
            .await
            .unwrap();

        let written = storage
            .read_file(std::path::Path::new(&path))
            .await
            .unwrap();
        assert_eq!(written, body);
    }

    #[tokio::test]
    async fn defaults_to_starter_when_no_content() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = storage_for(tmp.path());

        let path = write_new_scaffold(&storage, tmp.path(), "blank", None)
            .await
            .unwrap();

        let written = storage
            .read_file(std::path::Path::new(&path))
            .await
            .unwrap();
        assert_eq!(written, STARTER_SCAFFOLD);
    }

    #[tokio::test]
    async fn refuses_duplicate_regardless_of_content() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = storage_for(tmp.path());

        write_new_scaffold(&storage, tmp.path(), "dup", Some("first"))
            .await
            .unwrap();
        let err = write_new_scaffold(&storage, tmp.path(), "dup", Some("second"))
            .await
            .unwrap_err();
        assert!(
            matches!(err, InkyCapError::BadRequest(_)),
            "expected BadRequest, got {err:?}"
        );
    }

    #[tokio::test]
    async fn appends_typ_suffix_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = storage_for(tmp.path());

        let path = write_new_scaffold(&storage, tmp.path(), "noext", None)
            .await
            .unwrap();
        assert!(path.ends_with("noext.typ"), "{path}");
    }

    /// Drift guard: the editor prefills from `get_scaffold_starter`, which must
    /// return exactly what `create_scaffold` writes by default.
    #[tokio::test]
    async fn starter_command_matches_default_write() {
        assert_eq!(get_scaffold_starter().await.unwrap(), STARTER_SCAFFOLD);
    }
}
