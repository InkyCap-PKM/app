// File management commands: create, rename, move, delete (trash).
// Rename-and-update-links walks backward links to update wikilinks in referencing files.

use std::path::PathBuf;

use tauri::{Emitter, State};

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::sanitize_vault_arg;
use crate::storage::traits::VaultStorage;
use crate::storage::validate_vault_path;

/// Copy a file (given as base64 data) to the attachment folder.
/// Returns the saved filename (may be renamed to avoid collisions).
#[tauri::command]
pub async fn copy_to_attachments(
    filename: String,
    data_base64: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    use base64::Engine;

    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| InkyCapError::InvalidPath(format!("Invalid base64: {}", e)))?;

    write_to_attachments(&filename, &data, &app, &state).await
}

/// Read file paths from the system clipboard. Used by the paste
/// handler when the user copies a file in the native file manager
/// and pastes it into the editor — webviews block cross-origin
/// reads of the clipboard's file targets, so we fetch them from
/// the Rust side via the OS's native clipboard API.
///
/// Per-platform:
///
/// - **Linux**: GTK3 `Clipboard::wait_for_uris` via the `gtk` crate
///   (already a dep for webview integration). GTK calls must run
///   on the main loop thread, so we marshal the call via
///   `AppHandle::run_on_main_thread` and send the result back via
///   a tokio oneshot channel.
///
/// - **macOS**: `NSPasteboard.readObjectsForClasses:[NSURL]` via
///   the `cocoa` + `objc` crates. NSPasteboard reads are safe from
///   any thread, so we call directly from a tokio blocking task.
///
/// - **Windows**: `OpenClipboard` + `GetClipboardData(CF_HDROP)` +
///   `DragQueryFileW` via `windows-sys`. Thread-safe for reads.
///
/// All three implementations are bundled in the binary — no
/// external tools, no shell-outs, nothing the end user needs to
/// install. Returns an empty vector if the clipboard has no file
/// entries, which the caller treats as "nothing special to do".
#[tauri::command]
pub async fn read_clipboard_file_paths(
    app: tauri::AppHandle,
) -> Result<Vec<String>, InkyCapError> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();
        app.run_on_main_thread(move || {
            let result = linux::read_clipboard_uris_blocking();
            let _ = tx.send(result);
        })
        .map_err(|e| {
            InkyCapError::InvalidPath(format!("run_on_main_thread failed: {}", e))
        })?;
        let paths = rx
            .await
            .map_err(|_| InkyCapError::InvalidPath("clipboard channel closed".into()))?;
        return Ok(paths);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let paths = tokio::task::spawn_blocking(macos::read_clipboard_uris_blocking)
            .await
            .map_err(|e| InkyCapError::InvalidPath(format!("clipboard task panicked: {}", e)))?;
        return Ok(paths);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let paths = tokio::task::spawn_blocking(win32::read_clipboard_uris_blocking)
            .await
            .map_err(|e| InkyCapError::InvalidPath(format!("clipboard task panicked: {}", e)))?;
        return Ok(paths);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(Vec::new())
    }
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
        // `wait_for_uris` returns `Vec<GString>` — empty if the
        // clipboard doesn't offer a URI target. Each entry is a
        // file:// URL; we convert to absolute paths via the same
        // helper used by drag-drop.
        let uris = clipboard.wait_for_uris();
        log::debug!("[clipboard] wait_for_uris returned {} URIs", uris.len());
        uris.into_iter()
            .filter_map(|u: gtk::glib::GString| super::parse_file_uri_line(u.as_str()))
            .collect()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! Read NSPasteboard via the Objective-C runtime. Asks the
    //! general pasteboard for any `NSURL` objects — that covers
    //! the standard "copy a file in Finder" case, whose pasteboard
    //! items advertise `public.file-url` and are readable as
    //! NSURL. Each URL's `.path` is a plain absolute path.
    //!
    //! NSPasteboard reads are safe from any thread, so the caller
    //! can dispatch this onto a tokio blocking task without the
    //! main-thread marshalling that the Linux/GTK path needs.

    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    pub fn read_clipboard_uris_blocking() -> Vec<String> {
        unsafe {
            let pb: id = msg_send![class!(NSPasteboard), generalPasteboard];
            if pb == nil {
                return Vec::new();
            }
            // `readObjectsForClasses:options:` wants an NSArray of
            // Class objects. In the Objective-C runtime, classes
            // are first-class objects, so we cast `class!(NSURL)`
            // to `id` and stuff it into a 1-element NSArray.
            let url_class: id = class!(NSURL) as *const _ as id;
            let classes: id = msg_send![class!(NSArray), arrayWithObject: url_class];
            let urls: id = msg_send![pb, readObjectsForClasses: classes options: nil];
            if urls == nil {
                return Vec::new();
            }
            let count: usize = msg_send![urls, count];
            log::debug!("[clipboard] NSPasteboard returned {} NSURLs", count);
            let mut out = Vec::with_capacity(count);
            for i in 0..count {
                let url: id = msg_send![urls, objectAtIndex: i];
                if url == nil {
                    continue;
                }
                // `-[NSURL path]` returns the absolute filesystem
                // path for file URLs, or nil for non-file URLs.
                let path: id = msg_send![url, path];
                if path == nil {
                    continue;
                }
                let c_str: *const std::os::raw::c_char = msg_send![path, UTF8String];
                if c_str.is_null() {
                    continue;
                }
                let s = std::ffi::CStr::from_ptr(c_str)
                    .to_string_lossy()
                    .into_owned();
                if !s.is_empty() {
                    out.push(s);
                }
            }
            out
        }
    }
}

