use std::path::{Path, PathBuf};

use tauri::{Manager, State};

use crate::errors::InkyCapError;
use crate::markdown::md_to_typst::{FieldMapping, FrontmatterMapping};
use crate::markdown::notebox_import::{self, FrontmatterKeyInfo, ImportResult, SourceKind};
use crate::markdown::{
    markdown_to_typst, typst_to_markdown, MarkdownToTypstOptions, TypstToMarkdownOptions,
    UnconvertibleMode,
};
use crate::property_types::{is_system_property, PropertyType};
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;

/// Read the clipboard and convert it from Markdown to Typst, reading the native
/// clipboard directly to avoid webview clipboard restrictions.
#[tauri::command]
pub async fn paste_markdown_as_typst(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let session = state.session(window.label()).await;
    let text = crate::clipboard::read_text(&app).await.map_err(|e| {
        log::warn!("[paste-as-markdown] clipboard read error: {e}");
        e.to_string()
    })?;
    let text = match text {
        Some(t) if !t.is_empty() => {
            log::debug!("[paste-as-markdown] got {} bytes from clipboard", t.len());
            t
        }
        _ => {
            log::debug!("[paste-as-markdown] clipboard returned empty/None");
            return Ok(None);
        }
    };

    let attachment_folder = session
        .notebox_settings
        .read()
        .await
        .files
        .attachment_folder
        .clone();
    // A paste has no source notebox to detect a dialect from, so use Standard,
    // which keeps literal `$3000`, `#42` and other hashes intact.
    let options = MarkdownToTypstOptions {
        convert_frontmatter: true,
        attachment_folder,
        dialect: crate::markdown::md_to_typst::MarkdownDialect::Standard,
        // Clipboard paste has no mapping dialog; the built-in alias
        // defaults (shared serde_yaml parser) handle any frontmatter.
        frontmatter_mapping: None,
        // Standard dialect doesn't parse `$…$` as math, so this is unused;
        // Preserve is the safe default regardless.
        math: crate::markdown::MathImportMode::Preserve,
    };

    let full = markdown_to_typst(&text, &options);

    // Strip the import preamble — the target note already has one.
    let result = full
        .lines()
        .skip_while(|line| line.starts_with("#import"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_start_matches('\n')
        .to_string();

    Ok(Some(result))
}

/// Convert a markdown string to InkyCap Typst format.
#[tauri::command]
pub async fn convert_markdown_to_typst(
    markdown: String,
    include_preamble: bool,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let session = state.session(window.label()).await;
    let attachment_folder = session
        .notebox_settings
        .read()
        .await
        .files
        .attachment_folder
        .clone();
    // Same reasoning as `paste_markdown_as_typst`: Standard dialect by
    // default for clipboard / programmatic conversion.
    let options = MarkdownToTypstOptions {
        convert_frontmatter: true,
        attachment_folder,
        dialect: crate::markdown::md_to_typst::MarkdownDialect::Standard,
        // Programmatic conversion has no mapping dialog; the built-in
        // alias defaults (shared serde_yaml parser) handle frontmatter.
        frontmatter_mapping: None,
        // Standard dialect doesn't parse `$…$` as math; Preserve is unused.
        math: crate::markdown::MathImportMode::Preserve,
    };

    let full = markdown_to_typst(&markdown, &options);

    if include_preamble {
        Ok(full)
    } else {
        // Strip the import line for paste-into-existing-document use case.
        let result = full
            .lines()
            .skip_while(|line| line.starts_with("#import"))
            .collect::<Vec<_>>()
            .join("\n")
            .trim_start_matches('\n')
            .to_string();
        Ok(result)
    }
}

/// One row of the YAML-to-property mapping the user confirmed in the import
/// dialog. `target_key` is `None` when the property is excluded. `target_type`
/// is the type the value is formatted as (and, with `create`, the type
/// registered for the new property). System properties are never retyped.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PropertyMapping {
    pub source_key: String,
    pub target_key: Option<String>,
    pub target_type: PropertyType,
    /// Whether `target_key` is a new property to register in the type
    /// registry (vs. an existing notebox/system property).
    pub create: bool,
}

/// Build the lowercased-source-key → `FieldMapping` table the converter
/// consumes from the dialog's mapping rows.
fn build_mapping_table(mappings: &[PropertyMapping]) -> FrontmatterMapping {
    mappings
        .iter()
        .map(|m| {
            (
                m.source_key.to_lowercase(),
                FieldMapping {
                    target_key: m.target_key.clone(),
                    target_type: m.target_type,
                },
            )
        })
        .collect()
}

/// Report the distinct YAML frontmatter keys across the Markdown files in an
/// archive or folder, each with a suggested property mapping, for the import
/// dialog. Frontmatter is YAML in every dialect, so no dialect is needed. An
/// open notebox's existing properties inform the suggestions.
#[tauri::command]
pub async fn scan_markdown_frontmatter(
    source_path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<FrontmatterKeyInfo>, String> {
    let session = state.session(window.label()).await;
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("Source path does not exist: {}", source_path));
    }

    let archive_kind = archive_kind_for(&source);
    let source_kind = match archive_kind {
        Some(ArchiveKind::Zip) => SourceKind::Zip,
        Some(ArchiveKind::TarGz) => SourceKind::TarGz,
        None if source.is_dir() => SourceKind::Directory,
        None => return Err("Source must be a directory, .zip, or .tar.gz file".to_string()),
    };

    let existing_keys = {
        let index = session.property_index.read().await;
        index.property_keys.iter().cloned().collect()
    };
    let types = {
        let reg = session.property_types.read().await;
        reg.all()
    };

    Ok(notebox_import::scan_frontmatter(
        &source,
        source_kind,
        &existing_keys,
        &types,
    ))
}

