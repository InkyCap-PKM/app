// File management commands: create, rename, move, delete (trash).
// Rename-and-update-links walks backward links to update wikilinks in referencing files.

use std::path::PathBuf;

use tauri::{Manager, State};

use crate::events::{publish, AppEvent, Audience};

use crate::commands::file_placement::{incoming_folder, IncomingPlacement};
use crate::errors::InkyCapError;
use crate::state::{AppState, NoteboxSession};
use crate::storage::sanitize_notebox_arg;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;
use crate::storage::validate_notebox_path;
use crate::typst_pipeline::path_rebase::{rebase_relative_paths, rewrite_referenced_path};

/// Copy a file, given as base64 data, into the notebox per `placement` (see
/// [`crate::commands::file_placement`]). Returns the notebox-relative path, renamed if needed to
/// avoid overwriting.
#[tauri::command]
pub async fn copy_bytes_into_notebox(
    filename: String,
    data_base64: String,
    placement: Option<IncomingPlacement>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    use base64::Engine;

    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| InkyCapError::InvalidPath(format!("Invalid base64: {}", e)))?;

    let placement = placement.unwrap_or_default();
    write_incoming_file(&filename, &data, &placement, &app, &session).await
}

/// File paths on the system clipboard, read through the OS clipboard API
/// because webviews can't read clipboard file targets. Used when pasting a file
/// copied in the file manager.
///
/// - **Linux**: GTK `Clipboard::wait_for_uris`, run on the main loop thread via
///   `AppHandle::run_on_main_thread`, with the result sent back over a oneshot
///   channel.
/// - **macOS**: `NSPasteboard` read for `NSURL` objects, from a blocking task.
/// - **Windows**: `CF_HDROP` read with `DragQueryFileW`, from a blocking task.
///
/// Empty when the clipboard holds no files.
#[tauri::command]
pub async fn read_clipboard_file_paths(app: tauri::AppHandle) -> Result<Vec<String>, InkyCapError> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();
        app.run_on_main_thread(move || {
            let result = linux::read_clipboard_uris_blocking();
            let _ = tx.send(result);
        })
        .map_err(|e| InkyCapError::InvalidPath(format!("run_on_main_thread failed: {}", e)))?;
        let paths = rx
            .await
            .map_err(|_| InkyCapError::InvalidPath("clipboard channel closed".into()))?;
        Ok(paths)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let paths = tokio::task::spawn_blocking(macos::read_clipboard_uris_blocking)
            .await
            .map_err(|e| InkyCapError::InvalidPath(format!("clipboard task panicked: {}", e)))?;
        Ok(paths)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let paths = tokio::task::spawn_blocking(win32::read_clipboard_uris_blocking)
            .await
            .map_err(|e| InkyCapError::InvalidPath(format!("clipboard task panicked: {}", e)))?;
        Ok(paths)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

/// Copy whatever the native clipboard holds (files or image data) into the
/// notebox per `placement` and return the paths to insert. WebKitGTK hides
/// clipboard files, and on Linux pasted images, from the webview.
///
/// Unlike [`copy_path_into_notebox`], file paths aren't checked against the
/// drop allowlist: they come from a native clipboard read, not from the
/// frontend.
#[tauri::command]
pub async fn paste_clipboard_into_notebox(
    placement: Option<IncomingPlacement>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    // 1. File references — "copy a file in the file manager, then paste".
    let placement = placement.unwrap_or_default();
    let uris = read_clipboard_file_paths(app.clone()).await?;
    if !uris.is_empty() {
        let mut saved = Vec::new();
        for uri in uris {
            let src = PathBuf::from(&uri);
            if !src.is_file() {
                continue;
            }
            // Async read — clipboard file references can be large media and
            // must not block the async worker.
            let data = tokio::fs::read(&src).await?;
            let filename = src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "pasted".to_string());
            saved.push(write_incoming_file(&filename, &data, &placement, &app, &session).await?);
        }
        if !saved.is_empty() {
            return Ok(saved);
        }
    }

    // 2. Raw image bytes (screenshots, "Copy Image"). Only on Linux; on macOS
    //    and Windows the webview already receives them.
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<u8>>>();
        app.run_on_main_thread(move || {
            let _ = tx.send(linux::read_clipboard_image_png_blocking());
        })
        .map_err(|e| InkyCapError::InvalidPath(format!("run_on_main_thread failed: {e}")))?;
        let png = rx
            .await
            .map_err(|_| InkyCapError::InvalidPath("clipboard channel closed".into()))?;
        if let Some(bytes) = png {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let name = format!("pasted-{ts}.png");
            return Ok(vec![
                write_incoming_file(&name, &bytes, &placement, &app, &session).await?,
            ]);
        }
    }

    Ok(Vec::new())
}

#[cfg(target_os = "linux")]
mod linux {
    //! Read the GTK3 clipboard via `wait_for_uris`. Runs on the
    //! main GTK loop thread — callers must dispatch accordingly.

    pub fn read_clipboard_uris_blocking() -> Vec<String> {
        let display = match gtk::gdk::Display::default() {
            Some(d) => d,
            None => {
                log::debug!("[clipboard] no default GDK display");
                return Vec::new();
            }
        };
        let clipboard = gtk::Clipboard::for_display(&display, &gtk::gdk::SELECTION_CLIPBOARD);
        // Empty when the clipboard has no URI target. Each entry is a `file://`
        // URL.
        let uris = clipboard.wait_for_uris();
        log::debug!("[clipboard] wait_for_uris returned {} URIs", uris.len());
        uris.into_iter()
            .filter_map(|u: gtk::glib::GString| super::parse_file_uri_line(u.as_str()))
            .collect()
    }

    /// Image data on the GTK clipboard, encoded as PNG, or `None`. Runs on the
    /// main GTK thread, like [`read_clipboard_uris_blocking`].
    pub fn read_clipboard_image_png_blocking() -> Option<Vec<u8>> {
        let display = gtk::gdk::Display::default()?;
        let clipboard = gtk::Clipboard::for_display(&display, &gtk::gdk::SELECTION_CLIPBOARD);
        let pixbuf = clipboard.wait_for_image()?;
        match pixbuf.save_to_bufferv("png", &[]) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                log::debug!("[clipboard] pixbuf->png encode failed: {e}");
                None
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! Reads `NSURL` objects from the general pasteboard, which covers files
    //! copied in Finder. Safe from any thread.

    use objc2::ClassType;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSURL};

    pub fn read_clipboard_uris_blocking() -> Vec<String> {
        let pb = NSPasteboard::generalPasteboard();

        // `readObjectsForClasses:options:` wants an NSArray of Class objects.
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let urls = unsafe { pb.readObjectsForClasses_options(&classes, None) };
        let Some(urls) = urls else { return Vec::new() };

        // SAFETY: readObjectsForClasses_options is constrained to NSURL::class()
        let urls = unsafe { urls.cast_unchecked::<NSURL>() };
        let count = urls.count();
        log::debug!("[clipboard] NSPasteboard returned {} NSURLs", count);
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let url = urls.objectAtIndex(i);
            if let Some(path) = url.path() {
                let s = path.to_string();
                if !s.is_empty() {
                    out.push(s);
                }
            }
        }
        out
    }
}

