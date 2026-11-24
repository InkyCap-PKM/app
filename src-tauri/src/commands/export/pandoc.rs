use std::ffi::OsString;
use std::path::Path;

use tauri::State;

use crate::commands::typst::CompilePurpose;
use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::package_fetch::compile_with_auto_packages;

use super::helpers::{
    escape_xml, extract_metadata_raw, localize_html_assets, normalize_metadata,
    prepare_bibliography, upsert_xml_element, upsert_xml_element_with_attr,
};
use super::pandoc_bibliography::{self, BibliographyLayout};
use super::pandoc_footnotes;

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

/// Export a note with Pandoc to `format`. `metadata_mode` is "exclude" (none)
/// or "properties" (set as document properties, not shown in the body).
#[tauri::command]
pub async fn export_via_pandoc(
    path: String,
    output_path: String,
    format: String,
    metadata_mode: String,
    review_mode: Option<String>,
    linked_files: Option<super::LinkedFilesOptions>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<super::CompanionReport>, InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_path)
        .await?;
    let session = state.session(window.label()).await;
    let pandoc_path = detect_pandoc().await?.ok_or_else(|| {
        InkyCapError::ExportFailed(
            "Pandoc not found. Install Pandoc or set a custom path in Settings.".to_string(),
        )
    })?;

    let storage = session.get_storage().await?;
    let path_buf = std::path::PathBuf::from(&path);
    let raw_content = storage.read_file(&path_buf).await?;

    // Document properties are read from the note's `#note(...)` call and added to
    // the finished file afterwards, whatever the intermediate format.
    let raw_metadata = if metadata_mode == "properties" {
        extract_metadata_raw(&raw_content)
    } else {
        Vec::new()
    };
    let normalized = normalize_metadata(&raw_metadata);

    // Resolve the review layer per the user's choice (accept/reject collapse to
    // clean text; keep leaves the marks for the real compiler to render).
    let content = super::helpers::apply_review_mode(&raw_content, review_mode.as_deref());
    let mut companion = super::companion::CompanionFiles::beside_file(
        linked_files,
        std::path::Path::new(&output_path),
    );
    let content = companion.prepare_note(&storage, &path_buf, &content);

    // Compile the note to HTML with the real Typst compiler and let Pandoc
    // convert from HTML, which it fully supports, rather than using Pandoc's
    // partial Typst reader, so `#include`, the inkycap-notebox package, symbols
    // (`#sym.*`) and layout all work.
    let content = crate::notebox_package::ensure_import(&content);
    let source = super::super::typst::inject_style_cascade(&content, &path_buf, &state).await;
    let source =
        super::super::typst::maybe_inject_set_notebox(&source, &state, CompilePurpose::Export)
            .await;
    // typst-html drops `align()` blocks; re-emit them so their content is kept.
    let source = crate::typst_pipeline::style_injection::inject_html_align_shim(&source);
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

    let mut cmd = tokio::process::Command::new(&pandoc_path);
    cmd.args(write_pandoc_input(&html, temp_dir.path()).await?);

    if format == "latex" && !normalized.is_empty() {
        cmd.arg("--standalone");
    }

    cmd.arg("-o").arg(&output_path);

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

    let metadata = (!raw_metadata.is_empty()).then_some(normalized.as_slice());
    let bibliography = BibliographyLayout::from_html(&html);
    match format.as_str() {
        "docx" => postprocess_docx(&output_path, metadata, bibliography)?,
        "odt" => postprocess_odt(&output_path, metadata, bibliography)?,
        "latex" => {
            if let Some(metadata) = metadata {
                postprocess_latex(&output_path, metadata).await?;
            }
        }
        _ => {}
    }

    companion.copy().await
}

/// Prepare Typst's HTML for Pandoc and write it to `dir` with the filters that
/// carry over what Pandoc's HTML reader would lose. Returns the arguments that
/// make Pandoc read it.
async fn write_pandoc_input(html: &str, dir: &Path) -> Result<Vec<OsString>, InkyCapError> {
    let html = mirror_img_style_size_to_attrs(html);
    let html = pandoc_footnotes::keep_footnote_list(&html);

    let input = dir.join("input.html");
    let mut args: Vec<OsString> = vec!["-f".into(), "html".into(), input.clone().into()];
    let mut files = vec![(input, html.as_str())];
    for (name, filter) in [
        ("footnotes.lua", pandoc_footnotes::LUA_FILTER),
        ("bibliography.lua", pandoc_bibliography::LUA_FILTER),
    ] {
        let path = dir.join(name);
        args.push("--lua-filter".into());
        args.push(path.clone().into());
        files.push((path, filter));
    }
    for (path, text) in files {
        tokio::fs::write(&path, text)
            .await
            .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write temp file: {}", e)))?;
    }
    Ok(args)
}

/// Pandoc's HTML reader sizes images from `width`/`height` attributes, not the
/// inline CSS Typst writes (`<img … style="width: 25%">`), and otherwise uses
/// the image's pixel size, which overflows the page in DOCX/ODT. Copy width and
/// height from the style into attributes (unless already present) so the sizing
/// carries over. `auto` and empty values are skipped.
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

