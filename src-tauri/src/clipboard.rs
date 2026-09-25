//! Read text and HTML from the native clipboard (GTK, NSPasteboard, Win32).
//!
//! The webview's clipboard API is restricted, so paste commands read the
//! clipboard from the Rust side instead. File and image clipboard reads live
//! with the attachment commands in [`crate::commands::file_ops`].

/// Refuse to read clipboard payloads larger than this; far past any real
/// paste, it keeps a malformed payload from walking the heap.
const MAX_CLIPBOARD_BYTES: usize = 32 * 1024 * 1024;

/// The clipboard's plain-text content, or `None` when it holds no text.
pub async fn read_text(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        on_gtk_main_thread(app, |cb| cb.wait_for_text().map(|t| t.to_string())).await
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        tokio::task::spawn_blocking(|| {
            let pb = objc2_app_kit::NSPasteboard::generalPasteboard();
            let text = pb.stringForType(unsafe { objc2_app_kit::NSPasteboardTypeString })?;
            Some(text.to_string())
        })
        .await
        .map_err(|e| format!("clipboard task panicked: {}", e))
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        tokio::task::spawn_blocking(win32::read_text)
            .await
            .map_err(|e| format!("clipboard task panicked: {}", e))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(None)
    }
}

/// The clipboard's HTML content (what a browser offers alongside plain text
/// when the user copies part of a page), or `None` when there is none.
pub async fn read_html(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        on_gtk_main_thread(app, |cb| {
            let atom = gtk::gdk::Atom::intern("text/html");
            let data = cb.wait_for_contents(&atom)?.data();
            decode_html_bytes(&data)
        })
        .await
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        tokio::task::spawn_blocking(|| {
            let pb = objc2_app_kit::NSPasteboard::generalPasteboard();
            let html = pb.stringForType(unsafe { objc2_app_kit::NSPasteboardTypeHTML })?;
            Some(html.to_string())
                .filter(|h| h.len() <= MAX_CLIPBOARD_BYTES && !h.trim().is_empty())
        })
        .await
        .map_err(|e| format!("clipboard task panicked: {}", e))
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        tokio::task::spawn_blocking(win32::read_html)
            .await
            .map_err(|e| format!("clipboard task panicked: {}", e))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Run a GTK clipboard read on the main thread, where GTK requires it.
#[cfg(target_os = "linux")]
async fn on_gtk_main_thread<F>(app: &tauri::AppHandle, read: F) -> Result<Option<String>, String>
where
    F: FnOnce(&gtk::Clipboard) -> Option<String> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    app.run_on_main_thread(move || {
        let value = gtk::gdk::Display::default().and_then(|d| {
            let cb = gtk::Clipboard::for_display(&d, &gtk::gdk::SELECTION_CLIPBOARD);
            read(&cb)
        });
        let _ = tx.send(value);
    })
    .map_err(|e| format!("run_on_main_thread failed: {}", e))?;
    rx.await.map_err(|_| "clipboard channel closed".to_string())
}

/// Decode a `text/html` clipboard payload. Chromium writes UTF-8; Firefox
/// has written UTF-16 with a byte-order mark. Trailing NULs some apps add
/// are dropped.
#[cfg(any(target_os = "linux", test))]
fn decode_html_bytes(data: &[u8]) -> Option<String> {
    if data.len() > MAX_CLIPBOARD_BYTES {
        log::warn!("[clipboard] ignoring {}-byte HTML payload", data.len());
        return None;
    }
    let utf16 = |bytes: &[u8], from: fn([u8; 2]) -> u16| {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|p| from([p[0], p[1]])).collect();
        String::from_utf16_lossy(&units)
    };
    let text = match data {
        [0xFF, 0xFE, rest @ ..] => utf16(rest, u16::from_le_bytes),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, u16::from_be_bytes),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => String::from_utf8_lossy(data).into_owned(),
    };
    let text = text.trim_end_matches('\0');
    (!text.trim().is_empty()).then(|| text.to_string())
}