#[cfg(target_os = "windows")]
mod win32 {
    //! Reads the clipboard's CF_HDROP format (the file list Explorer places on
    //! copy) with `DragQueryFileW`. Safe from any thread once OpenClipboard
    //! succeeds.
    //!
    //! Named `win32` so it doesn't shadow the `windows_sys` crate path.

    use windows_sys::Win32::Foundation::{HGLOBAL, HWND};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_HDROP: u32 = 15;

    pub fn read_clipboard_uris_blocking() -> Vec<String> {
        unsafe {
            // A null HWND ties the clipboard to the current task. Zero means
            // failure.
            let null_hwnd: HWND = std::ptr::null_mut();
            if OpenClipboard(null_hwnd) == 0 {
                log::debug!("[clipboard] OpenClipboard failed");
                return Vec::new();
            }
            // A closure so CloseClipboard always runs, even on early return.
            let result: Vec<String> = (|| {
                let handle = GetClipboardData(CF_HDROP);
                if handle.is_null() {
                    return Vec::new();
                }
                let hglobal: HGLOBAL = handle as HGLOBAL;
                let locked = GlobalLock(hglobal);
                if locked.is_null() {
                    return Vec::new();
                }
                let hdrop: HDROP = locked as HDROP;
                let null_pwstr: *mut u16 = std::ptr::null_mut();
                let count = DragQueryFileW(hdrop, u32::MAX, null_pwstr, 0);
                log::debug!("[clipboard] CF_HDROP contains {} files", count);
                let mut out = Vec::with_capacity(count as usize);
                for i in 0..count {
                    // First call gets the length without the terminator; the
                    // second fills a buffer of length + 1.
                    let len = DragQueryFileW(hdrop, i, null_pwstr, 0);
                    if len == 0 {
                        continue;
                    }
                    let mut buf = vec![0u16; (len + 1) as usize];
                    let written = DragQueryFileW(hdrop, i, buf.as_mut_ptr(), buf.len() as u32);
                    if written == 0 {
                        continue;
                    }
                    let s = String::from_utf16_lossy(&buf[..written as usize]);
                    if !s.is_empty() {
                        out.push(s);
                    }
                }
                GlobalUnlock(hglobal);
                out
            })();
            CloseClipboard();
            result
        }
    }
}

/// Parse one `file://...` line into an absolute path, or None for other URIs.
/// Linux only: macOS and Windows read native types instead.
#[cfg(target_os = "linux")]
fn parse_file_uri_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let rest = line.strip_prefix("file://")?;
    // Drop any host: `file:///abs` already starts with `/`; for
    // `file://host/abs` keep what follows the host.
    let path_part = match rest.find('/') {
        Some(i) => &rest[i..],
        None => rest,
    };
    Some(percent_decode(path_part))
}

/// Decode `%XX` escapes in a URI path.
#[cfg(target_os = "linux")]
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(target_os = "linux")]
fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Copy a file, by absolute path, into the notebox per `placement`. Used for drops and pastes that
/// give a `file://` URL instead of a File (common on Linux). Rust reads the file because the
/// webview can't load `file://`.
///
/// **Security.** The path must be on `AppState.drop_allowlist`, which only the Rust drop listener
/// in `lib.rs` fills. Each entry is used up on success, so one drop allows one copy; any other path
/// gets `InvalidPath`.
#[tauri::command]
pub async fn copy_path_into_notebox(
    source_path: String,
    placement: Option<IncomingPlacement>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let src = PathBuf::from(&source_path);
    // The path must come from a recent OS drop (see `lib.rs`), so a path from
    // the frontend alone is rejected even if it exists.
    if !state.consume_drop_path(&src) {
        return Err(InkyCapError::InvalidPath(format!(
            "path was not part of a recent drag-drop and cannot be copied: {}",
            source_path
        )));
    }
    if !src.exists() {
        return Err(InkyCapError::InvalidPath(format!(
            "Source file does not exist: {}",
            source_path
        )));
    }
    let filename = src
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| {
            InkyCapError::InvalidPath(format!("Source has no filename: {}", source_path))
        })?;
    // Async read — copied source files can be large media; don't block the
    // async worker on the read.
    let data = tokio::fs::read(&src).await?;
    let placement = placement.unwrap_or_default();
    write_incoming_file(&filename, &data, &placement, &app, &session).await
}

/// Pick files with the native dialog and copy them into the attachments folder.
/// Returns their notebox-relative paths.
///
/// **Security.** No allowlist is needed: the paths come from a dialog run here,
/// which the frontend can't forge.
#[tauri::command]
pub async fn pick_and_upload_to_attachments(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    use tauri_plugin_dialog::DialogExt;

    let app_for_picker = app.clone();
    // Start in the home folder rather than the working directory (the build
    // folder under `tauri dev`).
    let home_dir = app.path().home_dir().ok();
    let picked = tokio::task::spawn_blocking(move || {
        let mut builder = app_for_picker.dialog().file();
        if let Some(home) = home_dir {
            builder = builder.set_directory(home);
        }
        builder.blocking_pick_files()
    })
    .await
    .map_err(|e| InkyCapError::Io(std::io::Error::other(format!("dialog join error: {e}"))))?;

    let Some(picked) = picked else {
        return Ok(Vec::new()); // user cancelled
    };

    let mut saved = Vec::with_capacity(picked.len());
    for fp in picked {
        let pb: PathBuf = fp
            .into_path()
            .map_err(|e| InkyCapError::InvalidPath(format!("invalid file path: {e}")))?;
        if !pb.is_file() {
            return Err(InkyCapError::InvalidPath(format!(
                "selection is not a regular file: {}",
                pb.display()
            )));
        }
        let filename = pb
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .ok_or_else(|| {
                InkyCapError::InvalidPath(format!("source has no filename: {}", pb.display()))
            })?;
        let data = tokio::fs::read(&pb).await?;
        let rel = write_incoming_file(
            &filename,
            &data,
            &IncomingPlacement::default(),
            &app,
            &session,
        )
        .await?;
        saved.push(rel);
    }
    Ok(saved)
}

/// Pick a `.csl` style and return its notebox-root path (`/styles/<file>.csl`)
/// for `citations.custom_csl_path`, or `None` if cancelled.
///
/// The Typst compiler only reads files inside the notebox, so a style elsewhere
/// is copied into `styles/`; one already inside is used in place. The dialog
/// runs here, so the frontend can't forge the path.
#[tauri::command]
pub async fn import_csl_style(
    title: String,
    filter_name: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    use tauri_plugin_dialog::DialogExt;

    // Start the picker in the notebox root (encouraging in-notebox styles),
    // falling back to the user's home directory.
    let root = session.notebox_root.read().await.clone();
    let start_dir = root.clone().or_else(|| app.path().home_dir().ok());

    let app_for_picker = app.clone();
    let picked = tokio::task::spawn_blocking(move || {
        let mut builder = app_for_picker
            .dialog()
            .file()
            .set_title(title)
            .add_filter(filter_name, &["csl"]);
        if let Some(dir) = start_dir {
            builder = builder.set_directory(dir);
        }
        builder.blocking_pick_file()
    })
    .await
    .map_err(|e| InkyCapError::Io(std::io::Error::other(format!("dialog join error: {e}"))))?;

    let Some(picked) = picked else {
        return Ok(None); // user cancelled
    };

    let pb: PathBuf = picked
        .into_path()
        .map_err(|e| InkyCapError::InvalidPath(format!("invalid file path: {e}")))?;
    if !pb.is_file() {
        return Err(InkyCapError::InvalidPath(format!(
            "selection is not a regular file: {}",
            pb.display()
        )));
    }

    // If the chosen file already lives inside the notebox, reference it in
    // place rather than copying — it already travels with the notebox.
    if let Some(ref root) = root {
        if let Ok(canonical) = std::fs::canonicalize(&pb) {
            if let Ok(rel) = canonical.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                return Ok(Some(format!("/{rel}")));
            }
        }
    }

    let filename = pb
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| {
            InkyCapError::InvalidPath(format!("source has no filename: {}", pb.display()))
        })?;
    let data = tokio::fs::read(&pb).await?;
    let rel = write_into_notebox_subfolder("styles", &filename, &data, &app, &session).await?;
    // Stored notebox-root-absolute so it injects as `style: "/styles/foo.csl"`
    // and resolves against the notebox root in the Typst compile World.
    Ok(Some(format!("/{rel}")))
}