/// Rewrite the parts of a DOCX or ODT file (both are ZIP archives). `edit` gets
/// each part's name and text and returns the new text, or `None` to keep the
/// part as it is.
fn rewrite_document_parts(
    path: &str,
    edit: impl Fn(&str, &str) -> Option<String>,
) -> Result<(), InkyCapError> {
    use std::io::{Read as _, Write as _};

    let failed = |what: &str, e: &dyn std::fmt::Display| {
        InkyCapError::ExportFailed(format!("Failed to {what} {path}: {e}"))
    };

    let data = std::fs::read(path).map_err(|e| failed("read", &e))?;
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(&data)).map_err(|e| failed("open", &e))?;

    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| failed("read", &e))?;
        let name = entry.name().to_string();
        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .map_err(|e| failed("read", &e))?;

        if let Some(edited) = std::str::from_utf8(&content)
            .ok()
            .and_then(|text| edit(&name, text))
        {
            content = edited.into_bytes();
        }

        // ODT requires its `mimetype` part to be stored uncompressed.
        let compression = if name == "mimetype" {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        };
        let opts = zip::write::SimpleFileOptions::default().compression_method(compression);
        writer
            .start_file(&name, opts)
            .map_err(|e| failed("write", &e))?;
        writer
            .write_all(&content)
            .map_err(|e| failed("write", &e))?;
    }

    let rewritten = writer.finish().map_err(|e| failed("write", &e))?;
    std::fs::write(path, rewritten.into_inner()).map_err(|e| failed("write", &e))
}

