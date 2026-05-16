use std::path::Path;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;

use super::helpers::{
    escape_xml, extract_metadata_raw,
    find_matching_bracket, find_matching_paren, normalize_metadata,
    parse_first_string_arg, parse_named_string_arg, upsert_xml_element,
    upsert_xml_element_with_attr,
};

use super::html::inject_html_metadata;

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
        Ok(path) => Ok(Some(path.display().to_string())),
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
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let pandoc_path = detect_pandoc()
        .await?
        .ok_or_else(|| InkyCapError::ExportFailed(
            "Pandoc not found. Install Pandoc or set a custom path in Settings.".to_string(),
        ))?;

    let storage = state.get_storage().await?;
    let path_buf = std::path::PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;

    let raw_metadata = if metadata_mode == "properties" {
        extract_metadata_raw(&content)
    } else {
        Vec::new()
    };
    let normalized = normalize_metadata(&raw_metadata);

    let processed = preprocess_for_pandoc(&content);

    let temp_dir = tempfile::tempdir()
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create temp dir: {}", e)))?;
    let temp_input = temp_dir.path().join("input.typ");
    tokio::fs::write(&temp_input, &processed)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write temp file: {}", e)))?;

    let mut cmd = tokio::process::Command::new(&pandoc_path);
    cmd.arg("-f").arg("typst");

    if !normalized.is_empty() {
        for (key, value) in &normalized {
            let clean: String = value
                .chars()
                .filter(|c| !c.is_control() || *c == ' ')
                .collect();
            cmd.arg("--metadata").arg(format!("{}={}", key, clean));
        }
    }

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
            "html" => inject_html_metadata(&output_path, &raw_metadata).await?,
            "docx" => postprocess_docx(&output_path, &normalized)?,
            "odt" => postprocess_odt(&output_path, &normalized)?,
            "latex" => postprocess_latex(&output_path, &normalized).await?,
            _ => {}
        }
    }

    Ok(())
}

// ── Preprocessing ───────────────────────────────────────────────

/// Pre-process Typst source for Pandoc: strip InkyCap-specific constructs.
pub(super) fn preprocess_for_pandoc(source: &str) -> String {
    use crate::typst_pipeline::note_rewriter::note_call_span;

    let without_note = if let Some(span) = note_call_span(source) {
        let mut s = String::with_capacity(source.len());
        s.push_str(&source[..span.start]);
        let rest_start = if source.as_bytes().get(span.end) == Some(&b'\n') {
            span.end + 1
        } else {
            span.end
        };
        s.push_str(&source[rest_start..]);
        s
    } else {
        source.to_string()
    };

    let mut result = String::with_capacity(without_note.len());
    for line in without_note.lines() {
        if line.trim().starts_with("#import") {
            continue;
        }
        result.push_str(line);
        result.push('\n');
    }

    strip_inkycap_functions(&result)
}