/// A file chosen in [`pick_files_for_import`]: its path and whether it is
/// Markdown (offered for conversion). Other files are copied as attachments.
#[derive(serde::Serialize)]
pub struct PickedImportFile {
    pub path: String,
    pub is_markdown: bool,
}

/// True when `path` has a markdown extension (`.md` / `.markdown`).
fn is_markdown_file(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown")
    )
}

/// Pick files with the native dialog and return them with a Markdown flag,
/// without copying. Each path is put on the drop allowlist so the frontend's
/// follow-up [`copy_path_into_notebox`] or [`import_markdown_file`] call is
/// authorized for that path only. Splitting the steps lets the frontend ask
/// whether to convert Markdown. Allowlist entries are single-use and expire.
#[tauri::command]
pub async fn pick_files_for_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<PickedImportFile>, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    use tauri_plugin_dialog::DialogExt;

    let app_for_picker = app.clone();
    let home_dir = app.path().home_dir().ok();
    let picked = tokio::task::spawn_blocking(move || {
        let mut builder = app_for_picker.dialog().file();
        if let Some(home) = home_dir {
            builder = builder.set_directory(home);
        }
        builder.blocking_pick_files()
    })
    .await
    .map_err(|e| InkyCapError::Io(std::io::Error::other(format!("dialog join error: {e}"))))?;

    let Some(picked) = picked else {
        return Ok(Vec::new()); // user cancelled
    };

    let mut out = Vec::with_capacity(picked.len());
    for fp in picked {
        let pb: PathBuf = fp
            .into_path()
            .map_err(|e| InkyCapError::InvalidPath(format!("invalid file path: {e}")))?;
        if !pb.is_file() {
            return Err(InkyCapError::InvalidPath(format!(
                "selection is not a regular file: {}",
                pb.display()
            )));
        }
        let is_markdown = is_markdown_file(&pb);
        // Allow the normalized form the frontend will send back, not `pb`; on
        // Windows the two differ.
        let frontend_path = to_frontend_string(&pb);
        state.register_drop_paths(std::iter::once(PathBuf::from(&frontend_path)));
        out.push(PickedImportFile {
            path: frontend_path,
            is_markdown,
        });
    }
    Ok(out)
}

/// Convert a Markdown file, by absolute path, into a `.typ` note at the notebox
/// root and return its notebox-relative path. Uses the same conversion as the
/// archive importer; referenced images go to the attachments folder.
///
/// **Security.** As with [`copy_path_into_notebox`], the path must be on the
/// drop allowlist (from a drop or [`pick_files_for_import`]).
#[tauri::command]
pub async fn import_markdown_file(
    source_path: String,
    placement: Option<IncomingPlacement>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let src = PathBuf::from(&source_path);
    if !state.consume_drop_path(&src) {
        return Err(InkyCapError::InvalidPath(format!(
            "path was not part of a recent drag-drop or import and cannot be imported: {}",
            source_path
        )));
    }
    if !src.is_file() {
        return Err(InkyCapError::InvalidPath(format!(
            "Source file does not exist: {}",
            source_path
        )));
    }
    let text = tokio::fs::read_to_string(&src).await?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Imported note".to_string());
    let placement = placement.unwrap_or_default();
    convert_markdown_into_notebox(&text, &stem, src.parent(), &placement, &app, &session).await
}

/// Convert Markdown text (base64 UTF-8) into a `.typ` note per `placement` and return its
/// notebox-relative path. For drops on Windows, which give bytes rather than a path, so no
/// allowlist applies. Referenced images can't be found without a source folder and are left for the
/// user to fix.
#[tauri::command]
pub async fn import_markdown_text(
    filename: String,
    content_base64: String,
    placement: Option<IncomingPlacement>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| InkyCapError::InvalidPath(format!("Invalid base64: {}", e)))?;
    let text = String::from_utf8(bytes)
        .map_err(|e| InkyCapError::InvalidPath(format!("markdown file is not valid UTF-8: {e}")))?;
    let stem = std::path::Path::new(&filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Imported note".to_string());
    let placement = placement.unwrap_or_default();
    convert_markdown_into_notebox(&text, &stem, None, &placement, &app, &session).await
}

/// Convert Markdown `text` into a `.typ` note named `stem` in the folder `placement`
/// picks, refresh the tree and return its notebox-relative path. `sibling_dir`, when
/// given, is searched for referenced images.
async fn convert_markdown_into_notebox(
    text: &str,
    stem: &str,
    sibling_dir: Option<&std::path::Path>,
    placement: &IncomingPlacement,
    app: &tauri::AppHandle,
    session: &NoteboxSession,
) -> Result<String, InkyCapError> {
    let root = {
        let g = session.notebox_root.read().await;
        g.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?.clone()
    };
    let attachment_folder = session
        .notebox_settings
        .read()
        .await
        .files
        .attachment_folder
        .clone();
    let note_folder = incoming_folder(app, session, placement, true).await;
    // The folder comes from settings or the frontend, so make sure it can't
    // point outside the notebox.
    validate_notebox_path(&root, &root.join(&note_folder))?;

    let (rel, result) = crate::markdown::notebox_import::import_single_markdown(
        text,
        stem,
        &root,
        &note_folder,
        sibling_dir,
        crate::markdown::md_to_typst::MarkdownDialect::Standard,
        attachment_folder,
    )
    .map_err(|e| InkyCapError::Io(std::io::Error::other(e)))?;

    for err in &result.errors {
        log::warn!("[import-markdown] asset issue: {err}");
    }

    // The file watcher indexes new `.typ` files, but emit explicitly so the
    // tree updates immediately — same reasoning as `write_incoming_file`.
    publish(
        app,
        Audience::Window(&session.owner_label),
        AppEvent::FileCreated {
            path: root.join(&rel),
        },
    );
    Ok(rel)
}

/// Write a file brought in from outside the notebox under `filename`, finding
/// a collision-free name, and return its notebox-relative path. The folder
/// follows `placement` (see [`crate::commands::file_placement`]).
async fn write_incoming_file(
    filename: &str,
    data: &[u8],
    placement: &IncomingPlacement,
    app: &tauri::AppHandle,
    session: &NoteboxSession,
) -> Result<String, InkyCapError> {
    let is_note = std::path::Path::new(filename)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("typ"));
    let folder = incoming_folder(app, session, placement, is_note).await;
    write_into_notebox_subfolder(&folder, filename, data, app, session).await
}

