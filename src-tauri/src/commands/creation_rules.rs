// Tauri IPC commands for creation rules and scaffold expansion.

use serde::Serialize;
use tauri::State;

use crate::creation_rules::{self, CreationRule};
use crate::errors::InkyCapError;
use crate::scaffolds;
use crate::state::AppState;
use crate::storage::traits::VaultStorage;

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
#[tauri::command]
pub async fn execute_creation_rule(
    rule_id: String,
    state: State<'_, AppState>,
) -> Result<CreationResult, InkyCapError> {
    let storage = state.get_storage().await?;
    let vault_root = state.vault_root.read().await;
    let root = vault_root.as_ref().ok_or(InkyCapError::VaultNotOpen)?;

    let rules = creation_rules::load_rules();
    let rule = rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| InkyCapError::InvalidPath(format!("Rule not found: {}", rule_id)))?;

    let (file_path, mut content, mut cursor_offset) =
        creation_rules::execute_rule(rule, root, None);

    // If the rule has a scaffold, read and expand it
    if !rule.scaffold_path.is_empty() {
        let scaffold_folder = {
            let settings = state.settings.read().await;
            settings.files.scaffold_folder.clone()
        };
        let scaffold_file_path = root.join(&scaffold_folder).join(&rule.scaffold_path);
        if storage.exists(&scaffold_file_path).await {
            let title = file_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let expanded =
                scaffolds::expand_scaffold(storage.as_ref(), &scaffold_file_path, &title).await?;
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
    let import_line = crate::vault_package::import_line();
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
    let vault_root = state.vault_root.read().await;
    let root = vault_root.as_ref().ok_or(InkyCapError::VaultNotOpen)?;

    let scaffold_folder = {
        let settings = state.settings.read().await;
        settings.files.scaffold_folder.clone()
    };

    let scaffold_dir = root.join(&scaffold_folder);
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