#[cfg(target_os = "windows")]
mod win32 {
    //! Read the Win32 clipboard's CF_HDROP format via windows-sys.
    //! CF_HDROP carries a DROPFILES struct followed by a list of
    //! null-terminated wide-character paths — exactly the format
    //! populated when the user copies a file in Explorer. We use
    //! `DragQueryFileW` to iterate over the entries.
    //!
    //! Module is named `win32` (not `windows`) so it doesn't shadow
    //! the `windows_sys` crate's path inside this file.
    //!
    //! Win32 clipboard reads are safe from any thread once
    //! OpenClipboard succeeds, so the caller can dispatch this
    //! onto a tokio blocking task — no main-thread marshalling
    //! needed.

    use windows_sys::Win32::Foundation::{HGLOBAL, HWND};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_HDROP: u32 = 15;

    pub fn read_clipboard_uris_blocking() -> Vec<String> {
        unsafe {
            // OpenClipboard with a null HWND associates the
            // clipboard with the current task. Returns BOOL (i32);
            // zero means failure.
            let null_hwnd: HWND = std::ptr::null_mut();
            if OpenClipboard(null_hwnd) == 0 {
                log::debug!("[clipboard] OpenClipboard failed");
                return Vec::new();
            }
            // Wrap the body in a closure so we can guarantee
            // CloseClipboard runs even if the inner code returns
            // early. (We avoid a Drop guard struct because that
            // would need its own unsafe wrapper.)
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
                    // First pass: ask for the path length in chars
                    // excluding the terminator. Second pass: a
                    // buffer sized for length + 1.
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

/// Parse a single `file://...` line from a clipboard payload into
/// an absolute filesystem path. Returns None for non-file URIs.
fn parse_file_uri_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let rest = line.strip_prefix("file://")?;
    // Drop any authority component (host). For `file:///abs` the
    // path starts with `/` already. For `file://host/abs` we keep
    // everything after the host. This is simpler than a URL parser
    // and covers the cases we actually see in the wild.
    let path_part = match rest.find('/') {
        Some(i) => &rest[i..],
        None => rest,
    };
    Some(percent_decode(path_part))
}

/// Decode `%XX` escapes in a URI path. We don't pull in a URL
/// library for this — the only characters we care about in practice
/// are spaces (`%20`) and a handful of other ASCII punctuation.
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

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Copy a file from an absolute filesystem path into the attachment
/// folder. Used by drag-drop and paste handlers when the browser
/// gives us a `file://` URL or a `text/uri-list` entry instead of
/// an in-memory File object (which happens on Linux/GNOME when the
/// user drags from the native file manager). The file is read on
/// the Rust side — the webview cannot load `file://` resources on
/// its own due to its local-resource CSP.
///
/// **Security.** The frontend cannot pass an arbitrary path here: the
/// path must be on `AppState.drop_allowlist`, which is populated only
/// by the Rust-side `on_drag_drop_event` listener (see `lib.rs`). The
/// allowlist entry is consumed on success, so each OS drop authorizes
/// exactly one copy. A compromised renderer or future plugin that
/// calls this command with a path the user did not actually drop will
/// see `InvalidPath`.
#[tauri::command]
pub async fn copy_path_to_attachments(
    source_path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let src = PathBuf::from(&source_path);
    // SEC-1 gate (audit 2026-05-10): the path must come from a recent OS
    // drop event registered by the run-loop listener in `lib.rs` (which
    // subscribes to `RunEvent::WindowEvent::DragDrop`). Frontend-supplied
    // paths that bypass this (e.g. via XSS or a malicious plugin) are
    // rejected here even if they exist on disk.
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
    let data = std::fs::read(&src)?;
    write_to_attachments(&filename, &data, &app, &state).await
}

/// Write `data` into the vault's attachment folder under `filename`.
/// Finds a collision-free name and returns the saved name.
async fn write_to_attachments(
    filename: &str,
    data: &[u8],
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let vault_root = state.vault_root.read().await;
    let root = vault_root.as_ref().ok_or(InkyCapError::VaultNotOpen)?.clone();
    drop(vault_root);

    // Defense in depth: reject filenames that try to escape the attachment
    // folder (e.g. `../../evil.png`). Basename-only enforcement is enough
    // because the webview/drag-drop path only ever gives us a name, but
    // validating explicitly means a future caller can't accidentally bypass.
    let basename = std::path::Path::new(filename)
        .file_name()
        .ok_or_else(|| InkyCapError::InvalidPath(format!("invalid filename: {filename}")))?;
    if basename != std::ffi::OsStr::new(filename) {
        return Err(InkyCapError::InvalidPath(format!(
            "attachment filename must not contain path separators: {filename}"
        )));
    }

    let settings = state.settings.read().await;
    let attachment_folder = settings.files.attachment_folder.clone();
    drop(settings);

    let attach_dir = root.join(&attachment_folder);
    // Validate the attachment folder is inside the vault — protects against a
    // malicious settings file with an absolute / traversal path.
    let attach_dir = validate_vault_path(&root, &attach_dir)?;
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
    let target = validate_vault_path(&root, &target)?;
    tokio::fs::write(&target, data).await?;

    // The file watcher only tracks .typ/.collection files, so attachment
    // writes (images, PDFs, etc.) won't trigger a tree refresh on their
    // own. Emit the event directly so the frontend file tree updates.
    let _ = app.emit(
        "vault:file-created",
        serde_json::json!({ "path": target.display().to_string() }),
    );

    // Return the vault-root-relative path (e.g. `assets/Screenshot.png`)
    // rather than just the basename, so callers can build a Typst markup
    // string that resolves in the compiler — `#image("/assets/foo.png")`
    // works in both the visual editor (via the updated resolve_embed_path)
    // and the reading-view / export pipeline (via Typst's own
    // project-root-relative path semantics).
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

/// Create a new `.typ` file with the inkycap-vault import.
#[tauri::command]
pub async fn create_file(
    name: String,
    folder: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let vault_root = state.vault_root.read().await;
    let root = vault_root.as_ref().ok_or(InkyCapError::VaultNotOpen)?;

    let dir = if folder.is_empty() {
        root.clone()
    } else {
        root.join(&folder)
    };

    let filename = if name.ends_with(".typ") {
        name.clone()
    } else {
        format!("{}.typ", name)
    };

    let file_path = dir.join(&filename);
    if storage.exists(&file_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "File already exists: {}",
            file_path.display()
        )));
    }