/// Write `data` to `subfolder` under a collision-free version of `filename` and
/// return the notebox-relative path with forward slashes. Used for attachments
/// and CSL styles.
async fn write_into_notebox_subfolder(
    subfolder: &str,
    filename: &str,
    data: &[u8],
    app: &tauri::AppHandle,
    session: &NoteboxSession,
) -> Result<String, InkyCapError> {
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    // Reject file names that escape the folder (e.g. `../../evil.png`).
    let basename = std::path::Path::new(filename)
        .file_name()
        .ok_or_else(|| InkyCapError::InvalidPath(format!("invalid filename: {filename}")))?;
    if basename != std::ffi::OsStr::new(filename) {
        return Err(InkyCapError::InvalidPath(format!(
            "filename must not contain path separators: {filename}"
        )));
    }

    let attach_dir = root.join(subfolder);
    // Validate the target folder is inside the notebox — protects against a
    // malicious settings file with an absolute / traversal path.
    let attach_dir = validate_notebox_path(&root, &attach_dir)?;
    tokio::fs::create_dir_all(&attach_dir).await?;

    let mut target = attach_dir.join(filename);
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string());
    let ext = target
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    let mut counter = 1;
    while target.exists() {
        target = attach_dir.join(format!("{} {}{}", stem, counter, ext));
        counter += 1;
    }

    // Re-validate the final target after collision resolution.
    let target = validate_notebox_path(&root, &target)?;
    tokio::fs::write(&target, data).await?;

    // The watcher only tracks notes, so refresh the tree for attachments here.
    publish(
        app,
        Audience::Window(&session.owner_label),
        AppEvent::FileCreated {
            path: target.clone(),
        },
    );

    // Return the notebox-relative path (e.g. `assets/Screenshot.png`) so
    // callers can write `#image("/assets/...")`.
    let saved_relative = target
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| {
            target
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| filename.to_string())
        });

    Ok(saved_relative)
}

/// Create a new folder.
#[tauri::command]
pub async fn create_folder(
    name: String,
    parent: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let parent_dir = if parent.is_empty() {
        root.clone()
    } else {
        root.join(&parent)
    };

    let folder_path = parent_dir.join(&name);
    if storage.exists(&folder_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Folder already exists: {}",
            folder_path.display()
        )));
    }

    storage.create_dir(&folder_path).await?;
    Ok(to_frontend_string(&folder_path))
}

/// True for a Typst note (`.typ`). Rename steps that read the file as text,
/// reindex it or rewrite its links apply only to notes; reading a binary
/// attachment as text would fail after the rename succeeded.
fn is_note_file(path: &std::path::Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("typ")
}

/// The new file name with the original extension, which is re-added unless the
/// new name already ends with it. A name containing a dot ("3.1 - Plan") is not
/// taken as a new extension. A rename can't change a file's type.
fn preserve_extension(new_name: String, old: &std::path::Path, is_dir: bool) -> String {
    if is_dir {
        return new_name;
    }
    let Some(ext) = old.extension().and_then(|e| e.to_str()) else {
        return new_name;
    };
    let suffix = format!(".{ext}");
    if new_name
        .to_ascii_lowercase()
        .ends_with(&suffix.to_ascii_lowercase())
    {
        new_name
    } else {
        format!("{new_name}{suffix}")
    }
}

/// After a rename or move, point bookmarks at the new location, save them and
/// refresh the Bookmarks pane. Bookmarks store frontend-form paths, so `old`
/// and `new` are normalized with `to_frontend_string` first.
pub(crate) async fn rebase_bookmarks_for_rename(
    state: &AppState,
    window: &tauri::WebviewWindow,
    old: &std::path::Path,
    new: &std::path::Path,
) {
    let mut bookmarks = state.bookmarks.write().await;
    let changed = crate::bookmarks::rewrite_paths_for_rename(
        &mut bookmarks,
        &to_frontend_string(old),
        &to_frontend_string(new),
    );
    if !changed {
        return;
    }
    if let Err(e) = crate::bookmarks::save_bookmarks(&bookmarks) {
        log::warn!("failed to persist bookmarks after rename: {e}");
    }
    drop(bookmarks);
    publish(
        window.app_handle(),
        Audience::AllWindows,
        AppEvent::BookmarksChanged,
    );
}

/// Rename a file (simple rename, no link updates).
#[tauri::command]
pub async fn rename_file(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let old = sanitize_notebox_arg(&old_path)?;
    let is_dir = storage.resolve_path(&old)?.is_dir();
    let parent = old
        .parent()
        .ok_or_else(|| InkyCapError::InvalidPath("No parent directory".to_string()))?;

    let new_name_with_ext = preserve_extension(new_name, &old, is_dir);

    let new_path = parent.join(&new_name_with_ext);
    if storage.exists(&new_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Already exists: {}",
            new_path.display()
        )));
    }

    storage.rename_file(&old, &new_path).await?;

    if is_dir {
        reindex_directory(&old, &new_path, &storage, &session).await;
    } else {
        // Index updates apply to notes only (see `is_note_file`).
        if is_note_file(&old) {
            remove_from_indices(&old, &session).await;
        }
        if is_note_file(&new_path) {
            let content = storage.read_file(&new_path).await?;
            reindex_note(&new_path, &content, &session).await;
        }
    }

    rebase_bookmarks_for_rename(&state, &window, &old, &new_path).await;

    Ok(to_frontend_string(&new_path))
}

/// Rename a file or folder and update all wikilinks that reference it.
#[tauri::command]
pub async fn rename_and_update_links(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let old = sanitize_notebox_arg(&old_path)?;
    let is_dir = storage.resolve_path(&old)?.is_dir();

    let parent = old
        .parent()
        .ok_or_else(|| InkyCapError::InvalidPath("No parent directory".to_string()))?;

    let new_name_with_ext = preserve_extension(new_name, &old, is_dir);

    let new_path = parent.join(&new_name_with_ext);
    if storage.exists(&new_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Already exists: {}",
            new_path.display()
        )));
    }

    // Update references in other notes. Order relative to the rename doesn't
    // matter, since only other files change.
    if !is_dir {
        if is_note_file(&old) {
            // A note is referenced by wikilinks. Rewrite those in referencing
            // notes, then rebase this note's own path arguments.
            rewrite_backlinks_for_rename(&old, &new_path, &storage, &session).await?;
            // Make this note's relative path arguments notebox-root-absolute,
            // anchored at its current folder, so they survive a later move.
            rebase_paths_for_note_move(&old, &storage).await?;
        } else {
            // An attachment is referenced by path-bearing calls
            // (`#image`/`#read`/`#bibliography`). Repoint them at the new name.
            rewrite_attachment_references_for_rename(&old, &new_path, &storage, &session).await?;
        }
    }

    storage.rename_file(&old, &new_path).await?;

    if is_dir {
        reindex_directory(&old, &new_path, &storage, &session).await;
    } else {
        // Index updates are note-only (see the matching block in `rename_file`).
        if is_note_file(&old) {
            remove_from_indices(&old, &session).await;
        }
        if is_note_file(&new_path) {
            let content = storage.read_file(&new_path).await?;
            reindex_note(&new_path, &content, &session).await;
        }
    }

    rebase_bookmarks_for_rename(&state, &window, &old, &new_path).await;

    Ok(to_frontend_string(&new_path))
}