/// Replace InkyCap function calls with plain text equivalents.
pub(super) fn strip_inkycap_functions(source: &str) -> String {
    let mut result = source.to_string();

    result = strip_function_calls(&result, "wikilink", |args| {
        let name = parse_first_string_arg(args).unwrap_or_default();
        let display = parse_named_string_arg(args, "display");
        display.unwrap_or(name)
    });

    let tag_re = regex::Regex::new(r#"#tag\("[^"]*"\)\s*"#).unwrap();
    result = tag_re.replace_all(&result, "").to_string();

    let embed_re = regex::Regex::new(r#"#embed\("[^"]*"\)"#).unwrap();
    result = embed_re.replace_all(&result, "").to_string();

    let linkref_re = regex::Regex::new(r#"link-ref\("([^"]*)"\)"#).unwrap();
    result = linkref_re.replace_all(&result, "$1").to_string();

    let setnotebox_re = regex::Regex::new(r#"#set-notebox\([^)]*\)\s*"#).unwrap();
    result = setnotebox_re.replace_all(&result, "").to_string();

    result = rewrite_content_block_func(&result, "callout", |_args, body| {
        format!("#quote(block: true)[{}]", body)
    });

    let verse_re = regex::Regex::new(r#"#verse\("([^"]*)"\)"#).unwrap();
    result = verse_re.replace_all(&result, "#quote(block: true)[$1]").to_string();
    result = rewrite_content_block_func(&result, "verse", |_args, body| {
        format!("#quote(block: true)[{}]", body)
    });

    result
}

/// Rewrite `#func_name(...)[body]` calls by extracting the content block with
/// bracket matching, then calling `rewriter(args, body)` for the replacement.
fn rewrite_content_block_func(
    source: &str,
    func_name: &str,
    rewriter: impl Fn(&str, &str) -> String,
) -> String {
    let pattern = format!("#{}(", func_name);
    let mut result = String::with_capacity(source.len());
    let mut remaining = source;

    while let Some(start) = remaining.find(&pattern) {
        result.push_str(&remaining[..start]);
        let after_hash = &remaining[start + 1..];

        let args_start = func_name.len() + 1;
        let Some(args_end) = find_matching_paren(after_hash, args_start - 1) else {
            result.push_str(&remaining[start..start + pattern.len()]);
            remaining = &remaining[start + pattern.len()..];
            continue;
        };
        let args = &after_hash[args_start..args_end];

        let after_args = &after_hash[args_end + 1..];
        let trimmed = after_args.trim_start();
        if trimmed.starts_with('[') {
            let ws_skipped = after_args.len() - trimmed.len();
            let Some(block_end) = find_matching_bracket(trimmed, 0) else {
                result.push_str(&remaining[start..start + pattern.len()]);
                remaining = &remaining[start + pattern.len()..];
                continue;
            };
            let body = &trimmed[1..block_end];
            result.push_str(&rewriter(args, body));
            remaining = &after_hash[args_end + 1 + ws_skipped + block_end + 1..];
        } else {
            result.push_str(&rewriter(args, ""));
            remaining = &after_hash[args_end + 1..];
        }
    }
    result.push_str(remaining);
    result
}

/// Replace every `#<func_name>(...)` call in `source` with the result of
/// `replace(args)`.
fn strip_function_calls(
    source: &str,
    func_name: &str,
    replace: impl Fn(&str) -> String,
) -> String {
    let pattern = format!("#{}(", func_name);
    let mut out = String::with_capacity(source.len());
    let mut remaining = source;
    while let Some(start) = remaining.find(&pattern) {
        out.push_str(&remaining[..start]);
        let after_hash = &remaining[start + 1..];
        let args_open = func_name.len();
        let Some(args_close) = find_matching_paren(after_hash, args_open) else {
            out.push_str(&remaining[start..start + pattern.len()]);
            remaining = &remaining[start + pattern.len()..];
            continue;
        };
        let args = &after_hash[args_open + 1..args_close];
        out.push_str(&replace(args));
        remaining = &after_hash[args_close + 1..];
    }
    out.push_str(remaining);
    out
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
        let mut entry = archive.by_index(i)
            .map_err(|e| InkyCapError::ExportFailed(format!("DOCX entry read error: {}", e)))?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| InkyCapError::ExportFailed(format!("DOCX entry data error: {}", e)))?;
        entries.push((name, buf));
    }
    drop(archive);

    let title_styles = regex::Regex::new(
        r#"<w:pStyle w:val="(Title|Subtitle|Author|Date)"\s*/>"#,
    ).unwrap();

    let out_file = std::fs::File::create(path)
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create DOCX: {}", e)))?;
    let mut writer = zip::ZipWriter::new(out_file);

    for (name, mut content) in entries {
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer.start_file(&name, opts)
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

        writer.write_all(&content)
            .map_err(|e| InkyCapError::ExportFailed(format!("DOCX write error: {}", e)))?;
    }

    writer.finish()
        .map_err(|e| InkyCapError::ExportFailed(format!("DOCX ZIP finish error: {}", e)))?;

    Ok(())
}

pub(super) fn strip_docx_title_paragraphs(xml: &str, title_styles: &regex::Regex) -> String {
    let para_re = regex::Regex::new(r"(?s)<w:p\b[^>]*>.*?</w:p>").unwrap();

    para_re.replace_all(xml, |caps: &regex::Captures| {
        let para = caps.get(0).unwrap().as_str();
        if title_styles.is_match(para) {
            String::new()
        } else {
            para.to_string()
        }
    }).to_string()
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
        let mut entry = archive.by_index(i)
            .map_err(|e| InkyCapError::ExportFailed(format!("ODT entry read error: {}", e)))?;
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| InkyCapError::ExportFailed(format!("ODT entry data error: {}", e)))?;
        entries.push((name, buf));
    }
    drop(archive);

    let title_styles = regex::Regex::new(
        r#"text:style-name="(Title|Subtitle|Author|Date)""#,
    ).unwrap();

    let out_file = std::fs::File::create(path)
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create ODT: {}", e)))?;
    let mut writer = zip::ZipWriter::new(out_file);

    for (name, mut content) in entries {
        let compression = if name == "mimetype" {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        };
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(compression);
        writer.start_file(&name, opts)
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

        writer.write_all(&content)
            .map_err(|e| InkyCapError::ExportFailed(format!("ODT write error: {}", e)))?;
    }

    writer.finish()
        .map_err(|e| InkyCapError::ExportFailed(format!("ODT ZIP finish error: {}", e)))?;

    Ok(())
}

fn strip_odt_title_paragraphs(xml: &str, title_styles: &regex::Regex) -> String {
    let para_re = regex::Regex::new(r"(?s)<text:p\b[^>]*>.*?</text:p>").unwrap();

    para_re.replace_all(xml, |caps: &regex::Captures| {
        let para = caps.get(0).unwrap().as_str();
        if title_styles.is_match(para) {
            String::new()
        } else {
            para.to_string()
        }
    }).to_string()
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
                let kw_re = regex::Regex::new(r"<meta:keyword>[^<]*</meta:keyword>\s*").unwrap();
                result = kw_re.replace_all(&result, "").to_string();

                let mut kw_xml = String::new();
                for kw in value.split(", ") {
                    let kw = kw.trim();
                    if !kw.is_empty() {
                        kw_xml.push_str(&format!(
                            "<meta:keyword>{}</meta:keyword>",
                            escape_xml(kw)
                        ));
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
async fn postprocess_latex(
    path: &str,
    metadata: &[(String, String)],
) -> Result<(), InkyCapError> {
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