    let mut content = format!("{}\n#note()\n\n", crate::vault_package::import_line());

    // Auto-set zid property when zettelkasten is enabled
    let settings = state.settings.read().await;
    if settings.files.zettelkasten_enabled && !settings.files.zid_pattern.is_empty() {
        let zid_value = crate::scaffolds::generate_zid(&settings.files.zid_pattern);
        let pv = if let Ok(num) = zid_value.parse::<f64>() {
            crate::models::note::PropertyValue::Number(num)
        } else {
            crate::models::note::PropertyValue::String(zid_value)
        };
        content = crate::typst_pipeline::note_rewriter::update_note_property(&content, "zid", &pv);
    }
    drop(settings);

    storage.write_file(&file_path, &content).await?;

    // Index the new note
    reindex_note(&file_path, &content, &state).await;

    Ok(file_path.display().to_string())
}

/// Create a new folder.
#[tauri::command]
pub async fn create_folder(
    name: String,
    parent: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let vault_root = state.vault_root.read().await;
    let root = vault_root.as_ref().ok_or(InkyCapError::VaultNotOpen)?;

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
    Ok(folder_path.display().to_string())
}

/// Rename a file (simple rename, no link updates).
#[tauri::command]
pub async fn rename_file(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let old = sanitize_vault_arg(&old_path)?;
    let is_dir = storage.resolve_path(&old)?.is_dir();
    let parent = old.parent().ok_or_else(|| {
        InkyCapError::InvalidPath("No parent directory".to_string())
    })?;

    let new_name_with_ext = if !is_dir && old.extension().is_some() && !new_name.contains('.') {
        format!(
            "{}.{}",
            new_name,
            old.extension().unwrap().to_string_lossy()
        )
    } else {
        new_name
    };

    let new_path = parent.join(&new_name_with_ext);
    if storage.exists(&new_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Already exists: {}",
            new_path.display()
        )));
    }

    storage.rename_file(&old, &new_path).await?;

    if is_dir {
        reindex_directory(&old, &new_path, &storage, &state).await;
    } else {
        let content = storage.read_file(&new_path).await?;
        remove_from_indices(&old, &state).await;
        reindex_note(&new_path, &content, &state).await;
    }

    Ok(new_path.display().to_string())
}

