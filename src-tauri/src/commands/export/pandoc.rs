use std::path::Path;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::package_fetch::compile_with_auto_packages;

use super::helpers::{
    escape_xml, extract_metadata_raw, localize_html_assets, normalize_metadata,
    prepare_bibliography, upsert_xml_element, upsert_xml_element_with_attr,
};

// ── Pandoc detection ────────────────────────────────────────────

/// Detect if Pandoc is available on the system. Returns the path if found.
#[tauri::command]
pub async fn detect_pandoc() -> Result<Option<String>, InkyCapError> {
    let settings = crate::settings::load_settings();
    if let Some(ref custom) = settings.export.pandoc_path {
        if !custom.is_empty() && Path::new(custom).exists() {
            return Ok(Some(custom.clone()));
        }
    }

    match which::which("pandoc") {
        Ok(path) => Ok(Some(path.display().to_string())), // path-stringification-ok: subprocess argv for Command::new, not IPC
        Err(_) => Ok(None),
    }
}

/// Detect an available PDF engine for Pandoc. Checks in order of preference:
/// typst CLI, xelatex, lualatex, pdflatex, tectonic.
async fn detect_pdf_engine() -> Result<String, ()> {
    for engine in &["typst", "xelatex", "lualatex", "pdflatex", "tectonic"] {
        if which::which(engine).is_ok() {
            return Ok(engine.to_string());
        }
    }
    Err(())
}

// ── Pandoc export ───────────────────────────────────────────────

/// Export a note via Pandoc to the specified format.
///
/// `metadata_mode`: "exclude" (strip all) or "properties" (set as document
/// properties without body rendering).
#[tauri::command]
pub async fn export_via_pandoc(
    path: String,
    output_path: String,
    format: String,
    metadata_mode: String,
    review_mode: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let pandoc_path = detect_pandoc().await?.ok_or_else(|| {
        InkyCapError::ExportFailed(
            "Pandoc not found. Install Pandoc or set a custom path in Settings.".to_string(),
        )
    })?;

    let storage = session.get_storage().await?;
    let path_buf = std::path::PathBuf::from(&path);
    let raw_content = storage.read_file(&path_buf).await?;

    // Document properties are read straight from the note's `#note(...)` call and
    // injected into the finished file afterwards — independent of how the body is
    // converted, so they survive regardless of the intermediate format.
    let raw_metadata = if metadata_mode == "properties" {
        extract_metadata_raw(&raw_content)
    } else {
        Vec::new()
    };
    let normalized = normalize_metadata(&raw_metadata);

    // Resolve the review layer per the user's choice (accept/reject collapse to
    // clean text; keep leaves the marks for the real compiler to render).
    let content = super::helpers::apply_review_mode(&raw_content, review_mode.as_deref());

    // Compile the note to HTML with the *real* Typst compiler, then let Pandoc
    // convert from HTML — a format it fully supports. This sidesteps Pandoc's
    // partial built-in Typst reader, so `#include`, the inkycap-notebox package,
    // symbols (`#sym.*`), and layout all resolve natively instead of erroring on
    // an unknown identifier or module method.
    let content = crate::notebox_package::ensure_import(&content);
    let source = super::super::typst::inject_style_cascade(&content, &path_buf, &state).await;
    let source = super::super::typst::maybe_inject_set_notebox(&source, &state).await;
    let source = prepare_bibliography(source, None, None, true, &state, &session).await;

    let html = {
        let mut compiler = session.typst_compiler.lock().await;
        let compiler = compiler.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
        compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);
        let result =
            compile_with_auto_packages(compiler, |c| c.compile_html(&path_buf, source.clone()))
                .await
                .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?;
        if !result.ok {
            let msgs: Vec<_> = result
                .diagnostics
                .iter()
                .map(|d| d.message.clone())
                .collect();
            return Err(InkyCapError::ExportFailed(format!(
                "Compilation failed: {}",
                msgs.join("; ")
            )));
        }
        result.html
    };

    let temp_dir = tempfile::tempdir()
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create temp dir: {}", e)))?;

    // Copy referenced assets next to the intermediate HTML and rewrite their
    // notebox-root-absolute `/…` srcs to relative paths so Pandoc embeds them.
    let html = {
        let notebox_root = session.notebox_root.read().await;
        match notebox_root.as_ref() {
            Some(root) => localize_html_assets(&html, root, temp_dir.path()).await?.0,
            None => html,
        }
    };

    let html = mirror_img_style_size_to_attrs(&html);

    let temp_input = temp_dir.path().join("input.html");
    tokio::fs::write(&temp_input, &html)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write temp file: {}", e)))?;

    let mut cmd = tokio::process::Command::new(&pandoc_path);
    cmd.arg("-f").arg("html");

    if format == "latex" && !normalized.is_empty() {
        cmd.arg("--standalone");
    }

    cmd.arg("-o").arg(&output_path).arg(&temp_input);

    if format == "pandoc-pdf" {
        if let Ok(engine) = detect_pdf_engine().await {
            cmd.arg(format!("--pdf-engine={}", engine));
        } else {
            return Err(InkyCapError::ExportFailed(
                "No PDF engine found. Install one of: typst, xelatex, pdflatex, lualatex, or tectonic. \
                 Alternatively, use the native \"PDF (native Typst)\" format which requires no external tools."
                    .to_string(),
            ));
        }
    } else {
        cmd.arg("-t").arg(&format);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to run Pandoc: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(InkyCapError::ExportFailed(format!(
            "Pandoc export failed: {}",
            stderr
        )));
    }

    if !raw_metadata.is_empty() {
        match format.as_str() {
            "docx" => postprocess_docx(&output_path, &normalized)?,
            "odt" => postprocess_odt(&output_path, &normalized)?,
            "latex" => postprocess_latex(&output_path, &normalized).await?,
            _ => {}
        }
    }

    Ok(())
}