/// Import a Markdown notebox from a zip file or folder into the target notebox.
/// `dialect` is "standard" or "obsidian"; `None` detects it from an
/// `.obsidian/` folder. `mappings` is the YAML-to-property mapping confirmed in
/// the dialog; with `None`, the built-in defaults are used.
#[tauri::command]
pub async fn import_markdown_notebox(
    source_path: String,
    target_path: String,
    dialect: Option<String>,
    mappings: Option<Vec<PropertyMapping>>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<ImportResult, String> {
    let session = state.session(window.label()).await;
    let source = PathBuf::from(&source_path);
    let target = PathBuf::from(&target_path);

    if !source.exists() {
        return Err(format!("Source path does not exist: {}", source_path));
    }

    let archive_kind = archive_kind_for(&source);
    if !source.is_dir() && archive_kind.is_none() {
        return Err("Source must be a directory, .zip, or .tar.gz file".to_string());
    }

    let resolved_dialect = match dialect.as_deref() {
        Some("obsidian") => crate::markdown::md_to_typst::MarkdownDialect::Obsidian,
        Some("standard") => crate::markdown::md_to_typst::MarkdownDialect::Standard,
        _ => match archive_kind {
            Some(ArchiveKind::Zip) => notebox_import::detect_dialect_for_zip(&source),
            Some(ArchiveKind::TarGz) => notebox_import::detect_dialect_for_tarball(&source),
            None => notebox_import::detect_dialect_for_directory(&source),
        },
    };

    let mapping_table = mappings.as_deref().map(build_mapping_table);

    // Route embed-referenced attachments into the target notebox's configured
    // attachment folder (Settings ▸ Files & Links), not a hardcoded default.
    let attachment_folder = session
        .notebox_settings
        .read()
        .await
        .files
        .attachment_folder
        .clone();

    let result = match archive_kind {
        Some(ArchiveKind::Zip) => notebox_import::import_from_zip(
            &source,
            &target,
            resolved_dialect,
            mapping_table,
            attachment_folder,
        ),
        Some(ArchiveKind::TarGz) => notebox_import::import_from_tarball(
            &source,
            &target,
            resolved_dialect,
            mapping_table,
            attachment_folder,
        ),
        None => notebox_import::import_from_directory(
            &source,
            &target,
            resolved_dialect,
            mapping_table,
            attachment_folder,
        ),
    };

    // Register the types of newly created properties so they get the right
    // editor. System properties are never touched, and a "create" matching an
    // existing property is treated as a mapping (the existing type is kept).
    if let Some(mappings) = &mappings {
        let existing_keys: std::collections::HashSet<String> = {
            let index = session.property_index.read().await;
            index.property_keys.iter().cloned().collect()
        };
        let mut reg = session.property_types.write().await;
        let known = reg.all();
        let mut changed = false;
        for m in mappings {
            if !m.create {
                continue;
            }
            let Some(target) = &m.target_key else {
                continue;
            };
            if is_system_property(target)
                || existing_keys.contains(target)
                || known.contains_key(target)
            {
                continue;
            }
            reg.set(target.clone(), m.target_type);
            changed = true;
        }
        if changed {
            reg.save();
        }
    }

    // The importer wrote the notes straight to disk, so the in-memory indexes
    // (links, corpus stats, search, properties) and the metadata cache are out
    // of date. The file watcher handles bulk imports poorly, so rebuild here;
    // otherwise backlinks, search and the Mycelial View don't see the new
    // notes.
    crate::commands::notebox::spawn_index_rebuild(window.app_handle().clone(), session.clone());

    Ok(result)
}

#[derive(Clone, Copy)]
enum ArchiveKind {
    Zip,
    TarGz,
}

/// Classify a source path as zip, tarball or neither. `.tar.gz` is checked by
/// name, since `Path::extension` gives only the last part.
fn archive_kind_for(path: &Path) -> Option<ArchiveKind> {
    if !path.is_file() {
        return None;
    }
    let lower = path.file_name()?.to_string_lossy().to_lowercase();
    if lower.ends_with(".zip") {
        Some(ArchiveKind::Zip)
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Some(ArchiveKind::TarGz)
    } else {
        None
    }
}

/// Report which Markdown dialect the importer would use for a source notebox
/// (folder or .zip), so the import dialog can preselect it.
#[tauri::command]
pub async fn detect_markdown_dialect(source_path: String) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("Source path does not exist: {}", source_path));
    }
    let detected = if source.is_dir() {
        notebox_import::detect_dialect_for_directory(&source)
    } else {
        match archive_kind_for(&source) {
            Some(ArchiveKind::Zip) => notebox_import::detect_dialect_for_zip(&source),
            Some(ArchiveKind::TarGz) => notebox_import::detect_dialect_for_tarball(&source),
            None => {
                return Err("Source must be a directory, .zip, or .tar.gz file".to_string());
            }
        }
    };
    Ok(match detected {
        crate::markdown::md_to_typst::MarkdownDialect::Obsidian => "obsidian".to_string(),
        crate::markdown::md_to_typst::MarkdownDialect::Standard => "standard".to_string(),
    })
}