/// Rename a file or folder and update all wikilinks that reference it.
#[tauri::command]
pub async fn rename_and_update_links(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let old = sanitize_vault_arg(&old_path)?;
    let is_dir = storage.resolve_path(&old)?.is_dir();

    let parent = old.parent().ok_or_else(|| {
        InkyCapError::InvalidPath("No parent directory".to_string())
    })?;

    let new_name_with_ext = if !is_dir && old.extension().is_some() && !new_name.contains('.') {
        format!(
            "{}.{}",
            new_name,
            old.extension().unwrap().to_string_lossy()
        )
    } else {
        new_name.clone()
    };

    let new_path = parent.join(&new_name_with_ext);
    if storage.exists(&new_path).await {
        return Err(InkyCapError::InvalidPath(format!(
            "Already exists: {}",
            new_path.display()
        )));
    }

    // For files, update wikilinks in referencing notes before the rename.
    // (Doing it before — versus after, as the watcher path does — is
    // arbitrary; the rewrite only touches files other than `old`/`new`,
    // so either ordering converges.)
    if !is_dir {
        rewrite_backlinks_for_rename(&old, &new_path, &storage, &*state).await?;
    }

    storage.rename_file(&old, &new_path).await?;

    if is_dir {
        reindex_directory(&old, &new_path, &storage, &state).await;
    } else {
        let content = storage.read_file(&new_path).await?;
        remove_from_indices(&old, &state).await;
        reindex_note(&new_path, &content, &state).await;
    }

    Ok(new_path.display().to_string())
}

