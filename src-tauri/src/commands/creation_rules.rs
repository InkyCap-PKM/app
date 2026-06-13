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
/// `title_override` is the user-entered filename the frontend supplies
/// after prompting: proactively when the rule's `filename_pattern` is
/// blank, or on retry after this command returned
/// [`InkyCapError::FilenameRequired`] (a non-empty pattern that expanded
/// to nothing). It's used as the whole filename only when the pattern
/// itself yields no name; an expandable pattern wins.
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
    let (zid_enabled, zid_pattern, locale, locale_typesetting) = {
        let settings = state.settings.read().await;
        // A note authored under a non-English UI locale gets a document-language
        // directive when the user has opted in — derived once here so the
        // settings lock isn't reacquired mid-assembly.
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

    // A note already at this exact path (same folder, same name) is expected
    // reuse — e.g. re-triggering today's daily note. Just open it.
    if storage.exists(&file_path).await {
        return Ok(CreationResult {
            path: to_frontend_string(&file_path),
            cursor_offset: None,
        });
    }
    // A note with this name in a *different* folder is a real conflict:
    // filenames are notebox-globally unique (wikilinks resolve by stem). Signal
    // it with the existing path so the frontend can ask whether to open it or
    // pick a different name, rather than silently duplicating or hijacking.
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

    // Inject the document-language directive (`#set text(lang/region)`) right
    // after the notebox import, so prose in the UI language is typeset with the
    // correct hyphenation, punctuation spacing, and smart quotes. `None` for an
    // English locale or when the user disabled locale typesetting. It sits in
    // the leading import machinery, which the visual editor hides.
    if let Some(directive) = &locale_typesetting {
        if let Some(pos) = content.find('\n') {
            let insert_pos = pos + 1;
            let line = format!("{directive}\n");
            content.insert_str(insert_pos, &line);
            if let Some(ref mut offset) = cursor_offset {
                if *offset >= insert_pos {
                    *offset += line.len();
                }
            }
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
    /// True for the two system scaffolds (`new-note.typ`, `daily-note.typ`),
    /// which the UI must not offer to delete and the backend refuses to
    /// delete. Always false for non-scaffold entries.
    pub builtin: bool,
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
            let builtin = is_builtin_scaffold(&p.file_name()?.to_string_lossy());
            Some(TemplateEntry {
                name,
                path: to_frontend_string(p),
                kind: "scaffold".to_string(),
                builtin,
            })
        })
        .collect();

    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

/// Result of preparing a scaffold-insert into an existing note.
#[derive(Debug, Serialize)]
pub struct ScaffoldInsertResult {
    /// New full source for the editor to replace its document with.
    pub new_source: String,
    /// New cursor offset within `new_source` (where the inserted body ends),
    /// in **UTF-16 code units** — the coordinate space CodeMirror uses for
    /// document offsets, not UTF-8 byte length.
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
        let cur = utf16_len(&working);
        return ScaffoldInsertResult {
            new_source: working,
            new_cursor_offset: cur,
        };
    }

    // Append at the end of the document, separated by one blank line, and put
    // the caret on a fresh line *after* the inserted content so the user can
    // start typing immediately below it. new_source ends with a newline, so
    // its end is the start of that fresh empty line.
    let base = working.trim_end_matches('\n');
    let new_source = format!("{base}\n\n{body}\n");
    let new_cursor_offset = utf16_len(&new_source);

    ScaffoldInsertResult {
        new_source,
        new_cursor_offset,
    }
}

/// Length of `s` in UTF-16 code units.
///
/// `new_cursor_offset` crosses the IPC boundary into CodeMirror, whose
/// document offsets are UTF-16 code units (JavaScript string offsets) — not
/// UTF-8 bytes. Returning a byte length here lands the caret past the end of
/// the document the moment the note contains any multi-byte character (smart
/// quotes, accented Latin, em-dashes, CJK …); CodeMirror then rejects the
/// out-of-range selection and the whole scaffold insert aborts. Counting
/// UTF-16 code units keeps the offset in the editor's coordinate space.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
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

/// Starter content for a new scaffold — demonstrates the `{{var}}` substitution
/// surface and the `#note(...)` properties pattern. Shared by `create_scaffold`
/// (the default when no content is supplied) and `get_scaffold_starter` (which
/// prefills the in-Settings scaffold editor), so the two never drift.
const STARTER_SCAFFOLD: &str = "// Scaffold: see https://typst.app/docs for Typst syntax.\n\
    // Variables: {{title}} {{slug}} {{date}} {{date:YYYY-MM-DD}}\n\
    //            {{time}} {{zid}} {{cursor}}\n\
    #note(\n  \
        // Properties go here. Any user-defined key is preserved.\n  \
        // tags: (\"draft\",),\n\
    )\n\n\
    = {{title}}\n\n\
    {{cursor}}\n";

/// Create a new scaffold file. Returns the absolute path.
///
/// When `content` is `None` the file is seeded with [`STARTER_SCAFFOLD`]; when
/// `Some`, the caller's content is written verbatim. Keeping create+write in a
/// single command makes the in-Settings editor's save atomic — a separate
/// create-then-write pair could leave a starter-only file behind on a failed
/// second call.
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

/// Core of [`create_scaffold`], decoupled from the Tauri/session layer so it can
/// be unit-tested against a real storage backend. Validates the name, ensures
/// the scaffold directory, refuses to clobber an existing file, and writes the
/// supplied content (or [`STARTER_SCAFFOLD`] when `None`). Returns the new
/// file's frontend path string.
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

/// Return the starter scaffold content used to prefill a brand-new scaffold in
/// the in-Settings editor. Read-only; mirrors the default `create_scaffold`
/// writes so the editor doesn't duplicate the template string.
#[tauri::command]
pub async fn get_scaffold_starter() -> Result<String, InkyCapError> {
    Ok(STARTER_SCAFFOLD.to_string())
}

/// True when `filename` (a basename, e.g. `"new-note.typ"`) is one of the two
/// system scaffolds seeded for the built-in creation rules. System scaffolds
/// self-heal via `notebox_health` re-seeding, so deleting them is both
/// pointless and confusing — they are protected from deletion.
fn is_builtin_scaffold(filename: &str) -> bool {
    filename == crate::notebox_package::NEW_NOTE_SCAFFOLD_FILE
        || filename == crate::notebox_package::DAILY_NOTE_SCAFFOLD_FILE
}

/// Normalize a user-supplied scaffold name to its `.typ` filename and refuse the
/// two system scaffolds. Pure, so the protection rule is unit-testable without a
/// storage backend. Mirrors the name handling in [`write_new_scaffold`].
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

/// Delete a user-created scaffold, moving it to the OS trash so the user can
/// recover it (consistent with note deletion via [`crate::commands::file_ops`]).
///
/// The two system scaffolds (`new-note.typ`, `daily-note.typ`) are refused —
/// defense-in-depth behind the UI, which already hides their delete button.
/// Mirrors the built-in *creation-rule* guard in [`delete_creation_rule`].
///
/// `scaffold_name` may be supplied with or without the `.typ` suffix (the panel
/// passes the bare stem); it is normalized the same way as `create_scaffold`.
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
        // The scaffold's {{cursor}} marker (stripped by the expander before
        // this fn) is irrelevant — the caret goes to a fresh line at the end.
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

    /// Regression: a note full of multi-byte content used to return a byte
    /// offset that overshot the editor's UTF-16 document length, so CodeMirror
    /// rejected the selection and the whole insert aborted ("insert failed").
    /// The cursor offset must stay within the UTF-16 length of `new_source`.
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