/// Fix up a DOCX file. With `metadata`, remove the title block from the body and
/// write the metadata into `docProps/core.xml`, since Pandoc's --metadata doesn't
/// always set it. With `bibliography`, set the indent of the bibliography style.
fn postprocess_docx(
    path: &str,
    metadata: Option<&[(String, String)]>,
    bibliography: Option<BibliographyLayout>,
) -> Result<(), InkyCapError> {
    if metadata.is_none() && bibliography.is_none() {
        return Ok(());
    }
    let title_styles =
        regex::Regex::new(r#"<w:pStyle w:val="(Title|Subtitle|Author|Date)"\s*/>"#).unwrap();

    rewrite_document_parts(path, |name, xml| match name {
        "word/document.xml" => metadata.map(|_| strip_docx_title_paragraphs(xml, &title_styles)),
        "docProps/core.xml" => metadata.map(|m| inject_docx_core_properties(xml, m)),
        "word/styles.xml" => bibliography.map(|b| b.apply_to_docx_styles(xml)),
        _ => None,
    })
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

/// Fix up an ODT file. With `metadata`, remove the title block from the body and
/// write the metadata into `meta.xml`. With `bibliography`, add the bibliography
/// style.
fn postprocess_odt(
    path: &str,
    metadata: Option<&[(String, String)]>,
    bibliography: Option<BibliographyLayout>,
) -> Result<(), InkyCapError> {
    if metadata.is_none() && bibliography.is_none() {
        return Ok(());
    }
    let title_styles =
        regex::Regex::new(r#"text:style-name="(Title|Subtitle|Author|Date)""#).unwrap();

    rewrite_document_parts(path, |name, xml| match name {
        "content.xml" => metadata.map(|_| strip_odt_title_paragraphs(xml, &title_styles)),
        "meta.xml" => metadata.map(|m| inject_odt_meta_properties(xml, m)),
        "styles.xml" => bibliography.map(|b| b.apply_to_odt_styles(xml)),
        _ => None,
    })
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

/// Fix up LaTeX output: remove `\title`, `\author`, `\date` and `\maketitle`,
/// so metadata appears only in `\hypersetup` (PDF properties), not in the body.
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

#[cfg(test)]
mod tests {
    use super::*;

    const BIBLIOGRAPHY: &str = r##"<p>As shown <a href="#loc-3">[1]</a>.</p><ul><li>An ordinary bullet</li></ul><section role="doc-bibliography"><h2>References</h2><ul style="list-style-type: none"><li id="loc-3"><span class="prefix"><a href="#loc-1">[1]</a></span> P. Otlet, <em>Traité de documentation</em>. 1934.</li></ul></section>"##;

    /// Run Pandoc on `html` as an export does, or return `None` when it isn't
    /// installed.
    async fn run_pandoc(html: &str, format: &str, output: &Path) -> Option<()> {
        let pandoc = which::which("pandoc").ok()?;
        let dir = tempfile::tempdir().expect("tempdir");
        let status = tokio::process::Command::new(pandoc)
            .args(write_pandoc_input(html, dir.path()).await.expect("input"))
            .args(["--wrap=none", "-t", format, "-o"])
            .arg(output)
            .status()
            .await
            .expect("run pandoc");
        assert!(status.success());
        Some(())
    }

    /// Export `html` and return the result as text, or `None` without Pandoc.
    async fn exported_text(html: &str, format: &str) -> Option<String> {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("out");
        run_pandoc(html, format, &output).await?;
        Some(std::fs::read_to_string(output).expect("read output"))
    }

    /// Export `BIBLIOGRAPHY` and return the named part of the file, or `None`
    /// without Pandoc.
    async fn exported_part(format: &str, part: &str) -> Option<String> {
        use std::io::Read as _;

        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("out");
        run_pandoc(BIBLIOGRAPHY, format, &output).await?;

        let path = output.to_str().expect("UTF-8 temp path");
        let layout = BibliographyLayout::from_html(BIBLIOGRAPHY);
        match format {
            "docx" => postprocess_docx(path, None, layout),
            _ => postprocess_odt(path, None, layout),
        }
        .expect("postprocess");

        let file = std::fs::File::open(&output).expect("open output");
        let mut archive = zip::ZipArchive::new(file).expect("read output");
        let mut text = String::new();
        archive
            .by_name(part)
            .expect("part exists")
            .read_to_string(&mut text)
            .expect("read part");
        Some(text)
    }

    #[tokio::test]
    async fn docx_bibliography_entries_are_styled_paragraphs() {
        let Some(body) = exported_part("docx", "word/document.xml").await else {
            return;
        };
        assert!(body.contains(r#"<w:pStyle w:val="Bibliography""#), "{body}");
        assert!(body.contains("<w:tab/>"), "{body}");
        // Only the note's own list is bulleted.
        assert_eq!(body.matches("<w:numPr>").count(), 1, "{body}");
        let styles = exported_part("docx", "word/styles.xml")
            .await
            .expect("pandoc ran");
        assert!(styles.contains(r#"<w:ind w:left="516" w:hanging="516""#));
    }

    #[tokio::test]
    async fn odt_bibliography_entries_are_styled_paragraphs() {
        let Some(body) = exported_part("odt", "content.xml").await else {
            return;
        };
        assert!(
            body.contains(r#"<text:p text:style-name="Bibliography">"#),
            "{body}"
        );
        assert!(body.contains("<text:tab/>"), "{body}");
        assert_eq!(body.matches("<text:list-item>").count(), 1, "{body}");
        let styles = exported_part("odt", "styles.xml")
            .await
            .expect("pandoc ran");
        assert!(styles.contains(r#"style:name="Bibliography""#));
    }

    /// Wrap footnote entries in the list Typst's HTML puts them in.
    fn with_footnotes(text: &str, entries: &str) -> String {
        format!(
            r#"{text}<section role="doc-endnotes"><ol style="list-style-type: none">{entries}</ol></section>"#
        )
    }

    fn reference(entry: &str) -> String {
        format!(r##"<sup role="doc-noteref"><a href="#{entry}">1</a></sup>"##)
    }

    const BACKLINK: &str = r##"<sup role="doc-backlink"><a href="#loc-1">1</a></sup>"##;

    #[tokio::test]
    async fn footnotes_become_real_footnotes() {
        let html = with_footnotes(
            &format!(
                "<p>One{} and two{}, 5<sup>2</sup>.</p>",
                reference("a"),
                reference("b")
            ),
            &format!(
                r#"<li id="a">{BACKLINK}Note <em>é</em>.</li><li id="b"><p>{BACKLINK}First.</p><p>Second.</p></li>"#
            ),
        );
        let Some(latex) = exported_text(&html, "latex").await else {
            return;
        };
        assert!(
            latex.contains(r"One\footnote{Note \emph{é}.} and two\footnote{First."),
            "{latex}"
        );
        assert!(
            latex.contains("Second.}, 5\\textsuperscript{2}."),
            "{latex}"
        );
    }

    #[tokio::test]
    async fn a_footnote_inside_a_footnote_goes_in_parentheses() {
        let html = with_footnotes(
            &format!("<p>One{}.</p>", reference("a")),
            &format!(
                r#"<li id="a">{BACKLINK}See{}.</li><li id="b">{BACKLINK}Bush</li>"#,
                reference("b")
            ),
        );
        let Some(latex) = exported_text(&html, "latex").await else {
            return;
        };
        assert_eq!(latex.trim(), r"One\footnote{See (Bush).}.");
    }

    #[tokio::test]
    async fn a_footnote_nothing_refers_to_is_kept() {
        let html = with_footnotes(
            "<p>One.</p>",
            &format!(r#"<li id="a">{BACKLINK}Stray note</li>"#),
        );
        let Some(text) = exported_text(&html, "plain").await else {
            return;
        };
        assert!(text.contains("Stray note"), "{text}");
    }

    #[tokio::test]
    async fn a_footnote_referring_to_itself_ends() {
        let html = with_footnotes(
            &format!("<p>One{}.</p>", reference("a")),
            &format!(r#"<li id="a">{BACKLINK}Loop{}</li>"#, reference("a")),
        );
        let Some(text) = exported_text(&html, "plain").await else {
            return;
        };
        assert!(text.contains("Loop"), "{text}");
    }
}
