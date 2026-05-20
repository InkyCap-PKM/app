use std::path::{Path, PathBuf};

use tauri::State;

use crate::errors::InkyCapError;
use crate::markdown::notebox_import::{self, ImportResult};
use crate::markdown::{
    markdown_to_typst, typst_to_markdown, MarkdownToTypstOptions, TypstToMarkdownOptions,
    UnconvertibleMode,
};
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;

/// Read clipboard text and convert from markdown to Typst in one step.
/// Bypasses webview clipboard restrictions by reading from the native
/// GTK/Cocoa/Win32 clipboard directly.
#[tauri::command]
pub async fn paste_markdown_as_typst(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let text = read_clipboard_text(&app).await.map_err(|e| {
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

    let attachment_folder = state
        .notebox_settings
        .read()
        .await
        .files
        .attachment_folder
        .clone();
    // Paste-from-clipboard has no source notebox to inspect for dialect;
    // default to Standard so prices like `$3000`, version refs like
    // `#42`, and other literal hashes survive intact.
    let options = MarkdownToTypstOptions {
        convert_frontmatter: true,
        attachment_folder,
        dialect: crate::markdown::md_to_typst::MarkdownDialect::Standard,
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

async fn read_clipboard_text(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
        app.run_on_main_thread(move || {
            let display = gtk::gdk::Display::default();
            let text = display.and_then(|d| {
                let cb = gtk::Clipboard::for_display(&d, &gtk::gdk::SELECTION_CLIPBOARD);
                cb.wait_for_text().map(|t| t.to_string())
            });
            let _ = tx.send(text);
        })
        .map_err(|e| format!("run_on_main_thread failed: {}", e))?;
        return rx.await.map_err(|_| "clipboard channel closed".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        return Ok(tokio::task::spawn_blocking(|| {
            use cocoa::base::{id, nil};
            use objc::{class, msg_send, sel, sel_impl};
            unsafe {
                let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
                let nsstring: id = msg_send![class!(NSString), stringWithUTF8String: b"public.utf8-plain-text\0".as_ptr()];
                let text: id = msg_send![pb, stringForType: nsstring];
                if text == nil {
                    None
                } else {
                    let cstr: *const std::os::raw::c_char = msg_send![text, UTF8String];
                    Some(std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned())
                }
            }
        })
        .await
        .map_err(|e| format!("clipboard task panicked: {}", e))?);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return Ok(None);
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Convert a markdown string to InkyCap Typst format.
#[tauri::command]
pub async fn convert_markdown_to_typst(
    markdown: String,
    include_preamble: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let attachment_folder = state
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

/// Import a markdown notebox from a zip file or directory into the target
/// notebox. `dialect` selects the source-markdown flavor ("standard" or
/// "obsidian"); pass `None` to let the importer auto-detect by looking
/// for an `.obsidian/` folder in the source.
#[tauri::command]
pub async fn import_markdown_notebox(
    source_path: String,
    target_path: String,
    dialect: Option<String>,
) -> Result<ImportResult, String> {
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

    let result = match archive_kind {
        Some(ArchiveKind::Zip) => notebox_import::import_from_zip(&source, &target, resolved_dialect),
        Some(ArchiveKind::TarGz) => {
            notebox_import::import_from_tarball(&source, &target, resolved_dialect)
        }
        None => notebox_import::import_from_directory(&source, &target, resolved_dialect),
    };

    Ok(result)
}

#[derive(Clone, Copy)]
enum ArchiveKind {
    Zip,
    TarGz,
}

/// Classify a source path as zip, tarball, or neither. Falls back to
/// double-extension sniffing for `.tar.gz` since `Path::extension` only
/// returns the trailing component.
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

/// Probe a source notebox (directory or .zip) and report which markdown
/// dialect the importer would use by default. The frontend calls this
/// after the user picks a file so the import dialog can preselect the
/// toggle without committing the user to anything.
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
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;

    let options = TypstToMarkdownOptions {
        unconvertible: unconvertible_mode,
    };
    let markdown = typst_to_markdown(&content, &options);

    tokio::fs::write(&output_path, markdown)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write {}: {}", output_path, e)))?;

    Ok(())
}

/// Batch export all notes in a collection view as markdown files.
#[tauri::command]
pub async fn export_collection_batch_markdown(
    collection_path: String,
    view_name: String,
    output_dir: String,
    unconvertible_mode: UnconvertibleMode,
    state: State<'_, AppState>,
) -> Result<Vec<String>, InkyCapError> {
    let storage = state.get_storage().await?;
    let output_dir_buf = PathBuf::from(&output_dir);

    // Get collection data to find all note paths in the view.
    let collection =
        crate::commands::collections::get_collection_data_internal(&collection_path, &view_name, &state)
            .await?;

    tokio::fs::create_dir_all(&output_dir_buf)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create output dir: {}", e)))?;

    let options = TypstToMarkdownOptions {
        unconvertible: unconvertible_mode,
    };

    let mut exported = Vec::new();

    for row in &collection.rows {
        let file_path = PathBuf::from(&row.file_path);
        let content = match storage.read_file(&file_path).await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Skipping {}: {}", row.file_path, e);
                continue;
            }
        };

        let markdown = typst_to_markdown(&content, &options);
        let md_name = row
            .file_name
            .strip_suffix(".typ")
            .unwrap_or(&row.file_name);
        let output_file = output_dir_buf.join(format!("{}.md", md_name));

        match tokio::fs::write(&output_file, &markdown).await {
            Ok(()) => exported.push(output_file.display().to_string()),
            Err(e) => log::error!("Failed to write {}: {}", output_file.display(), e),
        }
    }

    Ok(exported)
}