/// Move a file to a different folder.
#[tauri::command]
pub async fn move_file(
    old_path: String,
    new_folder: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let storage = state.get_storage().await?;
    let vault_root = state.vault_root.read().await;
    let root = vault_root.as_ref().ok_or(InkyCapError::VaultNotOpen)?;

    let old = sanitize_vault_arg(&old_path)?;
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
    storage.rename_file(&old, &new_path).await?;

    // Update indices
    let content = storage.read_file(&new_path).await?;
    remove_from_indices(&old, &state).await;
    reindex_note(&new_path, &content, &state).await;

    Ok(new_path.display().to_string())
}

/// Delete a file by moving it to the system trash.
#[tauri::command]
pub async fn delete_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = sanitize_vault_arg(&path)?;

    storage.move_to_trash(&path_buf).await?;
    remove_from_indices(&path_buf, &state).await;

    Ok(())
}

/// Delete a folder by moving it to the system trash.
#[tauri::command]
pub async fn delete_folder(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = sanitize_vault_arg(&path)?;

    // Remove all indexed notes within this folder
    let notes_in_folder: Vec<PathBuf> = {
        let pi = state.property_index.read().await;
        pi.notes
            .keys()
            .filter(|p| p.starts_with(&path_buf))
            .cloned()
            .collect()
    };
    for note_path in &notes_in_folder {
        remove_from_indices(note_path, &state).await;
    }

    storage.move_to_trash(&path_buf).await?;
    Ok(())
}

// ── Helpers ──

