// Tauri IPC commands for creation rules and scaffold expansion.

use serde::Serialize;
use tauri::State;

use crate::creation_rules::{self, CreationRule};
use crate::errors::InkyCapError;
use crate::models::note::PropertyValue;
use crate::scaffolds;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter;

/// Result of executing a creation rule, including optional cursor offset.
#[derive(Debug, Serialize)]
pub struct CreationResult {
    pub path: String,
    pub cursor_offset: Option<usize>,
}

/// List all creation rules.
#[tauri::command]
pub async fn list_creation_rules() -> Result<Vec<CreationRule>, InkyCapError> {
    Ok(creation_rules::load_rules())
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
#[tauri::command]
pub async fn save_creation_rule(
    rule: CreationRule,
) -> Result<(), InkyCapError> {
    let mut rules = creation_rules::load_rules();

    if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
        *existing = rule;
    } else {
        rules.push(rule);
    }

    creation_rules::save_rules(&rules)?;
    Ok(())
}

/// Delete a creation rule by ID. Built-in rules cannot be deleted.
#[tauri::command]
pub async fn delete_creation_rule(
    rule_id: String,
) -> Result<(), InkyCapError> {
    let mut rules = creation_rules::load_rules();

    if let Some(rule) = rules.iter().find(|r| r.id == rule_id) {
        if rule.builtin {
            return Err(InkyCapError::InvalidPath(
                "Cannot delete built-in creation rule".to_string(),
            ));
        }
    }

    rules.retain(|r| r.id != rule_id);
    creation_rules::save_rules(&rules)?;
    Ok(())
}