/// Pandoc's HTML reader sizes images from the `width`/`height` *attributes*,
/// not the inline CSS that Typst's HTML export emits (`<img … style="width:
/// 25%">`). With no attribute, Pandoc falls back to the image's intrinsic pixel
/// size, which overflows the page in DOCX/ODT. Mirror any width/height in the
/// style onto real attributes (when not already present) so the author's sizing
/// carries through. `auto`/empty values are skipped; existing attributes win.
pub(super) fn mirror_img_style_size_to_attrs(html: &str) -> String {
    let img_re = regex::Regex::new(r"(?is)<img\b[^>]*>").unwrap();
    let style_re = regex::Regex::new(r#"(?i)style\s*=\s*["']([^"']*)["']"#).unwrap();
    let has_w = regex::Regex::new(r#"(?i)\bwidth\s*="#).unwrap();
    let has_h = regex::Regex::new(r#"(?i)\bheight\s*="#).unwrap();

    img_re
        .replace_all(html, |caps: &regex::Captures| {
            let tag = &caps[0];
            let Some(style) = style_re.captures(tag).map(|c| c[1].to_string()) else {
                return tag.to_string();
            };
            let mut attrs = String::new();
            if !has_w.is_match(tag) {
                if let Some(v) = css_prop(&style, "width") {
                    if !v.is_empty() && v != "auto" {
                        attrs.push_str(&format!(" width=\"{v}\""));
                    }
                }
            }
            if !has_h.is_match(tag) {
                if let Some(v) = css_prop(&style, "height") {
                    if !v.is_empty() && v != "auto" {
                        attrs.push_str(&format!(" height=\"{v}\""));
                    }
                }
            }
            if attrs.is_empty() {
                tag.to_string()
            } else {
                tag.replacen("<img", &format!("<img{attrs}"), 1)
            }
        })
        .into_owned()
}

/// Extract a CSS declaration value from a `style` string (`width: 25%` → `25%`).
fn css_prop(style: &str, prop: &str) -> Option<String> {
    for decl in style.split(';') {
        let mut it = decl.splitn(2, ':');
        let key = it.next()?.trim();
        if key.eq_ignore_ascii_case(prop) {
            return it.next().map(|v| v.trim().to_string());
        }
    }
    None
}

// ── Format-specific post-processing ─────────────────────────────

/// Post-process a DOCX file: strip title block paragraphs from the body
/// and inject metadata into `docProps/core.xml` to guarantee document
/// properties are set (Pandoc's --metadata doesn't always write them).
fn postprocess_docx(path: &str, metadata: &[(String, String)]) -> Result<(), InkyCapError> {
    use std::io::{Read as _, Write as _};

    let data = std::fs::read(path)
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to read DOCX: {}", e)))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&data))
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to read DOCX ZIP: {}", e)))?;

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| InkyCapError::ExportFailed(format!("DOCX entry read error: {}", e)))?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| InkyCapError::ExportFailed(format!("DOCX entry data error: {}", e)))?;
        entries.push((name, buf));
    }
    drop(archive);

    let title_styles =
        regex::Regex::new(r#"<w:pStyle w:val="(Title|Subtitle|Author|Date)"\s*/>"#).unwrap();

    let out_file = std::fs::File::create(path)
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create DOCX: {}", e)))?;
    let mut writer = zip::ZipWriter::new(out_file);

    for (name, mut content) in entries {
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file(&name, opts)
            .map_err(|e| InkyCapError::ExportFailed(format!("DOCX write error: {}", e)))?;

        if name == "word/document.xml" {
            let xml = String::from_utf8_lossy(&content);
            let cleaned = strip_docx_title_paragraphs(&xml, &title_styles);
            content = cleaned.into_bytes();
        } else if name == "docProps/core.xml" {
            let xml = String::from_utf8_lossy(&content);
            let updated = inject_docx_core_properties(&xml, metadata);
            content = updated.into_bytes();
        }

        writer
            .write_all(&content)
            .map_err(|e| InkyCapError::ExportFailed(format!("DOCX write error: {}", e)))?;
    }

    writer
        .finish()
        .map_err(|e| InkyCapError::ExportFailed(format!("DOCX ZIP finish error: {}", e)))?;

    Ok(())
}

pub(super) fn strip_docx_title_paragraphs(xml: &str, title_styles: &regex::Regex) -> String {
    let para_re = regex::Regex::new(r"(?s)<w:p\b[^>]*>.*?</w:p>").unwrap();

    para_re
        .replace_all(xml, |caps: &regex::Captures| {
            let para = caps.get(0).unwrap().as_str();
            if title_styles.is_match(para) {
                String::new()
            } else {
                para.to_string()
            }
        })
        .to_string()
}

pub(super) fn inject_docx_core_properties(xml: &str, metadata: &[(String, String)]) -> String {
    let mut result = xml.to_string();
    let closing = "</cp:coreProperties>";

    for (key, value) in metadata {
        match key.as_str() {
            "title" => upsert_xml_element(&mut result, "dc:title", value, closing),
            "author" => upsert_xml_element(&mut result, "dc:creator", value, closing),
            "keywords" => upsert_xml_element(&mut result, "cp:keywords", value, closing),
            "subject" => upsert_xml_element(&mut result, "dc:subject", value, closing),
            "description" => upsert_xml_element(&mut result, "dc:description", value, closing),
            "date" => {
                let w3c = format!("{}T00:00:00Z", value);
                upsert_xml_element_with_attr(
                    &mut result,
                    "dcterms:created",
                    &w3c,
                    " xsi:type=\"dcterms:W3CDTF\"",
                    closing,
                );
            }
            _ => {}
        }
    }

    result
}

/// Post-process an ODT file: strip title block paragraphs from the body
/// and inject metadata into `meta.xml`.
fn postprocess_odt(path: &str, metadata: &[(String, String)]) -> Result<(), InkyCapError> {
    use std::io::{Read as _, Write as _};

    let data = std::fs::read(path)
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to read ODT: {}", e)))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&data))
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to read ODT ZIP: {}", e)))?;

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| InkyCapError::ExportFailed(format!("ODT entry read error: {}", e)))?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| InkyCapError::ExportFailed(format!("ODT entry data error: {}", e)))?;
        entries.push((name, buf));
    }
    drop(archive);

    let title_styles =
        regex::Regex::new(r#"text:style-name="(Title|Subtitle|Author|Date)""#).unwrap();

    let out_file = std::fs::File::create(path)
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create ODT: {}", e)))?;
    let mut writer = zip::ZipWriter::new(out_file);

    for (name, mut content) in entries {
        let compression = if name == "mimetype" {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        };
        let opts = zip::write::SimpleFileOptions::default().compression_method(compression);
        writer
            .start_file(&name, opts)
            .map_err(|e| InkyCapError::ExportFailed(format!("ODT write error: {}", e)))?;

        if name == "content.xml" {
            let xml = String::from_utf8_lossy(&content);
            let cleaned = strip_odt_title_paragraphs(&xml, &title_styles);
            content = cleaned.into_bytes();
        } else if name == "meta.xml" {
            let xml = String::from_utf8_lossy(&content);
            let updated = inject_odt_meta_properties(&xml, metadata);
            content = updated.into_bytes();
        }

        writer
            .write_all(&content)
            .map_err(|e| InkyCapError::ExportFailed(format!("ODT write error: {}", e)))?;
    }

    writer
        .finish()
        .map_err(|e| InkyCapError::ExportFailed(format!("ODT ZIP finish error: {}", e)))?;

    Ok(())
}