/// Export a Typst note to markdown format, writing to a file.
#[tauri::command]
pub async fn export_note_markdown_to_file(
    path: String,
    output_path: String,
    unconvertible_mode: UnconvertibleMode,
    review_mode: Option<String>,
    linked_files: Option<crate::commands::export::LinkedFilesOptions>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<crate::commands::export::CompanionReport>, InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_path)
        .await?;
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content =
        crate::commands::export::helpers::apply_review_mode(&content, review_mode.as_deref());
    let mut companion = crate::commands::export::companion::CompanionFiles::beside_file(
        linked_files,
        std::path::Path::new(&output_path),
    );
    let content = companion.prepare_note(&storage, &path_buf, &content);

    let options = TypstToMarkdownOptions {
        unconvertible: unconvertible_mode,
    };
    let markdown = typst_to_markdown(&content, &options);

    tokio::fs::write(&output_path, markdown)
        .await
        .map_err(|e| {
            InkyCapError::ExportFailed(format!("Failed to write {}: {}", output_path, e))
        })?;

    companion.copy().await
}

/// Batch export all notes in a collection view as markdown files. A note that
/// can't be read or written is left out and listed in `skipped_notes`.
#[tauri::command]
pub async fn export_collection_batch_markdown(
    collection_path: String,
    view_name: String,
    output_dir: String,
    unconvertible_mode: UnconvertibleMode,
    review_mode: Option<String>,
    linked_files: Option<crate::commands::export::LinkedFilesOptions>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<crate::commands::export::BatchExportResult, InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_dir)
        .await?;
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let output_dir_buf = PathBuf::from(&output_dir);

    // Get collection data to find all note paths in the view.
    let collection = crate::commands::collections::get_collection_data_internal(
        &collection_path,
        &view_name,
        &session,
    )
    .await?;

    tokio::fs::create_dir_all(&output_dir_buf)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create output dir: {}", e)))?;

    let options = TypstToMarkdownOptions {
        unconvertible: unconvertible_mode,
    };

    let mut exported = Vec::new();
    let mut skipped_notes = Vec::new();
    let mut companion = crate::commands::export::companion::CompanionFiles::for_collection(
        linked_files,
        &output_dir_buf,
        std::path::Path::new(&collection_path),
    );

    for row in &collection.rows {
        let file_path = PathBuf::from(&row.file_path);
        let content = match storage.read_file(&file_path).await {
            Ok(c) => c,
            Err(e) => {
                skipped_notes.push(crate::commands::export::SkippedNote::for_row(row, e));
                continue;
            }
        };

        let content =
            crate::commands::export::helpers::apply_review_mode(&content, review_mode.as_deref());
        let content = companion.prepare_note(&storage, &file_path, &content);
        let markdown = typst_to_markdown(&content, &options);
        let md_name = row.file_name.strip_suffix(".typ").unwrap_or(&row.file_name);
        let output_file = output_dir_buf.join(format!("{}.md", md_name));

        match tokio::fs::write(&output_file, &markdown).await {
            Ok(()) => exported.push(crate::storage::to_frontend_string(&output_file)),
            Err(e) => skipped_notes.push(crate::commands::export::SkippedNote::for_row(row, e)),
        }
    }

    Ok(crate::commands::export::BatchExportResult {
        files: exported,
        skipped_notes,
        bypassed_count: 0,
        companion: companion.copy().await?,
    })
}
