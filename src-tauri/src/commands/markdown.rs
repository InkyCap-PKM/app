use std::path::{Path, PathBuf};

use tauri::State;

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
        return Ok(tokio::task::spawn_blocking(read_clipboard_text_win32)
            .await
            .map_err(|e| format!("clipboard task panicked: {}", e))?);
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Read CF_UNICODETEXT from the Win32 clipboard. Mirrors the CF_HDROP reader
/// in [`crate::commands::file_ops::win32`]: open clipboard with a null HWND,
/// pull the handle, lock the global memory, copy bytes out, then unlock and
/// close so other apps don't see a stale clipboard owner. Returns `None` when
/// the clipboard has no text payload (e.g. an image was copied).
#[cfg(target_os = "windows")]
fn read_clipboard_text_win32() -> Option<String> {
    use windows_sys::Win32::Foundation::{HGLOBAL, HWND};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;

    unsafe {
        let null_hwnd: HWND = std::ptr::null_mut();
        if OpenClipboard(null_hwnd) == 0 {
            log::debug!("[clipboard] OpenClipboard failed (text)");
            return None;
        }
        let result = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT);
            if handle.is_null() {
                return None;
            }
            let hglobal: HGLOBAL = handle as HGLOBAL;
            let locked = GlobalLock(hglobal);
            if locked.is_null() {
                return None;
            }
            // CF_UNICODETEXT is a null-terminated UTF-16LE string. Walk
            // until we find the terminator rather than relying on the
            // global handle size, which can be padded.
            let ptr = locked as *const u16;
            let mut len = 0usize;
            while *ptr.add(len) != 0 {
                len += 1;
                // Hard cap so a malformed (un-terminated) payload doesn't
                // walk the heap. 16 MiB of text is far past any sane paste.
                if len > 16 * 1024 * 1024 {
                    break;
                }
            }
            let slice = std::slice::from_raw_parts(ptr, len);
            let s = String::from_utf16_lossy(slice);
            GlobalUnlock(hglobal);
            if s.is_empty() { None } else { Some(s) }
        })();
        CloseClipboard();
        result
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

/// One row of the user's confirmed YAML→property mapping from the import
/// dialog. `target_key` is `None` when the user excluded the property.
/// `target_type` is the type the value is formatted as (and, when `create`
/// is set, the type registered for the new property). System properties are
/// never re-typed regardless of `create`.
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

/// Scan every markdown file's YAML frontmatter in a source archive (or
/// directory) and report the distinct keys with a suggested InkyCap
/// property mapping for each. The frontend shows these in the mapping
/// dialog before committing the import. Frontmatter is YAML regardless of
/// dialect, so this needs no dialect argument. An open notebox supplies the
/// existing property keys/types used to suggest matches.
#[tauri::command]
pub async fn scan_markdown_frontmatter(
    source_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FrontmatterKeyInfo>, String> {
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
        let index = state.property_index.read().await;
        index.property_keys.iter().cloned().collect()
    };
    let types = {
        let reg = state.property_types.read().await;
        reg.all()
    };

    Ok(notebox_import::scan_frontmatter(
        &source,
        source_kind,
        &existing_keys,
        &types,
    ))
}

/// Import a markdown notebox from a zip file or directory into the target
/// notebox. `dialect` selects the source-markdown flavor ("standard" or
/// "obsidian"); pass `None` to let the importer auto-detect by looking
/// for an `.obsidian/` folder in the source. `mappings`, when present,
/// carries the user's confirmed YAML→property mapping from the dialog;
/// when `None`, the importer falls back to its built-in alias defaults.
#[tauri::command]
pub async fn import_markdown_notebox(
    source_path: String,
    target_path: String,
    dialect: Option<String>,
    mappings: Option<Vec<PropertyMapping>>,
    state: State<'_, AppState>,
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

    let mapping_table = mappings.as_deref().map(build_mapping_table);

    // Route embed-referenced attachments into the target notebox's configured
    // attachment folder (Settings ▸ Files & Links), not a hardcoded default.
    let attachment_folder = state
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

    // Persist the declared type for any newly-created properties so the
    // editor renders them with the right widget after the import. System
    // properties have fixed types and are never touched; a "create" that
    // collides with a property already in the notebox is treated as a plain
    // mapping (no re-typing of the existing property).
    if let Some(mappings) = &mappings {
        let existing_keys: std::collections::HashSet<String> = {
            let index = state.property_index.read().await;
            index.property_keys.iter().cloned().collect()
        };
        let mut reg = state.property_types.write().await;
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
    review_mode: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = crate::commands::export::helpers::apply_review_mode(
        &content,
        review_mode.as_deref(),
    );

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
    review_mode: Option<String>,
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

        let content = crate::commands::export::helpers::apply_review_mode(
            &content,
            review_mode.as_deref(),
        );
        let markdown = typst_to_markdown(&content, &options);
        let md_name = row
            .file_name
            .strip_suffix(".typ")
            .unwrap_or(&row.file_name);
        let output_file = output_dir_buf.join(format!("{}.md", md_name));

        match tokio::fs::write(&output_file, &markdown).await {
            Ok(()) => exported.push(crate::storage::to_frontend_string(&output_file)),
            Err(e) => log::error!("Failed to write {}: {}", output_file.display(), e),
        }
    }

    Ok(exported)
}
