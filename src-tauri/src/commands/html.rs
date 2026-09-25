use crate::errors::InkyCapError;
use crate::html::{html_to_typst, plain_text_to_typst};

/// Read the clipboard and convert it to Typst markup for insertion at the
/// cursor. Uses the clipboard's HTML (what browsers offer when part of a
/// page is copied); when there is none, the plain text is inserted with its
/// markup characters escaped. Returns `None` when the clipboard is empty or
/// holds nothing that converts to text.
#[tauri::command]
pub async fn paste_html_as_typst(app: tauri::AppHandle) -> Result<Option<String>, InkyCapError> {
    let html = crate::clipboard::read_html(&app)
        .await
        .map_err(InkyCapError::Clipboard)?;
    let typst = match html {
        Some(html) => {
            log::debug!("[paste-as-html] got {} bytes of HTML", html.len());
            // Parsing a large page is CPU-bound; keep it off the async workers.
            tokio::task::spawn_blocking(move || html_to_typst(&html))
                .await
                .map_err(|e| InkyCapError::Clipboard(format!("conversion task failed: {e}")))?
        }
        None => {
            let text = crate::clipboard::read_text(&app)
                .await
                .map_err(InkyCapError::Clipboard)?;
            log::debug!("[paste-as-html] no HTML on the clipboard; using plain text");
            text.map(|t| plain_text_to_typst(&t)).unwrap_or_default()
        }
    };
    Ok(Some(typst).filter(|t| !t.is_empty()))
}