/// Replace wikilinks in content so they continue to resolve after a note
/// has been renamed from `old_stem` to `new_stem`. Handles both forms that
/// appear in vault sources:
///
///   - `[[old_stem]]`, `[[old_stem#heading]]`, `[[old_stem|alias]]` —
///     the inline shortcut.
///   - `#wikilink("old_stem")`, `#wikilink("old_stem", display: "...")`,
///     `#wikilink("old_stem", label: "...")` — the Typst function form
///     emitted by markdown import and the drag-drop / palette handlers.
///
/// Per CLAUDE.md's Typst-first principle, the ideal rewrite would walk
/// the `typst::syntax` AST and splice the call site by source range.
/// We keep this string-based for two reasons: (1) the existing helper
/// was already string-based and shipped under `rename_and_update_links`,
/// so callers expect identical behaviour; (2) reparsing every backlinked
/// note through Typst on each rename is meaningfully heavier than scanning
/// for two well-known prefixes. The function-form regex below mirrors
/// `WIKILINK_CALL_RE` in `src/editor/typst-decorations/wikilink-suggest.ts`
/// so the two stay in lockstep.
pub(crate) fn update_wikilinks_in_content(
    content: &str,
    old_stem: &str,
    new_stem: &str,
) -> String {
    let after_brackets = rewrite_bracket_wikilinks(content, old_stem, new_stem);
    rewrite_func_wikilinks(&after_brackets, old_stem, new_stem)
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

/// Rewrite the first string argument of `#wikilink("...")` when it matches
/// `old_stem` (case-insensitive). Other arguments (`display:`, `label:`)
/// are preserved untouched. Names are matched on the literal quoted text;
/// callers escape `new_stem` with `typst_string_escape` before passing it
/// here.
fn rewrite_func_wikilinks(content: &str, old_stem: &str, new_stem: &str) -> String {
    const PREFIX: &str = "#wikilink(\"";
    let old_lower = old_stem.to_lowercase();
    let escaped_new = typst_string_escape(new_stem);

    let mut result = String::with_capacity(content.len());
    let mut remaining = content;

    while let Some(start) = remaining.find(PREFIX) {
        result.push_str(&remaining[..start + PREFIX.len()]);
        remaining = &remaining[start + PREFIX.len()..];

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

/// Escape a string for inclusion inside a Typst double-quoted literal.
/// Mirrors `typstStringEscape` in [src/lib/typst.ts] — only `\\` and `"`
/// need escaping inside a `"..."` literal.
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

/// Walk every note that links to `old_path`, rewrite its wikilinks so they
/// point at `new_path`, and reindex it. Shared between the in-app rename
/// command (which calls this *before* moving the file on disk) and the
/// external-rename watcher path (which calls this *after* the move has
/// already happened — order doesn't matter to this function because it
/// only touches the *referencing* files, never the renamed one).
pub(crate) async fn rewrite_backlinks_for_rename(
    old_path: &std::path::Path,
    new_path: &std::path::Path,
    storage: &std::sync::Arc<crate::storage::local::LocalVaultStorage>,
    state: &AppState,
) -> Result<(), InkyCapError> {
    let old_stem = match old_path.file_stem() {
        Some(s) => s.to_string_lossy().into_owned(),
        None => return Ok(()),
    };
    let new_stem = match new_path.file_stem() {
        Some(s) => s.to_string_lossy().into_owned(),
        None => return Ok(()),
    };
    if old_stem.eq_ignore_ascii_case(&new_stem) {
        return Ok(());
    }

    let backlinks = {
        let link_index = state.link_index.read().await;
        link_index.get_backlinks(&old_path.to_path_buf())
    };

    for referencing_path in &backlinks {
        let Ok(content) = storage.read_file(referencing_path).await else {
            continue;
        };
        let updated = update_wikilinks_in_content(&content, &old_stem, &new_stem);
        if updated != content {
            storage.write_file(referencing_path, &updated).await?;
            state.reindex_note(referencing_path, &updated).await;
        }
    }

    Ok(())
}

/// Local alias for the unified indexing helper on [`AppState`]. All note
/// mutations in this module route through `state.reindex_note` — see
/// `state::AppState::reindex_note` for the canonical implementation and the
/// cache write-through invariant.
async fn reindex_note(
    path: &std::path::Path,
    content: &str,
    state: &State<'_, AppState>,
) {
    state.reindex_note(path, content).await;
}

/// Local alias for `AppState::remove_from_indices`. Kept so existing call
/// sites read naturally; any new code should prefer calling the method on
/// `state` directly.
async fn remove_from_indices(path: &std::path::Path, state: &State<'_, AppState>) {
    state.remove_from_indices(path).await;
}

async fn reindex_directory(
    old_dir: &std::path::Path,
    new_dir: &std::path::Path,
    storage: &std::sync::Arc<crate::storage::local::LocalVaultStorage>,
    state: &State<'_, AppState>,
) {
    // List notes at the new location (renamed dir already exists on disk)
    let new_notes = storage.list_files(new_dir, "*.typ").await.unwrap_or_default();
    let old_abs = storage.resolve_path(old_dir).unwrap_or_else(|_| old_dir.to_path_buf());
    let new_abs = storage.resolve_path(new_dir).unwrap_or_else(|_| new_dir.to_path_buf());

    // For each note under the new dir, compute what its old path was and remove that
    for new_note in &new_notes {
        if let Ok(suffix) = new_note.strip_prefix(&new_abs) {
            let old_note = old_abs.join(suffix);
            state.remove_from_indices(&old_note).await;
        }
        if let Ok(content) = storage.read_file(new_note).await {
            state.reindex_note(new_note, &content).await;
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
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()?;
    }
    Ok(())
}

/// Open a file with the OS default application (image viewer, PDF reader, etc.).
#[tauri::command]
pub async fn open_file_externally(path: String) -> Result<(), InkyCapError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(InkyCapError::InvalidPath(format!(
            "File does not exist: {path}"
        )));
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&p).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&p).spawn()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &p.to_string_lossy()])
            .spawn()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(result, "Start [[New Note]] middle [[New Note#heading]] end.");
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
