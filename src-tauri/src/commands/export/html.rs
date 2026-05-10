use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::VaultStorage;

use super::helpers::{
    escape_html_attr, escape_html_content, extract_metadata_raw,
    prepare_bibliography, strip_wikilinks_from_source,
};

/// Export a note to HTML using Typst's native HTML backend. Optionally
/// injects `<meta>` tags for note properties.
#[tauri::command]
pub async fn export_note_html(
    path: String,
    output_path: String,
    metadata_mode: String,
    strip_wikilinks: Option<bool>,
    include_bibliography: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = crate::vault_package::ensure_import(&content);

    let raw_metadata = if metadata_mode == "properties" {
        extract_metadata_raw(&content)
    } else {
        Vec::new()
    };

    let content = if strip_wikilinks.unwrap_or(false) {
        strip_wikilinks_from_source(&content)
    } else {
        content
    };

    let content = super::super::typst::inject_style_cascade(&content, &path_buf, &state).await;
    let content = super::super::typst::maybe_inject_set_vault(&content, &state).await;

    let source = prepare_bibliography(content, None, None, include_bibliography.unwrap_or(true), &state).await;

    let mut compiler = state.typst_compiler.lock().await;
    let compiler = compiler
        .as_mut()
        .ok_or(InkyCapError::VaultNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    let result = compiler
        .compile_html(&path_buf, source)
        .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?;

    if !result.ok {
        let msgs: Vec<_> = result.diagnostics.iter().map(|d| d.message.clone()).collect();
        return Err(InkyCapError::ExportFailed(
            format!("HTML compilation failed: {}", msgs.join("; ")),
        ));
    }

    tokio::fs::write(&output_path, result.html.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write HTML: {}", e)))?;

    if !raw_metadata.is_empty() {
        inject_html_metadata(&output_path, &raw_metadata).await?;
    }

    Ok(())
}

/// Inject `<meta>` tags into an HTML file's `<head>`.
pub(super) async fn inject_html_metadata(
    path: &str,
    metadata: &[(String, String)],
) -> Result<(), InkyCapError> {
    let html = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to read HTML: {}", e)))?;

    let mut meta_tags = String::new();
    for (key, value) in metadata {
        if !value.is_empty() {
            meta_tags.push_str(&format!(
                "  <meta name=\"{}\" content=\"{}\" />\n",
                escape_html_attr(key),
                escape_html_attr(value),
            ));
        }
    }

    let title = metadata
        .iter()
        .find(|(k, _)| k == "title")
        .map(|(_, v)| v.as_str());

    let result = if let Some(head_end) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + meta_tags.len() + 100);
        out.push_str(&html[..head_end]);
        out.push_str(&meta_tags);
        out.push_str(&html[head_end..]);

        if let Some(t) = title {
            if let Some(title_start) = out.find("<title>") {
                if let Some(title_end) = out[title_start..].find("</title>") {
                    let before = &out[..title_start];
                    let after = &out[title_start + title_end + 8..];
                    let replaced = format!(
                        "{}<title>{}</title>{}",
                        before,
                        escape_html_content(t),
                        after,
                    );
                    tokio::fs::write(path, replaced)
                        .await
                        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write HTML: {}", e)))?;
                    return Ok(());
                }
            }
        }

        out
    } else {
        format!(
            "<!DOCTYPE html>\n<html>\n<head>\n{}</head>\n<body>\n{}</body>\n</html>\n",
            meta_tags, html
        )
    };

    tokio::fs::write(path, result)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write HTML: {}", e)))
}