/// Execute a creation rule: create the file and return its path + cursor offset.
/// If the file already exists (e.g. daily note), returns existing path.
///
/// `title_override` is supplied by the frontend when the rule's
/// `filename_pattern` is empty — in that case the frontend opens a prompt
/// dialog first and passes the user-entered name through. When the
/// pattern is non-empty, this argument is ignored.
#[tauri::command]
pub async fn execute_creation_rule(
    rule_id: String,
    title_override: Option<String>,
    state: State<'_, AppState>,
) -> Result<CreationResult, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let rules = creation_rules::load_rules();
    let rule = rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| InkyCapError::InvalidPath(format!("Rule not found: {}", rule_id)))?;

    // Read ZID settings for {{zid}} expansion and auto-property, plus the
    // user's "New note location" preference — that's the fallback when the
    // rule itself has no target folder set (e.g. the built-in New Note).
    let (zid_enabled, zid_pattern, fallback_folder) = {
        let settings = state.settings.read().await;
        let fallback = match settings.files.new_note_location.as_str() {
            "specified" => settings.files.new_note_folder.clone(),
            _ => String::new(),
        };
        (
            settings.files.zettelkasten_enabled,
            settings.files.zid_pattern.clone(),
            fallback,
        )
    };

    let (file_path, mut content, mut cursor_offset) = creation_rules::execute_rule(
        rule,
        root,
        title_override.as_deref(),
        &fallback_folder,
        &zid_pattern,
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
            let expanded =
                scaffolds::expand_scaffold_with_zid(storage.as_ref(), &scaffold_file_path, &title, &zid_pattern).await?;
            content = expanded.content;
            cursor_offset = expanded.cursor_offset;
        }
    }

    // If file already exists (e.g. daily note), just return the path
    if storage.exists(&file_path).await {
        return Ok(CreationResult {
            path: file_path.display().to_string(),
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
            content = note_rewriter::update_note_property(
                &content,
                "zid",
                &PropertyValue::Number(num),
            );
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

    storage.write_file(&file_path, &content).await?;

    state.reindex_note(&file_path, &content).await;

    Ok(CreationResult {
        path: file_path.display().to_string(),
        cursor_offset,
    })
}

/// List available scaffold files from the scaffold folder.
#[tauri::command]
pub async fn list_scaffolds(
    state: State<'_, AppState>,
) -> Result<Vec<String>, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let scaffold_dir = crate::notebox_package::scaffolds_dir(root);
    if !storage.exists(&scaffold_dir).await {
        return Ok(Vec::new());
    }

    let files = storage.list_files(&scaffold_dir, "*.typ").await?;
    let names: Vec<String> = files
        .iter()
        .filter_map(|p| {
            p.strip_prefix(&scaffold_dir)
                .ok()
                .map(|rel| rel.display().to_string())
        })
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
) -> Result<Vec<TemplateEntry>, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root = state.notebox_root.read().await;
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
                path: p.display().to_string(),
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
) -> Result<ScaffoldInsertResult, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let zid_pattern = {
        let settings = state.settings.read().await;
        settings.files.zid_pattern.clone()
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
        return Err(InkyCapError::FileNotFound(scaffold_path.display().to_string()));
    }

    let expanded =
        scaffolds::expand_scaffold_with_zid(storage.as_ref(), &scaffold_path, &title, &zid_pattern)
            .await?;

    // Split the expanded scaffold into (note_args, body_text). The body is
    // what gets inserted at the cursor; the args drive the merge into the
    // current note's `#note(...)`.
    let (scaffold_note_args, scaffold_body) =
        split_scaffold_note_and_body(&expanded.content);

    // Merge step. Walk scaffold args; for each key not already present in
    // the current source's `#note(...)`, append it. Existing keys win.
    let existing_keys: std::collections::HashSet<String> =
        note_rewriter::extract_note_properties(&current_source)
            .into_iter()
            .map(|(k, _)| k)
            .collect();

    let merge_keys: Vec<(String, String)> = scaffold_note_args
        .into_iter()
        .filter(|(k, _)| !existing_keys.contains(k))
        .collect();

    // Apply merges sequentially. Each call may shift downstream bytes, but
    // since we always operate on the result of the previous call this is
    // correct — and we never assume a stable byte position for downstream
    // edits while merging.
    let mut working = current_source.clone();
    let pre_merge_len = working.len();
    for (key, raw_value) in &merge_keys {
        working = note_rewriter::set_note_property_raw(&working, key, raw_value);
    }
    let merge_delta: isize = working.len() as isize - pre_merge_len as isize;

    // Compute the post-merge cursor and selection by shifting positions that
    // sit after the `#note(...)` call. If the cursor is inside or before
    // the note, leave it as-is (clamp to bounds at the end).
    let note_span_before = note_rewriter::note_call_span(&current_source);
    let shift_threshold = note_span_before.as_ref().map(|s| s.end).unwrap_or(0);

    let shift = |pos: usize| -> usize {
        if pos >= shift_threshold {
            ((pos as isize) + merge_delta).max(0) as usize
        } else {
            pos
        }
    };

    let target_cursor = shift(cursor_offset);
    let sel_from = selection_from.map(shift);
    let sel_to = selection_to.map(shift);

    // Insert the scaffold body. If a selection is provided, replace it;
    // otherwise insert at cursor. Trim leading whitespace from the body so
    // it doesn't introduce a stray blank line, but preserve internal shape.
    let body_to_insert = scaffold_body.trim_start_matches('\n').to_string();

    let (insert_from, insert_to) = match (sel_from, sel_to) {
        (Some(a), Some(b)) if a != b => {
            let lo = a.min(b).min(working.len());
            let hi = a.max(b).min(working.len());
            (lo, hi)
        }
        _ => {
            let c = target_cursor.min(working.len());
            (c, c)
        }
    };

    let mut new_source = String::with_capacity(working.len() + body_to_insert.len());
    new_source.push_str(&working[..insert_from]);
    new_source.push_str(&body_to_insert);
    new_source.push_str(&working[insert_to..]);

    // Cursor lands at the end of the inserted body, unless the scaffold had
    // a `{{cursor}}` placeholder (cursor_offset in ExpandedScaffold was
    // relative to the *expanded* scaffold including its #note() block; we
    // need the offset relative to body_to_insert). If the scaffold had no
    // {{cursor}}, the end-of-insert is the natural caret position.
    let body_cursor_in_inserted = expanded
        .cursor_offset
        .and_then(|c| {
            // Translate the scaffold-relative cursor into a body-relative
            // offset. Bytes before scaffold_body_start in expanded.content
            // are everything we stripped (imports + note call + leading
            // whitespace). If the cursor was inside the stripped prefix,
            // fall back to end-of-body.
            let stripped_prefix = expanded.content.len() - body_to_insert.len();
            if c >= stripped_prefix {
                Some(c - stripped_prefix)
            } else {
                None
            }
        })
        .unwrap_or(body_to_insert.len());

    let new_cursor_offset = insert_from + body_cursor_in_inserted;
    let new_cursor_offset = new_cursor_offset.min(new_source.len());

    Ok(ScaffoldInsertResult {
        new_source,
        new_cursor_offset,
    })
}

/// Split an expanded scaffold into (note-call kwargs, body-after-note).
///
/// - If there's a `#note(...)` call near the top, returns its named-arg
///   pairs and the text *after* the call (skipping imports and the call
///   itself).
/// - If there's no `#note(...)`, returns ([], the whole scaffold body
///   minus leading import lines).
fn split_scaffold_note_and_body(content: &str) -> (Vec<(String, String)>, String) {
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

    let body = content[body_start..].to_string();
    (args, body)
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
        return Err(InkyCapError::BadRequest("Template name cannot be empty".into()));
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
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root = state.notebox_root.read().await;
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

    Ok(file_path.display().to_string())
}