fn strip_odt_title_paragraphs(xml: &str, title_styles: &regex::Regex) -> String {
    let para_re = regex::Regex::new(r"(?s)<text:p\b[^>]*>.*?</text:p>").unwrap();

    para_re
        .replace_all(xml, |caps: &regex::Captures| {
            let para = caps.get(0).unwrap().as_str();
            if title_styles.is_match(para) {
                String::new()
            } else {
                para.to_string()
            }
        })
        .to_string()
}

/// Matches an existing `<meta:keyword>…</meta:keyword>` element (plus
/// trailing whitespace) so the keyword set can be rewritten wholesale.
fn odt_keyword_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"<meta:keyword>[^<]*</meta:keyword>\s*").unwrap())
}

pub(super) fn inject_odt_meta_properties(xml: &str, metadata: &[(String, String)]) -> String {
    let mut result = xml.to_string();
    let closing = "</office:meta>";

    for (key, value) in metadata {
        match key.as_str() {
            "title" => upsert_xml_element(&mut result, "dc:title", value, closing),
            "author" => {
                upsert_xml_element(&mut result, "meta:initial-creator", value, closing);
                upsert_xml_element(&mut result, "dc:creator", value, closing);
            }
            "subject" => upsert_xml_element(&mut result, "dc:subject", value, closing),
            "date" => {
                let odt_date = format!("{}T00:00:00", value);
                upsert_xml_element(&mut result, "dc:date", &odt_date, closing);
            }
            "keywords" => {
                result = odt_keyword_re().replace_all(&result, "").to_string();

                let mut kw_xml = String::new();
                for kw in value.split(", ") {
                    let kw = kw.trim();
                    if !kw.is_empty() {
                        kw_xml
                            .push_str(&format!("<meta:keyword>{}</meta:keyword>", escape_xml(kw)));
                    }
                }
                if !kw_xml.is_empty() {
                    if let Some(pos) = result.find(closing) {
                        result.insert_str(pos, &kw_xml);
                    }
                }
            }
            _ => {}
        }
    }

    result
}