/// Move a file to a different folder.
#[tauri::command]
pub async fn move_file(
    old_path: String,
    new_folder: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let old = sanitize_notebox_arg(&old_path)?;
    let filename = old
        .file_name()
        .ok_or_else(|| InkyCapError::InvalidPath("No filename".to_string()))?;

    let new_dir = if new_folder.is_empty() {
        root.clone()
    } else {
        root.join(&new_folder)
    };

    let new_path = new_dir.join(filename);
    if storage.exists(&new_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "File already exists: {}",
            new_path.display()
        )));
    }

    // Ensure target directory exists
    storage.create_dir(&new_dir).await?;

    // Make the note's relative path arguments notebox-root-absolute, anchored
    // at its old folder, so `image("daisy.png")` keeps resolving. Always runs
    // on a move, regardless of `auto_update_links_on_rename`.
    rebase_paths_for_note_move(&old, &storage).await?;

    storage.rename_file(&old, &new_path).await?;

    // Update indices
    let content = storage.read_file(&new_path).await?;
    remove_from_indices(&old, &session).await;
    reindex_note(&new_path, &content, &session).await;

    rebase_bookmarks_for_rename(&state, &window, &old, &new_path).await;

    Ok(to_frontend_string(&new_path))
}

/// Move a folder and its contents to another parent. Wikilinks resolve by note
/// name, so they are unaffected. Each contained note's relative `image()` /
/// `read()` / `bibliography()` paths are made notebox-root-absolute before the
/// move, as `move_file` does for one note.
#[tauri::command]
pub async fn move_folder(
    old_path: String,
    new_parent: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?;

    let old = sanitize_notebox_arg(&old_path)?;
    let old_abs = storage.resolve_path(&old)?;
    if !old_abs.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "Not a folder: {}",
            old.display()
        )));
    }

    let folder_name = old
        .file_name()
        .ok_or_else(|| InkyCapError::InvalidPath("No folder name".to_string()))?;

    let new_dir = if new_parent.is_empty() {
        root.clone()
    } else {
        root.join(&new_parent)
    };
    let new_path = new_dir.join(folder_name);

    // Refuse to move a folder into itself or a descendant.
    if new_dir.starts_with(&old_abs) {
        return Err(InkyCapError::InvalidPath(
            "Cannot move a folder into itself".to_string(),
        ));
    }

    if storage.exists(&new_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Folder already exists: {}",
            new_path.display()
        )));
    }

    // Ensure the destination parent exists before the rename.
    storage.create_dir(&new_dir).await?;

    // Rebase paths while the notes are still in their old folder.
    let notes = storage.list_files(&old, "*.typ").await.unwrap_or_default();
    for note in &notes {
        rebase_paths_for_note_move(note, &storage).await?;
    }

    storage.rename_file(&old, &new_path).await?;

    reindex_directory(&old, &new_path, &storage, &session).await;

    rebase_bookmarks_for_rename(&state, &window, &old, &new_path).await;

    Ok(to_frontend_string(&new_path))
}

/// Delete a file by moving it to the system trash.
#[tauri::command]
pub async fn delete_file(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;

    storage.move_to_trash(&path_buf).await?;
    remove_from_indices(&path_buf, &session).await;

    Ok(())
}

/// Delete a folder by moving it to the system trash.
#[tauri::command]
pub async fn delete_folder(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    if session.is_documentation() {
        return Err(InkyCapError::DocumentationReadOnly);
    }
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(&path)?;

    // Remove all indexed notes within this folder
    let notes_in_folder: Vec<PathBuf> = {
        let pi = session.property_index.read().await;
        pi.notes
            .keys()
            .filter(|p| p.starts_with(&path_buf))
            .cloned()
            .collect()
    };
    for note_path in &notes_in_folder {
        remove_from_indices(note_path, &session).await;
    }

    storage.move_to_trash(&path_buf).await?;
    Ok(())
}

// ── Helpers ──

/// Rewrite wikilinks so they still resolve after `old_stem` is renamed to
/// `new_stem`. Handles both forms:
///
///   - `[[old_stem]]`, `[[old_stem#heading]]`, `[[old_stem|alias]]`
///   - `#wikilink("old_stem")`, with or without `display:` / `label:`
///
/// Per CLAUDE.md's Typst-first principle, an AST rewrite would be preferable,
/// but reparsing every backlinking note on each rename is much heavier than
/// scanning for two known prefixes. The call pattern matches `WIKILINK_CALL_RE`
/// in `src/editor/typst-decorations/wikilink-suggest.ts`.
pub(crate) fn update_wikilinks_in_content(content: &str, old_stem: &str, new_stem: &str) -> String {
    let after_brackets = rewrite_bracket_wikilinks(content, old_stem, new_stem);
    let after_calls = rewrite_first_arg_calls(&after_brackets, "#wikilink(\"", old_stem, new_stem);
    // `link-ref("…")` values in `#note(...)` properties (e.g. `derived-from`)
    // are links too. They sit in code, so they carry no `#`.
    rewrite_first_arg_calls(&after_calls, "link-ref(\"", old_stem, new_stem)
}

fn rewrite_bracket_wikilinks(content: &str, old_stem: &str, new_stem: &str) -> String {
    let old_lower = old_stem.to_lowercase();
    let mut result = String::with_capacity(content.len());
    let mut remaining = content;

    while let Some(start) = remaining.find("[[") {
        result.push_str(&remaining[..start + 2]);
        remaining = &remaining[start + 2..];

        if let Some(end) = remaining.find("]]") {
            let link_content = &remaining[..end];

            let (target, suffix) = if let Some(hash_pos) = link_content.find('#') {
                (&link_content[..hash_pos], &link_content[hash_pos..])
            } else if let Some(pipe_pos) = link_content.find('|') {
                (&link_content[..pipe_pos], &link_content[pipe_pos..])
            } else {
                (link_content, "")
            };

            if target.trim().to_lowercase() == old_lower {
                result.push_str(new_stem);
                result.push_str(suffix);
            } else {
                result.push_str(link_content);
            }

            result.push_str("]]");
            remaining = &remaining[end + 2..];
        } else {
            break;
        }
    }

    result.push_str(remaining);
    result
}