/// Pull the HTML out of a Windows `HTML Format` clipboard payload, which
/// prefixes it with a header of byte offsets (`StartHTML:…`, `EndHTML:…`,
/// `StartFragment:…`, `EndFragment:…`).
#[cfg(any(target_os = "windows", test))]
fn html_from_cf_html(data: &[u8]) -> Option<String> {
    let header_end = data.iter().position(|&b| b == b'<').unwrap_or(data.len());
    let header = String::from_utf8_lossy(&data[..header_end]);
    let offset = |key: &str| -> Option<usize> {
        header.lines().find_map(|line| {
            let value = line.trim().strip_prefix(key)?.strip_prefix(':')?;
            value.trim().parse::<usize>().ok()
        })
    };
    // StartHTML may be -1 (absent) in version 1.0 payloads; fall back to the
    // fragment offsets, then to everything after the header.
    let (start, end) = match (offset("StartHTML"), offset("EndHTML")) {
        (Some(s), Some(e)) => (s, e),
        _ => match (offset("StartFragment"), offset("EndFragment")) {
            (Some(s), Some(e)) => (s, e),
            _ => (header_end, data.len()),
        },
    };
    let end = end.min(data.len());
    let html = data.get(start..end)?;
    let html = String::from_utf8_lossy(html);
    let html = html.trim_end_matches('\0');
    (!html.trim().is_empty()).then(|| html.to_string())
}

#[cfg(target_os = "windows")]
mod win32 {
    //! Win32 clipboard reads. Opening the clipboard with a null HWND ties it
    //! to the current task; reads are safe from any thread once it's open.

    use windows_sys::Win32::Foundation::{HGLOBAL, HWND};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    use super::MAX_CLIPBOARD_BYTES;

    const CF_UNICODETEXT: u32 = 13;

    /// Open the clipboard, lock the data for `format`, hand it to `read`,
    /// and always unlock and close again so other apps don't see a stale
    /// clipboard owner.
    fn with_clipboard_data<T>(format: u32, read: impl FnOnce(*const u8, usize) -> Option<T>) -> Option<T> {
        unsafe {
            let null_hwnd: HWND = std::ptr::null_mut();
            if OpenClipboard(null_hwnd) == 0 {
                log::debug!("[clipboard] OpenClipboard failed");
                return None;
            }
            let result = (|| {
                let handle = GetClipboardData(format);
                if handle.is_null() {
                    return None;
                }
                let hglobal: HGLOBAL = handle as HGLOBAL;
                let locked = GlobalLock(hglobal);
                if locked.is_null() {
                    return None;
                }
                let size = GlobalSize(hglobal).min(MAX_CLIPBOARD_BYTES);
                let value = read(locked as *const u8, size);
                GlobalUnlock(hglobal);
                value
            })();
            CloseClipboard();
            result
        }
    }

    /// CF_UNICODETEXT: a null-terminated UTF-16LE string. Walk to the
    /// terminator rather than trusting the global size, which can be padded.
    pub fn read_text() -> Option<String> {
        with_clipboard_data(CF_UNICODETEXT, |ptr, size| {
            let ptr = ptr as *const u16;
            let max_units = size / 2;
            let mut len = 0usize;
            // SAFETY: `ptr` points at `size` locked bytes; `len` stays below
            // `max_units`, so every read is inside that block.
            unsafe {
                while len < max_units && *ptr.add(len) != 0 {
                    len += 1;
                }
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                (!s.is_empty()).then_some(s)
            }
        })
    }

    /// The registered "HTML Format": UTF-8 bytes with an offsets header.
    pub fn read_html() -> Option<String> {
        let name: Vec<u16> = "HTML Format".encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `name` is a null-terminated UTF-16 string.
        let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        if format == 0 {
            return None;
        }
        with_clipboard_data(format, |ptr, size| {
            // SAFETY: `ptr` points at `size` locked bytes.
            let bytes = unsafe { std::slice::from_raw_parts(ptr, size) };
            super::html_from_cf_html(bytes)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_and_utf16_html() {
        assert_eq!(decode_html_bytes(b"<p>caf\xc3\xa9</p>\0").as_deref(), Some("<p>café</p>"));
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("<b>é</b>".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_html_bytes(&utf16).as_deref(), Some("<b>é</b>"));
        assert_eq!(decode_html_bytes(b"  "), None);
    }

    #[test]
    fn strips_the_cf_html_header() {
        let html = "<html><body><!--StartFragment--><p>Hi</p><!--EndFragment--></body></html>";
        let header_template = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\n";
        let start = header_template.len();
        let end = start + html.len();
        let payload = format!(
            "Version:0.9\r\nStartHTML:{start:010}\r\nEndHTML:{end:010}\r\n{html}"
        );
        assert_eq!(html_from_cf_html(payload.as_bytes()).as_deref(), Some(html));
    }
}
