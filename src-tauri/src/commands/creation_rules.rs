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

/// Look up the built-in default for a rule id. Returns the seeded default
/// for built-in rules (used by the "Restore defaults" button in the rule
/// editor) and `None` for user-created rules — those have no canonical
/// default to restore to.
#[tauri::command]
pub async fn get_default_creation_rule(
    rule_id: String,
) -> Result<Option<CreationRule>, InkyCapError> {
    Ok(creation_rules::default_rule_for_id(&rule_id))
}

/// Save a creation rule (create or update).
///
/// The new-note rule backs the file tree's New Note button and Ctrl+N, so
/// it can never be persisted in a disabled state — any attempt is forced
/// back to enabled before the write.
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

/// Execute a creation rule: create the file and return its path + cursor offset.
/// If the file already exists (e.g. daily note), returns existing path.
///
/// `title_override` is supplied by the frontend when the rule's
/// `filename_pattern` is empty — in that case the frontend opens a prompt
/// dialog first and passes the user-entered name through. When the
/// pattern is non-empty, this argument is ignored.
///
/// `target_folder_override` is supplied by callers that need to redirect
/// the rule into a specific folder regardless of its own `target_folder`
/// or the user's "New note location" preference (e.g. the file tree
/// context menu's "New File" entry, which targets the right-clicked
/// folder). The override is a path relative to the notebox root; an empty
/// string is treated as "notebox root". When `None`, the rule's own
/// folder logic (and fallback) applies unchanged.
#[tauri::command]
pub async fn execute_creation_rule(
    rule_id: String,
    title_override: Option<String>,
    target_folder_override: Option<String>,
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

    // Read ZID settings (user-global) for {{zid}} expansion and
    // auto-property, plus this notebox's "New note location" preference —
    // that's the fallback when the rule itself has no target folder set
    // (e.g. the built-in New Note).
    let (zid_enabled, zid_pattern, locale) = {
        let settings = state.settings.read().await;
        (
            settings.files.zettelkasten_enabled,
            settings.files.zid_pattern.clone(),
            scaffolds::chrono_locale(&settings.appearance.ui_locale),
        )
    };
    let fallback_folder = {
        let notebox = session.notebox_settings.read().await;
        match notebox.files.new_note_location.as_str() {
            "specified" => notebox.files.new_note_folder.clone(),
            _ => String::new(),
        }
    };

    // The override wins over both the rule's own target_folder and the
    // user-pref fallback. We model this by cloning the rule and rewriting
    // its target_folder — `execute_rule` then sees the override as the
    // rule's authoritative target.
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

    let (file_path, mut content, mut cursor_offset) = creation_rules::execute_rule(
        rule_for_exec,
        root,
        title_override.as_deref(),
        &fallback_folder,
        &zid_pattern,
        locale,
    )?;

    // If the rule has a scaffold, read and expand it
    if !rule.scaffold_path.is_empty() {
        let scaffold_file_path =
            crate::notebox_package::scaffolds_dir(root).join(&rule.scaffold_path);
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
            cursor_offset = expanded.cursor_offset;
        }
    }

    // If file already exists (e.g. daily note), just return the path
    if storage.exists(&file_path).await {
        return Ok(CreationResult {
            path: to_frontend_string(&file_path),
            cursor_offset: None,
        });
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
        let prefix_len = prefix.len();
        content = format!("{prefix}{content}");
        // Adjust cursor offset for the prepended lines
        if let Some(ref mut offset) = cursor_offset {
            *offset += prefix_len;
        }
        if cursor_offset.is_none() {
            cursor_offset = Some(prefix_len);
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
            if let Some(ref mut offset) = cursor_offset {
                if *offset >= insert_pos {
                    *offset += template_import.len();
                }
            }
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
        if let Some(ref mut offset) = cursor_offset {
            // Recalculate — the property insertion shifted content
            *offset = content.len().min(*offset);
        }
    }

    // Drop the caret on a fresh line at the very end of the note so the user
    // can start typing immediately below the scaffold's content. This
    // supersedes any earlier {{cursor}}-based offset (that marker is no longer
    // used for positioning) and matches the Ctrl+\ insert behaviour. Normalize
    // to exactly one trailing newline so the caret sits on the first blank line
    // below the content rather than several lines down.
    let trimmed_len = content.trim_end_matches('\n').len();
    content.truncate(trimmed_len);
    content.push('\n');
    cursor_offset = Some(content.len());

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
}

/// List scaffold entries with full path info for the Templates panel.
///
/// Distinct from [`list_scaffolds`], which only returns names — that one
/// stays for the creation-rule editor's dropdown. This one gives the panel
/// what it needs to open the file in a tab.
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
            Some(TemplateEntry {
                name,
                path: to_frontend_string(p),
                kind: "scaffold".to_string(),
            })
        })
        .collect();

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

/// Result of preparing a scaffold-insert into an existing note.
#[derive(Debug, Serialize)]
pub struct ScaffoldInsertResult {
    /// New full source for the editor to replace its document with.
    pub new_source: String,
    /// New cursor offset within `new_source` (where the inserted body ends).
    pub new_cursor_offset: usize,
}