/// Rewrite the first string argument of calls starting with `prefix` (e.g.
/// `#wikilink("`) when it matches `old_stem` (case-insensitive), keeping other
/// arguments. A prefix without `#` straight after a letter, digit, `-` or `_`
/// is part of a longer name (`my-link-ref(`) and is skipped; a `#` prefix
/// always starts a call (`参见#wikilink("…")`).
fn rewrite_first_arg_calls(content: &str, prefix: &str, old_stem: &str, new_stem: &str) -> String {
    let old_lower = old_stem.to_lowercase();
    let escaped_new = typst_string_escape(new_stem);

    let mut result = String::with_capacity(content.len());
    let mut remaining = content;

    let check_longer_name = !prefix.starts_with('#');

    while let Some(start) = remaining.find(prefix) {
        let part_of_longer_name = check_longer_name
            && remaining[..start]
                .chars()
                .next_back()
                .or_else(|| result.chars().next_back())
                .is_some_and(|c| c.is_alphanumeric() || c == '-' || c == '_');
        result.push_str(&remaining[..start + prefix.len()]);
        remaining = &remaining[start + prefix.len()..];
        if part_of_longer_name {
            continue;
        }

        // Find the closing quote of the first argument, honouring `\"`
        // and `\\` escapes the same way Typst's parser does.
        let mut end_quote: Option<usize> = None;
        let bytes = remaining.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' if i + 1 < bytes.len() => i += 2,
                b'"' => {
                    end_quote = Some(i);
                    break;
                }
                b'\n' => break, // unterminated string — bail out conservatively
                _ => i += 1,
            }
        }

        let Some(eq) = end_quote else {
            result.push_str(remaining);
            return result;
        };

        let raw_name = &remaining[..eq];
        let decoded = typst_string_unescape(raw_name);
        if decoded.to_lowercase() == old_lower {
            result.push_str(&escaped_new);
        } else {
            result.push_str(raw_name);
        }
        result.push('"');
        remaining = &remaining[eq + 1..];
    }

    result.push_str(remaining);
    result
}

/// Escape a string for a Typst `"..."` literal (`\\` and `"`). Mirrors
/// `typstStringEscape` in [src/lib/typst.ts].
fn typst_string_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

/// Inverse of [`typst_string_escape`]. Used only to compare the first
/// argument of an existing `#wikilink("...")` against `old_stem`.
fn typst_string_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Rewrite relative paths in the note's `image` / `read` / `bibliography` calls
/// to notebox-root-absolute paths, anchored at its current folder, so they
/// survive the move. Called before the move, so the file is written once.
///
/// No-op without relative paths. Write errors are returned; read errors are
/// logged and the move continues.
pub(crate) async fn rebase_paths_for_note_move(
    old_path: &std::path::Path,
    storage: &std::sync::Arc<crate::storage::local::LocalNoteboxStorage>,
) -> Result<(), InkyCapError> {
    let content = match storage.read_file(old_path).await {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "rebase_paths_for_note_move: cannot read {}: {} — skipping rebase",
                old_path.display(),
                e
            );
            return Ok(());
        }
    };

    // Callers pass absolute or relative paths; `rebase_relative_paths` needs a
    // notebox-relative parent and does nothing with an absolute one.
    let notebox_relative = notebox_relative_path(old_path, storage);
    let note_dir = notebox_relative
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    let rewritten = rebase_relative_paths(&content, &note_dir);
    if rewritten == content {
        return Ok(());
    }

    storage.write_file(old_path, &rewritten).await?;
    Ok(())
}

/// A caller path in notebox-relative form: the storage root (canonical or
/// declared) is stripped from an absolute path; a relative one is returned as
/// is.
pub(crate) fn notebox_relative_path(
    path: &std::path::Path,
    storage: &crate::storage::local::LocalNoteboxStorage,
) -> std::path::PathBuf {
    if path.is_relative() {
        return path.to_path_buf();
    }
    if let Ok(rel) = path.strip_prefix(storage.canonical_root()) {
        return rel.to_path_buf();
    }
    if let Ok(rel) = path.strip_prefix(storage.root()) {
        return rel.to_path_buf();
    }
    path.to_path_buf()
}

/// Rewrite the wikilinks in every note linking to `old_path` to point at
/// `new_path`, and reindex those notes. Used by the rename command (before the
/// move) and the watcher (after an external rename); only the linking notes
/// change, so order doesn't matter.
pub(crate) async fn rewrite_backlinks_for_rename(
    old_path: &std::path::Path,
    new_path: &std::path::Path,
    storage: &std::sync::Arc<crate::storage::local::LocalNoteboxStorage>,
    session: &NoteboxSession,
) -> Result<(), InkyCapError> {
    // `note_stem`, not `file_stem()`, which cuts "3.5 - Name.typ" at the first
    // dot.
    let old_stem = crate::link_index::note_stem(old_path);
    let new_stem = crate::link_index::note_stem(new_path);
    if old_stem.is_empty() || new_stem.is_empty() {
        return Ok(());
    }
    if old_stem.eq_ignore_ascii_case(&new_stem) {
        return Ok(());
    }

    let backlinks = {
        let link_index = session.link_index.read().await;
        link_index.get_backlinks(&old_path.to_path_buf())
    };

    for referencing_path in &backlinks {
        let Ok(content) = storage.read_file(referencing_path).await else {
            continue;
        };
        let updated = update_wikilinks_in_content(&content, &old_stem, &new_stem);
        if updated != content {
            storage.write_file(referencing_path, &updated).await?;
            session.reindex_note(referencing_path, &updated).await;
        }
    }

    Ok(())
}

/// Notebox-relative path joined with `/`, the form Typst path arguments use, on
/// every OS. Empty for the root.
fn notebox_rel_forward_slash(
    path: &std::path::Path,
    storage: &crate::storage::local::LocalNoteboxStorage,
) -> String {
    notebox_relative_path(path, storage)
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// When an attachment is renamed, update every note that references it through
/// `#image`, `#read` or `#bibliography` (wikilinks never point at attachments).
///
/// Scans every note once rather than keeping an attachment index, since renames
/// are rare; a basename check skips notes that can't match. Like the folder
/// migration in `attachment_migration.rs`.
async fn rewrite_attachment_references_for_rename(
    old: &std::path::Path,
    new_path: &std::path::Path,
    storage: &std::sync::Arc<crate::storage::local::LocalNoteboxStorage>,
    session: &NoteboxSession,
) -> Result<(), InkyCapError> {
    let old_rel = notebox_rel_forward_slash(old, storage);
    let new_rel = notebox_rel_forward_slash(new_path, storage);
    if old_rel.is_empty() || old_rel == new_rel {
        return Ok(());
    }
    let basename = old
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    // Scan + rewrite is a pure storage operation (see the helper); the only
    // session-bound work is writing back and reindexing the notes that changed.
    let changes =
        collect_attachment_reference_rewrites(storage, &old_rel, &new_rel, &basename).await;
    for (rel, rewritten) in changes {
        storage.write_file(&rel, &rewritten).await?;
        session.reindex_note(&rel, &rewritten).await;
    }
    Ok(())
}

/// Find notes whose `#image` / `#read` / `#bibliography` calls reference
/// `old_rel` and compute their rewritten source pointing at `new_rel`. Returns
/// each changed note's path and content; only changed notes are kept in memory.
/// Separate from reindexing so it can be tested with just a storage.
async fn collect_attachment_reference_rewrites(
    storage: &crate::storage::local::LocalNoteboxStorage,
    old_rel: &str,
    new_rel: &str,
    basename: &str,
) -> Vec<(std::path::PathBuf, String)> {
    let notes = storage
        .list_files(&std::path::PathBuf::from(""), "*.typ")
        .await
        .unwrap_or_default();
    // `list_files` returns canonical absolute paths; use the notebox-relative
    // form for reads and writes.
    let strip_root = storage.canonical_root();
    let mut changes = Vec::new();

    for note_abs in notes {
        let rel = note_abs
            .strip_prefix(strip_root)
            .map(|r| r.to_path_buf())
            .unwrap_or_else(|_| note_abs.clone());
        let content = match storage.read_file(&rel).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Every reference to the file contains its basename, so skip notes that
        // don't.
        if !basename.is_empty() && !content.contains(basename) {
            continue;
        }
        let note_dir = rel.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let rewritten = rewrite_referenced_path(&content, old_rel, new_rel, &note_dir);
        if rewritten != content {
            changes.push((rel, rewritten));
        }
    }
    changes
}

/// Shorthand for `NoteboxSession::reindex_note`, which every note change in
/// this module goes through.
async fn reindex_note(path: &std::path::Path, content: &str, session: &NoteboxSession) {
    session.reindex_note(path, content).await;
}

/// Shorthand for `remove_from_indices` on the session.
async fn remove_from_indices(path: &std::path::Path, session: &NoteboxSession) {
    session.remove_from_indices(path).await;
}

async fn reindex_directory(
    old_dir: &std::path::Path,
    new_dir: &std::path::Path,
    storage: &std::sync::Arc<crate::storage::local::LocalNoteboxStorage>,
    session: &NoteboxSession,
) {
    // List notes at the new location (renamed dir already exists on disk)
    let new_notes = storage
        .list_files(new_dir, "*.typ")
        .await
        .unwrap_or_default();
    let old_abs = storage
        .resolve_path(old_dir)
        .unwrap_or_else(|_| old_dir.to_path_buf());
    let new_abs = storage
        .resolve_path(new_dir)
        .unwrap_or_else(|_| new_dir.to_path_buf());

    // For each note under the new dir, compute what its old path was and remove that
    for new_note in &new_notes {
        if let Ok(suffix) = new_note.strip_prefix(&new_abs) {
            let old_note = old_abs.join(suffix);
            session.remove_from_indices(&old_note).await;
        }
        if let Ok(content) = storage.read_file(new_note).await {
            session.reindex_note(new_note, &content).await;
        }
    }
}

/// Open the containing directory of a path in the OS file manager.
#[tauri::command]
pub async fn show_in_explorer(path: String) -> Result<(), InkyCapError> {
    let p = PathBuf::from(&path);
    let dir = if p.is_file() {
        p.parent()
            .ok_or_else(|| InkyCapError::InvalidPath("No parent directory".into()))?
            .to_path_buf()
    } else {
        p
    };
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&dir).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&dir).spawn()?;
    }
    #[cfg(target_os = "windows")]
    {
        // Explorer only accepts backslash paths and otherwise opens Documents,
        // so convert the separators. (path-stringification-ok: subprocess
        // argument, not an IPC payload.)
        let native = dir.to_string_lossy().replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(&native)
            .spawn()?;
    }
    Ok(())
}