/// Post-process LaTeX output: strip `\title`, `\author`, `\date`, and
/// `\maketitle` so metadata only appears via `\hypersetup` (PDF properties),
/// not as visible content in the body.
async fn postprocess_latex(path: &str, metadata: &[(String, String)]) -> Result<(), InkyCapError> {
    let latex = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to read LaTeX: {}", e)))?;

    let mut result = latex;

    let title_cmd_re = regex::Regex::new(r"(?m)^\\(title|author|date)\{[^}]*\}\s*\n").unwrap();
    result = title_cmd_re.replace_all(&result, "").to_string();

    let maketitle_re = regex::Regex::new(r"(?m)^\\maketitle\s*\n").unwrap();
    result = maketitle_re.replace_all(&result, "").to_string();

    if let Some((_, author)) = metadata.iter().find(|(k, _)| k == "author") {
        if !result.contains("pdfauthor=") {
            if let Some(pos) = result.find("\\hypersetup{") {
                let after_brace = pos + "\\hypersetup{".len();
                let insert = format!(
                    "\n  pdfauthor={{{}}},",
                    author.replace('{', "\\{").replace('}', "\\}")
                );
                result.insert_str(after_brace, &insert);
            }
        }
    }

    if let Some((_, date)) = metadata.iter().find(|(k, _)| k == "date") {
        if !result.contains("pdfcreationdate=") {
            let pdf_date = format!("D:{}", date.replace('-', ""));
            if let Some(pos) = result.find("\\hypersetup{") {
                let after_brace = pos + "\\hypersetup{".len();
                let insert = format!("\n  pdfcreationdate={{{}}},", pdf_date);
                result.insert_str(after_brace, &insert);
            }
        }
    }

    tokio::fs::write(path, result)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write LaTeX: {}", e)))
}
