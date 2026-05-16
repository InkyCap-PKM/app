use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::style_injection;

use super::helpers::{
    escape_html_content, prepare_bibliography, rewrite_wikilinks_to_links,
};

/// Export a collection as a static HTML site. Each note is compiled to HTML
/// via Typst's native HTML backend, wikilinks within the collection are
/// rewritten to relative `<a href>` links, and a shared CSS file is generated.
#[tauri::command]
pub async fn export_collection_static_site(
    collection_path: String,
    view_name: String,
    output_dir: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, InkyCapError> {
    let data = crate::commands::collections::get_collection_data_internal(
        &collection_path, &view_name, &state,
    )
    .await?;

    let storage = state.get_storage().await?;
    let collection_path_buf = PathBuf::from(&collection_path);
    let collection_content = storage.read_file(&collection_path_buf).await?;
    let base = crate::collection_parser::model::parse_collection_file(&collection_content)?;

    let output_dir = PathBuf::from(&output_dir);
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create output dir: {}", e)))?;

    let app_settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_show_call_resolved(&app_settings);
    drop(app_settings);
    let collection_rules = base.style.as_ref().map(|s| s.to_typst_show_call());

    let name_to_file: std::collections::HashMap<String, String> = data
        .rows
        .iter()
        .map(|row| {
            let stem = row.file_name.strip_suffix(".typ").unwrap_or(&row.file_name);
            let html_name = format!("{}.html", slug_from_name(stem));
            (stem.to_string(), html_name)
        })
        .collect();

    let mut exported = Vec::new();

    for row in &data.rows {
        let note_path_buf = PathBuf::from(&row.file_path);
        let content = storage.read_file(&note_path_buf).await?;
        let content = crate::notebox_package::ensure_import(&content);
        let content = rewrite_wikilinks_to_links(&content, &name_to_file);
        let content = style_injection::inject_style_rules(
            &content,
            if defaults_rules.is_empty() { None } else { Some(&defaults_rules) },
            collection_rules.as_deref().filter(|r| !r.is_empty()),
        );
        let content = super::super::typst::maybe_inject_set_notebox(&content, &state).await;
        let source = prepare_bibliography(content, None, None, true, &state).await;

        let mut compiler = state.typst_compiler.lock().await;
        let compiler = compiler
            .as_mut()
            .ok_or(InkyCapError::NoteboxNotOpen)?;
        compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

        let result = compiler
            .compile_html(&note_path_buf, source)
            .map_err(|e| InkyCapError::ExportFailed(
                format!("Failed to compile {}: {}", row.file_name, e),
            ))?;

        if !result.ok {
            let msgs: Vec<_> = result.diagnostics.iter().map(|d| d.message.clone()).collect();
            return Err(InkyCapError::ExportFailed(
                format!("HTML compilation failed for {}: {}", row.file_name, msgs.join("; ")),
            ));
        }

        let html = &result.html;

        let stem = row.file_name.strip_suffix(".typ").unwrap_or(&row.file_name);
        let html_name = format!("{}.html", slug_from_name(stem));

        let full_html = if html.contains("<html") {
            if let Some(head_end) = html.find("</head>") {
                let mut out = String::with_capacity(html.len() + 100);
                out.push_str(&html[..head_end]);
                out.push_str("  <link rel=\"stylesheet\" href=\"style.css\" />\n");
                out.push_str(&html[head_end..]);
                out
            } else {
                html.clone()
            }
        } else {
            format!(
                "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\" />\n  <title>{}</title>\n  <link rel=\"stylesheet\" href=\"style.css\" />\n</head>\n<body>\n{}\n</body>\n</html>",
                escape_html_content(stem),
                html,
            )
        };

        let file_path = output_dir.join(&html_name);
        tokio::fs::write(&file_path, full_html.as_bytes())
            .await
            .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write {}: {}", html_name, e)))?;
        exported.push(html_name.clone());
    }

    let index_html = generate_site_index(&data.rows, &name_to_file);
    tokio::fs::write(output_dir.join("index.html"), index_html.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write index.html: {}", e)))?;
    exported.push("index.html".to_string());

    tokio::fs::write(output_dir.join("style.css"), DEFAULT_SITE_CSS.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write style.css: {}", e)))?;
    exported.push("style.css".to_string());

    Ok(exported)
}

fn slug_from_name(name: &str) -> String {
    name.to_lowercase()
        .replace(' ', "-")
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "")
}

fn generate_site_index(
    rows: &[crate::models::collection::CollectionRow],
    name_to_file: &std::collections::HashMap<String, String>,
) -> String {
    let mut items = String::new();
    for row in rows {
        let stem = row.file_name.strip_suffix(".typ").unwrap_or(&row.file_name);
        if let Some(file) = name_to_file.get(stem) {
            items.push_str(&format!(
                "    <li><a href=\"{}\">{}</a></li>\n",
                escape_html_content(file),
                escape_html_content(stem),
            ));
        }
    }
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Collection</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <nav class="site-index">
    <h1>Notes</h1>
    <ul>
{}    </ul>
  </nav>
</body>
</html>"#,
        items
    )
}

const DEFAULT_SITE_CSS: &str = r#"/* InkyCap static site — default stylesheet */
:root {
  --fg-primary: #1a1a1a;
  --fg-secondary: #4a4a4a;
  --fg-muted: #6b7280;
  --bg-primary: #ffffff;
  --bg-secondary: #f8f9fa;
  --accent: #1D7874;
  --border: #e5e7eb;
  --font-body: "Adwaita Sans", Inter, "Fira Sans", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, "Cascadia Code", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --fg-primary: #e5e7eb;
    --fg-secondary: #9ca3af;
    --fg-muted: #6b7280;
    --bg-primary: #1f2937;
    --bg-secondary: #111827;
    --accent: #34d399;
    --border: #374151;
  }
}

* { box-sizing: border-box; }

body {
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  color: var(--fg-primary);
  background: var(--bg-primary);
  max-width: 800px;
  margin: 0 auto;
  padding: 32px 24px;
}

h1, h2, h3, h4, h5, h6 {
  margin-top: 1.4em;
  margin-bottom: 0.6em;
  line-height: 1.3;
}

a { color: var(--accent); text-decoration: underline; }
a:hover { text-decoration-color: var(--accent); }
a.wikilink { text-decoration-style: dotted; }

pre {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.9em;
}

code { font-family: var(--font-mono); font-size: 0.9em; }
:not(pre) > code {
  background: var(--bg-secondary);
  padding: 2px 5px;
  border-radius: 3px;
}

table { border-collapse: collapse; margin: 1em 0; width: 100%; }
th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
th { background: var(--bg-secondary); font-weight: 600; }

blockquote {
  border-left: 3px solid var(--accent);
  margin: 1em 0;
  padding: 0.5em 1em;
  color: var(--fg-secondary);
}

img { max-width: 100%; height: auto; }
figure { margin: 1.5em 0; text-align: center; }
figcaption { font-size: 0.9em; color: var(--fg-muted); margin-top: 0.5em; }

ul, ol { padding-left: 1.5em; margin: 0.8em 0; }

.site-index ul { list-style: none; padding: 0; }
.site-index li { padding: 6px 0; border-bottom: 1px solid var(--border); }
.site-index li:last-child { border-bottom: none; }

svg { max-width: 100%; height: auto; }
"#;