/// Open a file in the default application. Program files (see
/// [`crate::system_open::is_program_file`]) and anything outside the notebox,
/// including symlinks out of it, return `OpenProgramFile` or
/// `OpenOutsideNotebox` without opening; the frontend asks and calls again with
/// `confirmed: true`.
#[tauri::command]
pub async fn open_file_externally(
    path: String,
    confirmed: Option<bool>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(InkyCapError::InvalidPath(format!(
            "File does not exist: {path}"
        )));
    }
    if !confirmed.unwrap_or(false) {
        if crate::system_open::is_program_file(&p) {
            return Err(InkyCapError::OpenProgramFile(path));
        }
        let session = state.session(window.label()).await;
        let root = session.notebox_root.read().await;
        let inside = root
            .as_ref()
            .is_some_and(|r| validate_notebox_path(r, &p).is_ok());
        if !inside {
            return Err(InkyCapError::OpenOutsideNotebox(path));
        }
    }
    crate::system_open::open_path(&p)?;
    Ok(())
}

/// Open a URL in the OS default handler. App schemes (`zotero://`,
/// `obsidian://`) are supported along with `http(s)`, `mailto` and `tel`, so
/// notes can link into other apps.
///
/// Schemes that carry executable content, and `file:` URLs, are refused; local
/// files go through [`open_file_externally`]. The URL is passed as a single
/// argument, never through a shell, and a leading `-` is rejected so it can't
/// be read as a flag.
#[tauri::command]
pub async fn open_url_externally(url: String) -> Result<(), InkyCapError> {
    let trimmed = url.trim();

    if trimmed.starts_with('-') {
        return Err(InkyCapError::InvalidPath(format!(
            "Refusing to open suspicious URL: {trimmed}"
        )));
    }

    // A URL must start with `scheme:`; bare paths belong to open_file_externally.
    let scheme = trimmed
        .split_once(':')
        .map(|(s, _)| s.to_ascii_lowercase())
        .filter(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        })
        .ok_or_else(|| InkyCapError::InvalidPath(format!("Not a URL: {trimmed}")))?;

    const BLOCKED: &[&str] = &["javascript", "data", "vbscript", "file"];
    if BLOCKED.contains(&scheme.as_str()) {
        return Err(InkyCapError::InvalidPath(format!(
            "Refusing to open '{scheme}:' URL"
        )));
    }

    crate::system_open::open_url(trimmed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;
    use tempfile::TempDir;

    /// A note in a subfolder with a relative path to a sibling asset is
    /// rewritten to a notebox-root-absolute path; the asset is untouched.
    #[tokio::test]
    async fn rebase_paths_for_note_move_rewrites_relative_image() {
        let notebox = TempDir::new().unwrap();
        std::fs::create_dir_all(notebox.path().join("notes")).unwrap();
        let note_rel = std::path::Path::new("notes/foo.typ");
        let note_abs = notebox.path().join(note_rel);
        std::fs::write(
            &note_abs,
            "= Foo\n\n#image(\"daisy.png\")\n#read(\"data.csv\")\n",
        )
        .unwrap();

        let storage = Arc::new(
            crate::storage::local::LocalNoteboxStorage::new(notebox.path().to_path_buf()).unwrap(),
        );

        rebase_paths_for_note_move(note_rel, &storage)
            .await
            .expect("rebase should succeed");

        let after = std::fs::read_to_string(&note_abs).unwrap();
        assert!(
            after.contains("#image(\"/notes/daisy.png\")"),
            "expected absolute image path, got:\n{after}"
        );
        assert!(
            after.contains("#read(\"/notes/data.csv\")"),
            "expected absolute read path, got:\n{after}"
        );
    }

    /// `move_file` receives absolute paths from the frontend; they must still
    /// be rebased.
    #[tokio::test]
    async fn rebase_paths_for_note_move_handles_absolute_path_input() {
        let notebox = TempDir::new().unwrap();
        std::fs::create_dir_all(notebox.path().join("journal")).unwrap();
        let note_abs_pb = notebox.path().join("journal/jan.typ");
        std::fs::write(&note_abs_pb, "= Jan\n\n#image(\"daisy.png\")\n").unwrap();

        let storage = Arc::new(
            crate::storage::local::LocalNoteboxStorage::new(notebox.path().to_path_buf()).unwrap(),
        );

        rebase_paths_for_note_move(&note_abs_pb, &storage)
            .await
            .expect("rebase should succeed");

        let after = std::fs::read_to_string(&note_abs_pb).unwrap();
        assert!(
            after.contains("#image(\"/journal/daisy.png\")"),
            "expected absolute image path after rebase, got:\n{after}"
        );
    }

    /// A note with no relative paths is left untouched.
    #[tokio::test]
    async fn rebase_paths_for_note_move_no_op_when_already_absolute() {
        let notebox = TempDir::new().unwrap();
        std::fs::create_dir_all(notebox.path().join("notes")).unwrap();
        let note_rel = std::path::Path::new("notes/foo.typ");
        let note_abs = notebox.path().join(note_rel);
        let original = "= Foo\n\n#image(\"/assets/daisy.png\")\n";
        std::fs::write(&note_abs, original).unwrap();

        let storage = Arc::new(
            crate::storage::local::LocalNoteboxStorage::new(notebox.path().to_path_buf()).unwrap(),
        );

        rebase_paths_for_note_move(note_rel, &storage)
            .await
            .expect("rebase should succeed");

        let after = std::fs::read_to_string(&note_abs).unwrap();
        assert_eq!(after, original);
    }

    /// Renaming an attachment updates notes that reference it and leaves others
    /// alone.
    #[tokio::test]
    async fn attachment_rename_rewrites_referencing_notes() {
        // Use a non-hidden subfolder as the root: the temp dir is named
        // `.tmpXXXX`, and `list_files` skips hidden folders.
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        std::fs::create_dir_all(root.join("Assets")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        // Two referencers (one nested) plus a note that doesn't reference it.
        std::fs::write(root.join("a.typ"), "= A\n\n#image(\"/Assets/old.png\")\n").unwrap();
        std::fs::write(
            root.join("notes/b.typ"),
            "= B\n\nText #image(\"/Assets/old.png\", width: 50%) more.\n",
        )
        .unwrap();
        let unrelated = "= C\n\n#image(\"/Assets/other.png\")\n";
        std::fs::write(root.join("notes/c.typ"), unrelated).unwrap();

        let storage =
            Arc::new(crate::storage::local::LocalNoteboxStorage::new(root.clone()).unwrap());

        let changes = collect_attachment_reference_rewrites(
            &storage,
            "Assets/old.png",
            "Assets/new.png",
            "old.png",
        )
        .await;

        // Only the two referencing notes changed.
        assert_eq!(changes.len(), 2, "got: {changes:?}");
        for (rel, rewritten) in &changes {
            assert!(
                rewritten.contains("#image(\"/Assets/new.png\""),
                "note {} not repointed:\n{rewritten}",
                rel.display()
            );
            assert!(!rewritten.contains("old.png"), "stale ref in {rewritten}");
        }
        // The width arg on the nested reference is preserved.
        let nested = changes
            .iter()
            .find(|(rel, _)| rel.ends_with("notes/b.typ"))
            .expect("b.typ should be among the changes");
        assert!(
            nested.1.contains("#image(\"/Assets/new.png\", width: 50%)"),
            "named args must survive: {}",
            nested.1
        );
        // The unrelated note is not in the change set.
        assert!(
            !changes.iter().any(|(rel, _)| rel.ends_with("notes/c.typ")),
            "unrelated note must not be rewritten"
        );
    }

    #[test]
    fn test_update_wikilinks_simple() {
        let content = "See [[Old Note]] for details.";
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, "See [[New Note]] for details.");
    }

    #[test]
    fn test_update_wikilinks_with_heading() {
        let content = "See [[Old Note#Section]] for details.";
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, "See [[New Note#Section]] for details.");
    }

    #[test]
    fn test_update_wikilinks_with_alias() {
        let content = "See [[Old Note|my alias]] for details.";
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, "See [[New Note|my alias]] for details.");
    }

    #[test]
    fn test_update_wikilinks_case_insensitive() {
        let content = "See [[old note]] for details.";
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, "See [[New Note]] for details.");
    }

    #[test]
    fn test_update_wikilinks_no_match() {
        let content = "See [[Other Note]] for details.";
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, "See [[Other Note]] for details.");
    }

    #[test]
    fn test_update_wikilinks_multiple() {
        let content = "Start [[Old Note]] middle [[Old Note#heading]] end.";
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(
            result,
            "Start [[New Note]] middle [[New Note#heading]] end."
        );
    }

    #[test]
    fn test_update_wikilinks_link_ref_values() {
        let content = "#note(derived-from: (link-ref(\"Old Note\"), link-ref(\"Other\")), x: my-link-ref(\"Old Note\"))";
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(
            result,
            "#note(derived-from: (link-ref(\"New Note\"), link-ref(\"Other\")), x: my-link-ref(\"Old Note\"))"
        );
    }

    #[test]
    fn test_update_wikilinks_func_form_after_word() {
        // A `#` call is valid straight after text, as in scripts written
        // without spaces between words.
        let content = r#"参见#wikilink("Old Note")，x#wikilink("Old Note")"#;
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(
            result,
            r#"参见#wikilink("New Note")，x#wikilink("New Note")"#
        );
    }

    #[test]
    fn test_update_wikilinks_func_form_simple() {
        let content = r#"See #wikilink("Old Note") for details."#;
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, r#"See #wikilink("New Note") for details."#);
    }

    #[test]
    fn test_update_wikilinks_func_form_with_display() {
        let content = r#"See #wikilink("Old Note", display: "see this") for details."#;
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(
            result,
            r#"See #wikilink("New Note", display: "see this") for details."#
        );
    }

    #[test]
    fn test_update_wikilinks_func_form_with_label() {
        let content = r#"See #wikilink("Old Note", label: "old-anchor") here."#;
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(
            result,
            r#"See #wikilink("New Note", label: "old-anchor") here."#
        );
    }

    #[test]
    fn test_update_wikilinks_func_form_case_insensitive() {
        let content = r#"#wikilink("old note")"#;
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, r#"#wikilink("New Note")"#);
    }

    #[test]
    fn test_update_wikilinks_func_form_no_match() {
        let content = r#"#wikilink("Other Note")"#;
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(result, r#"#wikilink("Other Note")"#);
    }

    #[test]
    fn test_update_wikilinks_func_form_escapes_quote_in_new_name() {
        let content = r#"#wikilink("Old")"#;
        let result = update_wikilinks_in_content(content, "Old", r#"Has "quote""#);
        assert_eq!(result, r#"#wikilink("Has \"quote\"")"#);
    }

    #[test]
    fn test_update_wikilinks_func_form_handles_escaped_quote_in_old_name() {
        // The on-disk name contains a literal quote → Typst source has `\"`.
        let content = r#"#wikilink("Has \"quote\"")"#;
        let result = update_wikilinks_in_content(content, r#"Has "quote""#, "Clean");
        assert_eq!(result, r#"#wikilink("Clean")"#);
    }

    #[test]
    fn test_update_wikilinks_mixed_forms_in_same_file() {
        let content = r#"Inline [[Old Note]] and call #wikilink("Old Note", display: "x")."#;
        let result = update_wikilinks_in_content(content, "Old Note", "New Note");
        assert_eq!(
            result,
            r#"Inline [[New Note]] and call #wikilink("New Note", display: "x")."#
        );
    }

    #[test]
    fn test_update_wikilinks_func_form_multibyte_safe() {
        // Em-dash and accented chars in surrounding context — byte-index
        // bookkeeping must land on char boundaries.
        let content = r#"Préambule — voir #wikilink("Old") — fin."#;
        let result = update_wikilinks_in_content(content, "Old", "Nouveau");
        assert_eq!(result, r#"Préambule — voir #wikilink("Nouveau") — fin."#);
    }
}
