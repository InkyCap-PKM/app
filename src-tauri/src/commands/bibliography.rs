//! Bibliography-related Tauri commands (Phase 6).

use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::sanitize_vault_arg;
use crate::storage::traits::VaultStorage;
use crate::typst_pipeline::bibliography::{self, BibEntry};

/// Return all entries from the configured citation source (file or Zotero).
#[tauri::command]
pub async fn get_bibliography_entries(
    state: State<'_, AppState>,
) -> Result<Vec<BibEntry>, InkyCapError> {
    let vault_root = state
        .vault_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::VaultNotOpen)?;

    let (source, bib_path, zotero_path) = {
        let settings = state.settings.read().await;
        (
            settings.citations.source.clone(),
            settings.citations.bibliography_path.clone(),
            settings.citations.zotero_database_path.clone(),
        )
    };

    match source.as_str() {
        "zotero" => {
            let db = zotero_path
                .map(PathBuf::from)
                .or_else(|| crate::typst_pipeline::zotero::auto_detect_path());
            match db {
                Some(p) => crate::typst_pipeline::zotero::read_entries(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
        _ => {
            let bib = bibliography::detect_default(&vault_root, bib_path.as_deref());
            match bib {
                Some(p) => bibliography::parse_bibliography(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
    }
}

/// Return citation keys used in the given file, with metadata from the
/// configured citation source.
#[tauri::command]
pub async fn get_file_citations(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileCitation>, InkyCapError> {
    let storage = state.get_storage().await?;
    let source = storage.read_file(&sanitize_vault_arg(&path)?).await?;

    let keys = bibliography::extract_citations(&source);
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    // Re-use get_bibliography_entries logic but we can't call a Tauri command
    // from another command, so inline the lookup.
    let entries = load_entries_inner(&state).await.unwrap_or_default();

    let citations = keys
        .into_iter()
        .map(|key| {
            let entry = entries.iter().find(|e| e.key == key);
            FileCitation {
                key: key.clone(),
                title: entry.map(|e| e.title.clone()),
                authors: entry.map(|e| e.authors.clone()).unwrap_or_default(),
                year: entry.and_then(|e| e.year.clone()),
                entry_type: entry.map(|e| e.entry_type.clone()),
                zotero_item_key: entry.and_then(|e| e.zotero_item_key.clone()),
            }
        })
        .collect();

    Ok(citations)
}

/// Shared entry loading logic.
async fn load_entries_inner(state: &AppState) -> Result<Vec<BibEntry>, InkyCapError> {
    let vault_root = state
        .vault_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::VaultNotOpen)?;

    let (source, bib_path, zotero_path) = {
        let settings = state.settings.read().await;
        (
            settings.citations.source.clone(),
            settings.citations.bibliography_path.clone(),
            settings.citations.zotero_database_path.clone(),
        )
    };

    match source.as_str() {
        "zotero" => {
            let db = zotero_path
                .map(PathBuf::from)
                .or_else(|| crate::typst_pipeline::zotero::auto_detect_path());
            match db {
                Some(p) => crate::typst_pipeline::zotero::read_entries(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
        _ => {
            let bib = bibliography::detect_default(&vault_root, bib_path.as_deref());
            match bib {
                Some(p) => bibliography::parse_bibliography(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
    }
}

/// Re-export the Zotero bibliography to `.inkycap/zotero-export.bib`.
/// Called from the "refresh" button in the References panel.
#[tauri::command]
pub async fn refresh_bibliography(
    state: State<'_, AppState>,
) -> Result<Option<String>, InkyCapError> {
    let vault_root = state
        .vault_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::VaultNotOpen)?;
    let citations = {
        let settings = state.settings.read().await;
        settings.citations.clone()
    };
    Ok(crate::state::configure_bibliography(&vault_root, &citations))
}

/// Auto-detect the Zotero database path.
#[tauri::command]
pub async fn detect_zotero_path() -> Result<Option<String>, InkyCapError> {
    Ok(crate::typst_pipeline::zotero::auto_detect_path()
        .map(|p| p.to_string_lossy().to_string()))
}

/// A citation key found in a file, enriched with bibliography metadata.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileCitation {
    pub key: String,
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub entry_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_item_key: Option<String>,
}