/// Prepare a Ctrl+\\ "Insert Scaffold" operation.
///
/// Order of operations (matches the plan):
///
/// 1. Read & expand the scaffold's `{{var}}` placeholders (fresh `{{zid}}`,
///    `{{date}}` etc. at insert time, not at note-creation time).
/// 2. If the expanded scaffold begins with a `#note(...)` call, peel it off
///    and merge its kwargs into the target note's existing `#note(...)`.
///    Merge rule: **existing values win on conflict; new keys appended.**
///    Reuses `note_rewriter::update_note_property`, which preserves
///    whitespace and untouched fields byte-for-byte (the same invariant the
///    property panel relies on).
/// 3. Insert the remaining (post-`#note`, post-imports) scaffold body at
///    the cursor — replacing the selection if `selection_from`/`selection_to`
///    are provided.
///
/// The frontend replaces the editor's whole document with `new_source` and
/// moves the cursor to `new_cursor_offset`. Whole-doc replace is a single
/// CodeMirror transaction, so undo collapses the whole insert into one step.
#[tauri::command]
pub async fn prepare_scaffold_insert(
    state: State<'_, AppState>,
    scaffold_name: String,
    current_source: String,
    title: String,
    cursor_offset: usize,
    selection_from: Option<usize>,
    selection_to: Option<usize>,
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

    // The cursor/selection are no longer used to position the insert — a
    // scaffold appends to the end of the note (see assemble_scaffold_insert).
    // Kept in the signature for IPC compatibility with the frontend caller.
    let _ = (cursor_offset, selection_from, selection_to);

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

/// Pure core of [`prepare_scaffold_insert`]: merge the scaffold's `#note(...)`
/// properties into the target note and append the scaffold's body to the end
/// of the document. Split out so it's unit-testable without app state.
///
/// Behaviour:
/// - **Properties**: scaffold keys not already present in the target's
///   `#note(...)` are appended; existing keys are left untouched (existing
///   wins). Never replaces the target's body.
/// - **Body**: the scaffold's content after its `#note(...)`/imports is
///   appended at the end of the document, separated by one blank line. For a
///   note that's empty below its `#note(...)`, this reads as "fill it in"; for
///   one with content, it reads as "append" — matching the user's mental model
///   and, crucially, never overwriting existing prose.
/// - **Cursor**: lands on a fresh line at the very end of the inserted content
///   so the user can start typing immediately. The scaffold's `{{cursor}}`
///   marker (if any) is stripped by the expander but its offset is not used —
///   a trailing fresh line is simpler and is what authoring actually wants.
fn assemble_scaffold_insert(current_source: &str, expanded_content: &str) -> ScaffoldInsertResult {
    let (scaffold_note_args, body_start) = split_scaffold_note_and_body(expanded_content);

    // Merge step: append scaffold keys not already present. Existing keys win.
    // Each call may shift downstream bytes, but we always operate on the result
    // of the previous call, so sequential application stays correct.
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
        let cur = working.len();
        return ScaffoldInsertResult {
            new_source: working,
            new_cursor_offset: cur,
        };
    }

    // Append at the end of the document, separated by one blank line, and put
    // the caret on a fresh line *after* the inserted content so the user can
    // start typing immediately below it. new_source ends with a newline, so
    // new_source.len() is the start of that fresh empty line.
    let base = working.trim_end_matches('\n');
    let new_source = format!("{base}\n\n{body}\n");
    let new_cursor_offset = new_source.len();

    ScaffoldInsertResult {
        new_source,
        new_cursor_offset,
    }
}

/// Split an expanded scaffold into (note-call kwargs, body-start-offset).
///
/// - If there's a `#note(...)` call near the top, returns its named-arg pairs
///   and the offset *after* the call (skipping imports and the call itself).
/// - If there's no `#note(...)`, returns ([], offset after the leading import
///   lines).
fn split_scaffold_note_and_body(content: &str) -> (Vec<(String, String)>, usize) {
    let args = note_rewriter::extract_note_properties(content);
    let span = note_rewriter::note_call_span(content);

    // Skip leading `#import` lines regardless of #note presence — when the
    // scaffold author wrote imports at the top, they should be effective
    // for the new note's content, not re-imported into the target note.
    // (The target already has the canonical notebox import.)
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

/// Sanitize a user-supplied filename: keep alphanumerics, dash, underscore,
/// dot, and space; collapse whitespace; reject anything that would escape the
/// target directory.
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

/// Create a new scaffold file with starter content. Returns the absolute path.
#[tauri::command]
pub async fn create_scaffold(
    state: State<'_, AppState>,
    name: String,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let safe = sanitize_template_name(&name)?;
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

    // Starter content — demonstrates the `{{var}}` substitution surface and
    // the `#note(...)` properties pattern. User can replace freely.
    let starter = "// Scaffold: see https://typst.app/docs for Typst syntax.\n\
        // Variables: {{title}} {{slug}} {{date}} {{date:YYYY-MM-DD}}\n\
        //            {{time}} {{zid}} {{cursor}}\n\
        #note(\n  \
            // Properties go here. Any user-defined key is preserved.\n  \
            // tags: (\"draft\",),\n\
        )\n\n\
        = {{title}}\n\n\
        {{cursor}}\n";
    storage.write_file(&file_path, starter).await?;

    Ok(to_frontend_string(&file_path))
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
        // The scaffold's {{cursor}} marker (stripped by the expander before
        // this fn) is irrelevant — the caret goes to a fresh line at the end.
        let scaffold = format!("{IMPORT}#note(\n)\n\n= Meeting\n");
        let r = assemble_scaffold_insert(&current, &scaffold);
        assert_eq!(r.new_cursor_offset, r.new_source.len());
        assert!(r.new_source.ends_with("= Meeting\n"), "{}", r.new_source);
    }
}
