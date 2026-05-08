//! Export commands for Typst notes and collections.
//!
//! - PDF export via `typst-pdf` (single note or collection)
//! - Self-contained `.typ` export (inlines the `inkycap-vault` package)
//! - Pandoc-based multi-format export (HTML, DOCX, ODT, LaTeX)
//! - CSV export for collection table data

use std::path::{Path, PathBuf};

use tauri::State;

use crate::errors::InkyCapError;
use crate::models::note::PropertyValue;
use crate::state::AppState;
use crate::storage::traits::VaultStorage;
use crate::typst_pipeline::compiler::PdfStandardPreset;
use crate::typst_pipeline::style_injection;

// ── PDF export ────────────────────────────────────────────────────

/// Export a single note to PDF. Returns the raw PDF bytes.
#[tauri::command]
pub async fn export_note_pdf(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = crate::vault_package::ensure_import(&content);

    let source = super::typst::inject_style_cascade(&content, &path_buf, &state).await;

    let vault_root = state.vault_root.read().await;
    let effective_bib = resolve_effective_bib(None, vault_root.as_deref(), &state).await;
    let source = maybe_inject_bibliography(source, effective_bib.as_deref(), None);

    let mut compiler = state.typst_compiler.lock().await;
    let compiler = compiler
        .as_mut()
        .ok_or(InkyCapError::VaultNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    let pdf_bytes = compiler
        .compile_pdf(&path_buf, source, PdfStandardPreset::default())
        .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?;

    Ok(pdf_bytes)
}

/// Export a single note to PDF, saving to the given output path.
///
/// `metadata_mode`: "exclude" (default) or "properties" (set title/author/date/keywords
/// as PDF document properties via `#set document(...)`).
#[tauri::command]
pub async fn export_note_pdf_to_file(
    path: String,
    output_path: String,
    metadata_mode: String,
    pdf_standard: Option<PdfStandardPreset>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = crate::vault_package::ensure_import(&content);

    let source = if metadata_mode == "properties" {
        inject_document_metadata(&content)
    } else {
        content
    };

    let source = super::typst::inject_style_cascade(&source, &path_buf, &state).await;

    let vault_root = state.vault_root.read().await;
    let effective_bib = resolve_effective_bib(None, vault_root.as_deref(), &state).await;
    let source = maybe_inject_bibliography(source, effective_bib.as_deref(), None);

    let mut compiler = state.typst_compiler.lock().await;
    let compiler = compiler
        .as_mut()
        .ok_or(InkyCapError::VaultNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    let standard = pdf_standard.unwrap_or_default();
    let source = ensure_document_date_for_standard(source, standard);
    let pdf_bytes = compiler
        .compile_pdf(&path_buf, source, standard)
        .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?;

    tokio::fs::write(&output_path, &pdf_bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))
}

// ── Self-contained .typ export ────────────────────────────────────

/// Export a note as a self-contained `.typ` file with the `inkycap-vault`
/// package inlined, written directly to the output path.
#[tauri::command]
pub async fn export_self_contained_typ(
    path: String,
    output_path: String,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;

    let inlined = inline_package(&content);
    tokio::fs::write(&output_path, inlined.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write .typ file: {}", e)))
}

/// Inline the `inkycap-vault` package into a note's source. Replaces the
/// `#import "/.inkycap/packages/..."` line with the full package source
/// prefixed by a comment marker.
fn inline_package(source: &str) -> String {
    let lib_source = std::str::from_utf8(crate::vault_package::LIB_TYP_BYTES)
        .unwrap_or("// inkycap-vault package could not be inlined");

    let import_prefix = "#import \"/.inkycap/packages/inkycap-vault/";
    let mut result = String::with_capacity(source.len() + lib_source.len() + 200);

    let mut found_import = false;
    for line in source.lines() {
        if line.starts_with(import_prefix) && !found_import {
            found_import = true;
            result.push_str("// ── inkycap-vault package (inlined for portability) ──\n");
            result.push_str(lib_source);
            result.push_str("\n// ── end inkycap-vault ──\n");
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }

    if !found_import {
        // No import found — prepend the package
        let mut prefixed = String::with_capacity(result.len() + lib_source.len() + 200);
        prefixed.push_str("// ── inkycap-vault package (inlined for portability) ──\n");
        prefixed.push_str(lib_source);
        prefixed.push_str("\n// ── end inkycap-vault ──\n\n");
        prefixed.push_str(&result);
        return prefixed;
    }

    result
}

// ── Native HTML export ───────────────────────────────────────────

/// Export a note to HTML using Typst's native HTML backend. Optionally
/// injects `<meta>` tags for note properties.
#[tauri::command]
pub async fn export_note_html(
    path: String,
    output_path: String,
    metadata_mode: String,
    strip_wikilinks: Option<bool>,
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

    let content = super::typst::inject_style_cascade(&content, &path_buf, &state).await;

    let vault_root = state.vault_root.read().await;
    let effective_bib = resolve_effective_bib(None, vault_root.as_deref(), &state).await;
    let source = maybe_inject_bibliography(content, effective_bib.as_deref(), None);

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

// ── Collection-level PDF export ───────────────────────────────────

/// Export a single note from a collection as PDF, applying the collection's
/// `typst_template` and `bibliography_style` if set.
#[tauri::command]
pub async fn export_collection_note_pdf(
    note_path: String,
    collection_path: String,
    output_path: String,
    metadata_mode: Option<String>,
    pdf_standard: Option<PdfStandardPreset>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let storage = state.get_storage().await?;
    let note_path_buf = PathBuf::from(&note_path);
    let collection_path_buf = PathBuf::from(&collection_path);

    let content = storage.read_file(&note_path_buf).await?;
    let content = crate::vault_package::ensure_import(&content);
    let collection_content = storage.read_file(&collection_path_buf).await?;
    let base = crate::collection_parser::model::parse_collection_file(&collection_content)?;

    let source = if metadata_mode.as_deref() == Some("properties") {
        inject_document_metadata(&content)
    } else {
        content
    };

    // Inject style cascade: app defaults + collection style
    let app_settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_rules(&app_settings.document, &app_settings.appearance.monospace_font);
    drop(app_settings);
    let collection_rules = base.style.as_ref().map(|s| s.to_typst_set_rules());
    let source = style_injection::inject_style_rules(
        &source,
        if defaults_rules.is_empty() { None } else { Some(&defaults_rules) },
        collection_rules.as_deref().filter(|r| !r.is_empty()),
    );

    let vault_root = state.vault_root.read().await;
    let vault_root_ref = vault_root.as_deref();

    let effective_bib = resolve_effective_bib(
        base.bibliography_file.as_deref(),
        vault_root_ref,
        &state,
    ).await;
    let source = maybe_inject_bibliography(
        source,
        effective_bib.as_deref(),
        base.bibliography_style.as_deref(),
    );

    let mut compiler = state.typst_compiler.lock().await;
    let compiler = compiler
        .as_mut()
        .ok_or(InkyCapError::VaultNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    let resolved_template = base.typst_template.as_deref()
        .map(|t| resolve_template_path_with_root(t, vault_root_ref));

    let standard = pdf_standard.unwrap_or_default();
    let source = ensure_document_date_for_standard(source, standard);
    let pdf_bytes: Vec<u8> = if let Some(ref template) = resolved_template {
        compiler
            .compile_pdf_with_template(
                &note_path_buf,
                source,
                template,
                base.bibliography_style.as_deref(),
                standard,
            )
            .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?
    } else {
        if let Some(ref style) = base.bibliography_style {
            compiler.set_bibliography_style(Some(style.clone()));
        }
        let result = compiler
            .compile_pdf(&note_path_buf, source, standard)
            .map_err(|e| InkyCapError::ExportFailed(e.to_string()));
        compiler.set_bibliography_style(None);
        result?
    };

    tokio::fs::write(&output_path, &pdf_bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))?;

    Ok(())
}

/// Batch-export all notes in a collection to PDF files in the given output directory.
#[tauri::command]
pub async fn export_collection_batch_pdf(
    collection_path: String,
    view_name: String,
    output_dir: String,
    metadata_mode: Option<String>,
    pdf_standard: Option<PdfStandardPreset>,
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

    // Pre-compute style injection strings (same for all notes in the collection)
    let app_settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_rules(&app_settings.document, &app_settings.appearance.monospace_font);
    drop(app_settings);
    let collection_rules = base.style.as_ref().map(|s| s.to_typst_set_rules());

    let vault_root = state.vault_root.read().await;
    let vault_root_ref = vault_root.as_deref();
    let resolved_template = base.typst_template.as_deref()
        .map(|t| resolve_template_path_with_root(t, vault_root_ref));
    let effective_bib = resolve_effective_bib(
        base.bibliography_file.as_deref(),
        vault_root_ref,
        &state,
    ).await;
    let mut exported = Vec::new();
    let mut errors = Vec::new();

    for row in &data.rows {
        let note_path_buf = PathBuf::from(&row.file_path);
        let content = match storage.read_file(&note_path_buf).await {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{}: {}", row.file_name, e));
                continue;
            }
        };

        let content = crate::vault_package::ensure_import(&content);
        let source = if metadata_mode.as_deref() == Some("properties") {
            inject_document_metadata(&content)
        } else {
            content
        };
        let source = style_injection::inject_style_rules(
            &source,
            if defaults_rules.is_empty() { None } else { Some(&defaults_rules) },
            collection_rules.as_deref().filter(|r| !r.is_empty()),
        );
        let source = maybe_inject_bibliography(
            source,
            effective_bib.as_deref(),
            base.bibliography_style.as_deref(),
        );

        let mut compiler = state.typst_compiler.lock().await;
        let compiler = compiler
            .as_mut()
            .ok_or(InkyCapError::VaultNotOpen)?;
        compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

        let standard = pdf_standard.unwrap_or_default();
        let source = ensure_document_date_for_standard(source, standard);
        let compile_result: Result<Vec<u8>, _> = if let Some(ref template) = resolved_template {
            compiler
                .compile_pdf_with_template(
                    &note_path_buf,
                    source,
                    template,
                    base.bibliography_style.as_deref(),
                    standard,
                )
                .map_err(|e| format!("{}: {}", row.file_name, e))
        } else {
            if let Some(ref style) = base.bibliography_style {
                compiler.set_bibliography_style(Some(style.clone()));
            }
            let result = compiler
                .compile_pdf(&note_path_buf, source, standard)
                .map_err(|e| format!("{}: {}", row.file_name, e));
            compiler.set_bibliography_style(None);
            result
        };

        let pdf_bytes = match compile_result {
            Ok(bytes) => bytes,
            Err(msg) => {
                errors.push(msg);
                continue;
            }
        };

        let pdf_name = row
            .file_name
            .strip_suffix(".typ")
            .unwrap_or(&row.file_name);
        let pdf_path = output_dir.join(format!("{}.pdf", pdf_name));
        if let Err(e) = tokio::fs::write(&pdf_path, &pdf_bytes).await {
            errors.push(format!("{}: {}", pdf_name, e));
            continue;
        }
        exported.push(pdf_path.display().to_string());
    }

    if exported.is_empty() && !errors.is_empty() {
        return Err(InkyCapError::ExportFailed(
            format!("All files failed to export:\n{}", errors.join("\n")),
        ));
    }

    if !errors.is_empty() {
        eprintln!("Batch export: {} of {} files failed:\n{}", errors.len(), data.rows.len(), errors.join("\n"));
    }

    Ok(exported)
}

// ── Book (merged collection) export ───────────────────────────────

/// Per-export overrides supplied by the "Export as book" dialog. Any field
/// left as `None` falls back to the value stored in the collection's
/// `book:` block, then to the built-in default. Mirrors the optional fields
/// of [`crate::collection_parser::model::BookExportConfig`] plus a flag
/// controlling whether the resolved values are persisted back to the
/// collection file.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookExportOverrides {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub toc_depth: Option<u8>,
    pub number_chapters: Option<bool>,
    pub inject_chapter_heading: Option<crate::collection_parser::model::InjectChapterHeading>,
    pub wikilink_mode: Option<crate::collection_parser::model::BookWikilinkMode>,
    pub include_title_page: Option<bool>,
    pub include_outline: Option<bool>,
    pub page_numbering: Option<crate::collection_parser::model::BookPageNumbering>,
    pub pdf_standard: Option<PdfStandardPreset>,
}

/// Detected user-label collision returned to the frontend so the UI can
/// present a clear error before any compile is attempted.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BookLabelCollision {
    pub label: String,
    pub notes: Vec<String>,
}

/// Export the notes in a collection as a single merged PDF — title page,
/// optional abstract, outline, sequential chapters, and one bibliography.
/// Notes are inlined into a synthetic Typst document; nothing is written to
/// disk besides the final PDF.
#[tauri::command]
pub async fn export_collection_book_pdf(
    collection_path: String,
    view_name: String,
    output_path: String,
    overrides: Option<BookExportOverrides>,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    use crate::typst_pipeline::book_wrapper::{
        self, BookExportOptions, BookNote,
    };

    // 1. Load the collection definition and the ordered set of rows.
    let data = crate::commands::collections::get_collection_data_internal(
        &collection_path, &view_name, &state,
    )
    .await?;

    let storage = state.get_storage().await?;
    let collection_path_buf = PathBuf::from(&collection_path);
    let collection_content = storage.read_file(&collection_path_buf).await?;
    let base = crate::collection_parser::model::parse_collection_file(&collection_content)?;

    if data.rows.is_empty() {
        return Err(InkyCapError::ExportFailed(
            "Collection contains no notes to export.".to_string(),
        ));
    }

    // 2. Resolve effective options: collection book config + dialog overrides.
    let book_pdf_standard = overrides.as_ref().and_then(|o| o.pdf_standard).unwrap_or_default();
    let mut options = BookExportOptions::from_config(base.book.as_ref());
    if let Some(ov) = overrides {
        if ov.title.is_some() { options.title = ov.title; }
        if ov.subtitle.is_some() { options.subtitle = ov.subtitle; }
        if ov.author.is_some() { options.author = ov.author; }
        if ov.date.is_some() { options.date = ov.date; }
        if ov.abstract_text.is_some() { options.abstract_text = ov.abstract_text; }
        if let Some(v) = ov.toc_depth { options.toc_depth = v; }
        if let Some(v) = ov.number_chapters { options.number_chapters = v; }
        if let Some(v) = ov.inject_chapter_heading { options.inject_chapter_heading = v; }
        if let Some(v) = ov.wikilink_mode { options.wikilink_mode = v; }
        if let Some(v) = ov.include_title_page { options.include_title_page = v; }
        if let Some(v) = ov.include_outline { options.include_outline = v; }
        if let Some(v) = ov.page_numbering { options.page_numbering = v; }
    }

    // 3. Read each note, extracting its title for fallback chapter headings.
    let mut notes: Vec<BookNote> = Vec::with_capacity(data.rows.len());
    for row in &data.rows {
        let note_path_buf = PathBuf::from(&row.file_path);
        let content = storage.read_file(&note_path_buf).await?;
        let stem = note_path_buf
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| row.file_name.clone());
        let title = extract_note_title(&content);
        notes.push(BookNote {
            stem,
            abs_path: note_path_buf,
            content: content.into(),
            title,
        });
    }

    // 4. Pre-scan for label collisions before invoking the compiler — Typst
    //    would error out anyway, but its message would point at line numbers
    //    in the synthesized wrapper that the user never sees.
    let collisions = book_wrapper::scan_label_collisions(&notes);
    if !collisions.is_empty() {
        let lines: Vec<String> = collisions
            .iter()
            .map(|c| format!("  <{}> in: {}", c.label, c.notes.join(", ")))
            .collect();
        return Err(InkyCapError::ExportFailed(format!(
            "Label collisions detected. The merged book cannot define the same label in multiple notes:\n{}",
            lines.join("\n")
        )));
    }

    // 5. Resolve template, bibliography, and style cascade.
    let app_settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_rules(&app_settings.document, &app_settings.appearance.monospace_font);
    drop(app_settings);
    let collection_rules = base.style.as_ref().map(|s| s.to_typst_set_rules());

    let mut style_rules = String::new();
    if !defaults_rules.is_empty() {
        style_rules.push_str(&defaults_rules);
        if !style_rules.ends_with('\n') {
            style_rules.push('\n');
        }
    }
    if let Some(r) = collection_rules.as_deref().filter(|r| !r.is_empty()) {
        style_rules.push_str(r);
        if !style_rules.ends_with('\n') {
            style_rules.push('\n');
        }
    }

    let vault_root_guard = state.vault_root.read().await;
    let vault_root_ref = vault_root_guard.as_deref();
    let resolved_template = base.typst_template.as_deref()
        .map(|t| resolve_template_path_with_root(t, vault_root_ref));
    let template_import_line = resolved_template
        .as_ref()
        .map(|t| format!("#import \"{}\": *\n", t));
    let effective_bib = resolve_effective_bib(
        base.bibliography_file.as_deref(),
        vault_root_ref,
        &state,
    ).await;
    let bib_path_for_wrapper: Option<String> = effective_bib.as_deref().map(|b| {
        if b.starts_with('/') { b.to_string() } else { format!("/{b}") }
    });

    // The synthetic main path. Lives under the vault root so the Typst world
    // accepts it; never written to disk. Filename derived from the
    // collection stem to make compile diagnostics readable.
    let synthetic_main = {
        let stem = collection_path_buf
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "book".to_string());
        let parent = collection_path_buf
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| {
                vault_root_ref
                    .map(|p| p.to_path_buf())
                    .unwrap_or_default()
            });
        parent.join(format!("{}.book.typ", stem))
    };
    drop(vault_root_guard);

    // Pull the user's Style Overrides patterns through to the book
    // wrapper so they aren't silently clobbered by the wrapper's own
    // defaults (page numbering "1", heading numbering "1.1"). Without
    // this, anything typed in Style Overrides → Page numbering or
    // Heading numbering would have no effect on the merged output.
    let body_numbering_pattern = base
        .style
        .as_ref()
        .and_then(|s| s.page.as_ref())
        .and_then(|p| p.numbering.clone());
    let heading_numbering_pattern = base
        .style
        .as_ref()
        .and_then(|s| s.heading.as_ref())
        .and_then(|h| h.numbering.clone());

    // 6. Build the wrapper source.
    let normalize_headings = book_pdf_standard == PdfStandardPreset::PdfUa1;
    let source = book_wrapper::build_book_source(
        &notes,
        &options,
        if style_rules.is_empty() { None } else { Some(&style_rules) },
        template_import_line.as_deref(),
        bib_path_for_wrapper.as_deref(),
        base.bibliography_style.as_deref(),
        normalize_headings,
        body_numbering_pattern.as_deref(),
        heading_numbering_pattern.as_deref(),
    );

    // 7. Compile.
    let mut compiler = state.typst_compiler.lock().await;
    let compiler = compiler
        .as_mut()
        .ok_or(InkyCapError::VaultNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    if let Some(ref style) = base.bibliography_style {
        compiler.set_bibliography_style(Some(style.clone()));
    }
    let source = ensure_document_date_for_standard(source, book_pdf_standard);
    let compile_result = compiler
        .compile_pdf(&synthetic_main, source, book_pdf_standard)
        .map_err(|e| InkyCapError::ExportFailed(e.to_string()));
    compiler.set_bibliography_style(None);
    let pdf_bytes = compile_result?;

    // 8. Write the PDF.
    tokio::fs::write(&output_path, &pdf_bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))?;

    Ok(output_path)
}

/// Extract a `title:` value from the leading `#note(...)` call of a note's
/// source, returning the unquoted plain-text form if present.
fn extract_note_title(content: &str) -> Option<String> {
    use crate::typst_pipeline::note_rewriter::{
        extract_note_properties, typst_value_to_plain_text,
    };
    extract_note_properties(content)
        .into_iter()
        .find(|(k, _)| k == "title")
        .map(|(_, v)| typst_value_to_plain_text(&v))
        .filter(|s| !s.is_empty())
}

// ── Static site export ───────────────────────────────────────────

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

    let vault_root = state.vault_root.read().await;
    let effective_bib = resolve_effective_bib(None, vault_root.as_deref(), &state).await;

    let app_settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_rules(&app_settings.document, &app_settings.appearance.monospace_font);
    drop(app_settings);
    let collection_rules = base.style.as_ref().map(|s| s.to_typst_set_rules());

    // Build a map of note names → html filenames for wikilink rewriting
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
        let content = crate::vault_package::ensure_import(&content);
        let content = rewrite_wikilinks_to_links(&content, &name_to_file);
        let content = style_injection::inject_style_rules(
            &content,
            if defaults_rules.is_empty() { None } else { Some(&defaults_rules) },
            collection_rules.as_deref().filter(|r| !r.is_empty()),
        );
        let source = maybe_inject_bibliography(content, effective_bib.as_deref(), None);

        let mut compiler = state.typst_compiler.lock().await;
        let compiler = compiler
            .as_mut()
            .ok_or(InkyCapError::VaultNotOpen)?;
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

        // Wrap in full HTML page with CSS link if Typst didn't produce a full document
        let full_html = if html.contains("<html") {
            // Inject stylesheet link into existing <head>
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

    // Generate index.html
    let index_html = generate_site_index(&data.rows, &name_to_file);
    tokio::fs::write(output_dir.join("index.html"), index_html.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write index.html: {}", e)))?;
    exported.push("index.html".to_string());

    // Write default stylesheet
    tokio::fs::write(output_dir.join("style.css"), DEFAULT_SITE_CSS.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write style.css: {}", e)))?;
    exported.push("style.css".to_string());

    Ok(exported)
}

/// Convert a note name to a URL-friendly slug.
fn slug_from_name(name: &str) -> String {
    name.to_lowercase()
        .replace(' ', "-")
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "")
}

/// Generate a simple index page listing all notes in the collection.
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

// ── Pandoc-based multi-format export ──────────────────────────────

/// Detect if Pandoc is available on the system. Returns the path if found.
#[tauri::command]
pub async fn detect_pandoc() -> Result<Option<String>, InkyCapError> {
    // Check settings first
    let settings = crate::settings::load_settings();
    if let Some(ref custom) = settings.export.pandoc_path {
        if !custom.is_empty() && Path::new(custom).exists() {
            return Ok(Some(custom.clone()));
        }
    }

    // Check PATH
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

/// Determine the bibliography file to use for export. Collection-level
/// `bibliography_file` takes priority; otherwise falls back to the global
/// citation settings (Zotero export or user-configured `.bib`).
async fn resolve_effective_bib(
    collection_bib: Option<&str>,
    vault_root: Option<&Path>,
    state: &State<'_, AppState>,
) -> Option<String> {
    if let Some(bib) = collection_bib {
        if !bib.is_empty() {
            return Some(bib.to_string());
        }
    }
    let vault_root = vault_root?;
    let settings = state.settings.read().await;
    crate::state::configure_bibliography(vault_root, &settings.citations)
}

/// Append a `#bibliography(...)` call to the source when the collection
/// specifies a bibliography file and the source contains `@` citations.
fn maybe_inject_bibliography(source: String, bib_file: Option<&str>, bib_style: Option<&str>) -> String {
    let Some(bib) = bib_file else { return source };
    if bib.is_empty() { return source };
    let bib = if bib.starts_with('/') { bib.to_string() } else { format!("/{bib}") };

    let has_explicit_bib = source.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.starts_with("//") && trimmed.contains("#bibliography(")
    });
    if has_explicit_bib { return source };

    let has_citation = source.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with("//") { return false; }
        trimmed.contains('@') && !trimmed.starts_with("#import") && !trimmed.starts_with("#set")
    });
    if !has_citation { return source };

    let style_arg = match bib_style {
        Some(s) if !s.is_empty() => format!(", style: \"{}\"", s),
        _ => String::new(),
    };
    format!("{}\n\n#bibliography(\"{}\"{})\n", source.trim_end(), bib, style_arg)
}

/// Rewrite `#wikilink(...)` calls in Typst source to `#link(...)` calls pointing
/// to the target HTML file. Wikilinks to notes outside the collection become
/// plain text.
fn rewrite_wikilinks_to_links(
    source: &str,
    name_to_file: &std::collections::HashMap<String, String>,
) -> String {
    let re = regex::Regex::new(
        r#"#wikilink\("([^"]*)"(?:,\s*display:\s*"([^"]*)")?\)"#,
    )
    .unwrap();
    re.replace_all(source, |caps: &regex::Captures| {
        let target = &caps[1];
        let display = caps.get(2).map(|m| m.as_str()).unwrap_or(target);
        if let Some(file) = name_to_file.get(target) {
            format!("#link(\"{}\")[{}]", file, display)
        } else {
            display.to_string()
        }
    })
    .to_string()
}

/// Strip `#wikilink(...)` calls from source, replacing with their display text.
fn strip_wikilinks_from_source(source: &str) -> String {
    let re = regex::Regex::new(
        r#"#wikilink\("([^"]*)"(?:,\s*display:\s*"([^"]*)")?\)"#,
    )
    .unwrap();
    re.replace_all(source, |caps: &regex::Captures| {
        caps.get(2)
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| caps[1].to_string())
    })
    .to_string()
}

/// Inject `#set document(...)` rule from `#note(...)` properties so that
/// Typst embeds title/author/date/keywords into the compiled document.
/// `typst-pdf` then writes these into the PDF metadata fields.
fn inject_document_metadata(source: &str) -> String {
    use crate::typst_pipeline::note_rewriter::note_call_span;

    let props = extract_metadata_raw(source);
    if props.is_empty() {
        return source.to_string();
    }

    let mut doc_args = Vec::new();

    for (key, value) in &props {
        match key.as_str() {
            "title" => {
                doc_args.push(format!("title: \"{}\"", escape_typst_string(value)));
            }
            "author" => {
                if value.contains(", ") {
                    let authors: Vec<String> = value
                        .split(", ")
                        .map(|a| format!("\"{}\"", escape_typst_string(a)))
                        .collect();
                    doc_args.push(format!("author: ({})", authors.join(", ")));
                } else {
                    doc_args.push(format!("author: \"{}\"", escape_typst_string(value)));
                }
            }
            "date" => {
                // Handle both "2026-04-28" string dates and "datetime(...)" literals
                if value.starts_with("datetime(") {
                    doc_args.push(format!("date: {}", value));
                } else if let Some(dt) = parse_date_to_typst_datetime(value) {
                    doc_args.push(format!("date: {}", dt));
                }
            }
            "tags" | "tag" | "keywords" => {
                let kws: Vec<String> = value
                    .split(", ")
                    .map(|k| format!("\"{}\"", escape_typst_string(k)))
                    .collect();
                doc_args.push(format!("keywords: ({})", kws.join(", ")));
            }
            _ => {}
        }
    }

    if doc_args.is_empty() {
        return source.to_string();
    }

    let set_rule = format!("#set document({})\n", doc_args.join(", "));

    // Insert after the full #note(...) call (which may span multiple lines)
    let insert_after = if let Some(span) = note_call_span(source) {
        let after_call = span.end;
        if source.as_bytes().get(after_call) == Some(&b'\n') {
            after_call + 1
        } else {
            after_call
        }
    } else {
        0
    };

    let mut result = String::with_capacity(source.len() + set_rule.len());
    result.push_str(&source[..insert_after]);
    result.push_str(&set_rule);
    result.push_str(&source[insert_after..]);
    result
}

/// Ensure the source has a `#set document(date: ...)` rule when exporting to a
/// PDF standard that requires one (PDF/A-4, PDF/UA-1). If the note already has
/// a date property and metadata injection is active, the date will already be
/// present. Otherwise we inject today's date as a fallback so the export
/// doesn't fail with "missing document date".
fn ensure_document_date_for_standard(source: String, standard: PdfStandardPreset) -> String {
    if standard == PdfStandardPreset::Standard {
        return source;
    }

    // If a `#set document(` rule already exists, assume it covers the date.
    if source.contains("#set document(") {
        return source;
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let dt = parse_date_to_typst_datetime(&today)
        .unwrap_or_else(|| "datetime.today()".to_string());
    let set_rule = format!("#set document(date: {})\n", dt);

    // Insert after the inkycap-vault import line if present, otherwise prepend.
    let import_marker = "#import \"/.inkycap/packages/inkycap-vault/";
    if let Some(pos) = source.find(import_marker) {
        if let Some(line_end) = source[pos..].find('\n') {
            let insert_at = pos + line_end + 1;
            let mut result = String::with_capacity(source.len() + set_rule.len());
            result.push_str(&source[..insert_at]);
            result.push_str(&set_rule);
            result.push_str(&source[insert_at..]);
            return result;
        }
    }

    format!("{}{}", set_rule, source)
}

/// Parse a date string like "2026-04-28" into a Typst `datetime()` call.
fn parse_date_to_typst_datetime(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() == 3 {
        if let (Ok(y), Ok(m), Ok(d)) = (
            parts[0].parse::<i32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) {
            return Some(format!("datetime(year: {}, month: {}, day: {})", y, m, d));
        }
    }
    None
}

fn escape_typst_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Pre-process Typst source for Pandoc: strip InkyCap-specific constructs.
fn preprocess_for_pandoc(source: &str) -> String {
    use crate::typst_pipeline::note_rewriter::note_call_span;

    // First, remove the full #note(...) call (may span multiple lines)
    let without_note = if let Some(span) = note_call_span(source) {
        let mut s = String::with_capacity(source.len());
        s.push_str(&source[..span.start]);
        // Skip trailing newline after the call
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

    // Strip #import lines
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
fn strip_inkycap_functions(source: &str) -> String {
    let mut result = source.to_string();

    // #wikilink("Note") → Note
    // #wikilink("Note", display: "label") → label
    let wikilink_re = regex::Regex::new(
        r#"#wikilink\("([^"]*)"(?:,\s*display:\s*"([^"]*)")?\)"#,
    )
    .unwrap();
    result = wikilink_re
        .replace_all(&result, |caps: &regex::Captures| {
            caps.get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| caps[1].to_string())
        })
        .to_string();

    // #tag("name") → (strip entirely)
    let tag_re = regex::Regex::new(r#"#tag\("[^"]*"\)\s*"#).unwrap();
    result = tag_re.replace_all(&result, "").to_string();

    // #embed("Note") → (strip — embedded content is separate)
    let embed_re = regex::Regex::new(r#"#embed\("[^"]*"\)"#).unwrap();
    result = embed_re.replace_all(&result, "").to_string();

    // link-ref("Note") → Note (used inside #note(...) but may appear elsewhere)
    let linkref_re = regex::Regex::new(r#"link-ref\("([^"]*)"\)"#).unwrap();
    result = linkref_re.replace_all(&result, "$1").to_string();

    // #set-vault(...) → strip entirely
    let setvault_re = regex::Regex::new(r#"#set-vault\([^)]*\)\s*"#).unwrap();
    result = setvault_re.replace_all(&result, "").to_string();

    // #callout("kind")[body] or #callout("kind", title: "T")[body] → #quote(block: true)[body]
    result = rewrite_content_block_func(&result, "callout", |_args, body| {
        format!("#quote(block: true)[{}]", body)
    });

    // #verse("text") → text as a block quote
    let verse_re = regex::Regex::new(r#"#verse\("([^"]*)"\)"#).unwrap();
    result = verse_re.replace_all(&result, "#quote(block: true)[$1]").to_string();
    // Also handle multi-line verse with content block
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
        let after_hash = &remaining[start + 1..]; // skip '#'

        // Find matching ')' for the args
        let args_start = func_name.len() + 1; // past "func_name("
        let Some(args_end) = find_matching_paren(after_hash, args_start - 1) else {
            result.push_str(&remaining[start..start + pattern.len()]);
            remaining = &remaining[start + pattern.len()..];
            continue;
        };
        let args = &after_hash[args_start..args_end];

        let after_args = &after_hash[args_end + 1..];
        // Check for content block [...]
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
            // No content block — just strip the function call and keep args as text
            result.push_str(&rewriter(args, ""));
            remaining = &after_hash[args_end + 1..];
        }
    }
    result.push_str(remaining);
    result
}

fn find_matching_paren(s: &str, open_pos: usize) -> Option<usize> {
    let mut depth = 0;
    let mut in_string = false;
    let bytes = s.as_bytes();
    for i in open_pos..bytes.len() {
        match bytes[i] {
            b'"' if !in_string => in_string = true,
            b'"' if in_string => in_string = false,
            b'(' if !in_string => depth += 1,
            b')' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn find_matching_bracket(s: &str, open_pos: usize) -> Option<usize> {
    let mut depth = 0;
    let bytes = s.as_bytes();
    for i in open_pos..bytes.len() {
        match bytes[i] {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Extract all `#note(...)` metadata from Typst source as plain-text key-value
/// pairs. Preserves original InkyCap key names (tag, to-do, etc.).
fn extract_metadata_raw(
    source: &str,
) -> Vec<(String, String)> {
    use crate::typst_pipeline::note_rewriter::{extract_note_properties, typst_value_to_plain_text};

    extract_note_properties(source)
        .into_iter()
        .map(|(k, raw_v)| (k, typst_value_to_plain_text(&raw_v)))
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

/// Normalize metadata for document property formats (DOCX/ODT/PDF).
/// Maps InkyCap keys to standard document property keys, normalizes dates,
/// and filters out keys that aren't document properties.
fn normalize_metadata(raw: &[(String, String)]) -> Vec<(String, String)> {
    raw.iter()
        .filter_map(|(k, v)| {
            let key = match k.as_str() {
                "tag" | "tags" => "keywords".to_string(),
                "to-do" | "alias" | "collection" => return None,
                other => other.to_string(),
            };
            let value = if key == "date" {
                normalize_date_value(v)
            } else {
                v.clone()
            };
            Some((key, value))
        })
        .collect()
}

/// Convert datetime-style values to ISO date strings.
/// Handles: `datetime(year: 2026, month: 4, day: 29)` → `2026-04-29`
/// and passes through already-formatted dates like `2026-04-29`.
fn normalize_date_value(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("datetime(") {
        if let Some(inner) = rest.strip_suffix(')') {
            let mut year = None;
            let mut month = None;
            let mut day = None;
            for part in inner.split(',') {
                let part = part.trim();
                if let Some(v) = part.strip_prefix("year:") {
                    year = v.trim().parse::<i32>().ok();
                } else if let Some(v) = part.strip_prefix("month:") {
                    month = v.trim().parse::<u32>().ok();
                } else if let Some(v) = part.strip_prefix("day:") {
                    day = v.trim().parse::<u32>().ok();
                }
            }
            if let (Some(y), Some(m), Some(d)) = (year, month, day) {
                return format!("{:04}-{:02}-{:02}", y, m, d);
            }
        }
    }
    value.to_string()
}

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
    let path_buf = PathBuf::from(&path);
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

    // Pass normalized metadata to Pandoc. Pandoc maps standard keys (title,
    // author, date, keywords) to document properties in the output format.
    if !normalized.is_empty() {
        for (key, value) in &normalized {
            cmd.arg("--metadata").arg(format!("{}={}", key, value));
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

    // Post-process based on format:
    // - HTML: inject all raw metadata as <meta> tags (including to-do, etc.)
    // - DOCX/ODT: strip title block from body AND inject normalized metadata
    //   directly into the document property XML files to guarantee they're set
    // - LaTeX: strip \title, \author, \date, \maketitle (keep \hypersetup for PDF metadata)
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

// ── Metadata post-processing ────────────────────────────────────

/// Inject `<meta>` tags into an HTML file's `<head>`.
async fn inject_html_metadata(
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

    // Find a suitable title from metadata
    let title = metadata
        .iter()
        .find(|(k, _)| k == "title")
        .map(|(_, v)| v.as_str());

    let result = if let Some(head_end) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + meta_tags.len() + 100);
        out.push_str(&html[..head_end]);
        out.push_str(&meta_tags);
        out.push_str(&html[head_end..]);

        // Replace <title> if we have a title
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
        // No <head> found — wrap in a minimal HTML document
        format!(
            "<!DOCTYPE html>\n<html>\n<head>\n{}</head>\n<body>\n{}</body>\n</html>\n",
            meta_tags, html
        )
    };

    tokio::fs::write(path, result)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write HTML: {}", e)))
}

fn escape_html_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

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

/// Remove all `<w:p>` elements that have Title/Author/Date/Subtitle paragraph
/// styles. Unlike the previous approach, this removes ALL matching paragraphs
/// rather than stopping at the first non-title paragraph (which could be an
/// empty spacer paragraph inserted by Pandoc).
fn strip_docx_title_paragraphs(xml: &str, title_styles: &regex::Regex) -> String {
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

/// Inject/update metadata in DOCX `docProps/core.xml`.
fn inject_docx_core_properties(xml: &str, metadata: &[(String, String)]) -> String {
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

/// Remove all `<text:p>` elements that have Title/Author/Date styles from ODT content.
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

/// Inject/update metadata in ODT `meta.xml`. Sets both standard ODF
/// elements (dc:title, meta:initial-creator, etc.) and `meta:user-defined`
/// custom properties so metadata appears in both the Description and
/// Custom Properties tabs of document viewers.
fn inject_odt_meta_properties(xml: &str, metadata: &[(String, String)]) -> String {
    let mut result = xml.to_string();
    let closing = "</office:meta>";

    // Set standard ODF metadata elements
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
                // ODT uses separate <meta:keyword> elements for each keyword.
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

// ── LaTeX post-processing ────────────────────────────────────────

/// Post-process LaTeX output: strip `\title`, `\author`, `\date`, and
/// `\maketitle` so metadata only appears via `\hypersetup` (PDF properties),
/// not as visible content in the body. Also ensures `pdfauthor` is in
/// `\hypersetup` if we have an author.
async fn postprocess_latex(
    path: &str,
    metadata: &[(String, String)],
) -> Result<(), InkyCapError> {
    let latex = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to read LaTeX: {}", e)))?;

    let mut result = latex;

    // Remove \title{...}, \author{...}, \date{...} lines
    let title_cmd_re = regex::Regex::new(r"(?m)^\\(title|author|date)\{[^}]*\}\s*\n").unwrap();
    result = title_cmd_re.replace_all(&result, "").to_string();

    // Remove \maketitle
    let maketitle_re = regex::Regex::new(r"(?m)^\\maketitle\s*\n").unwrap();
    result = maketitle_re.replace_all(&result, "").to_string();

    // Ensure pdfauthor is in \hypersetup if we have an author
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

    // Ensure pdfdate (CreationDate) in \hypersetup if we have a date
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

// ── XML helpers ─────────────────────────────────────────────────

/// Replace the content of an XML element, or insert it before `closing_parent`
/// if the element doesn't exist.
fn upsert_xml_element(xml: &mut String, tag: &str, value: &str, closing_parent: &str) {
    upsert_xml_element_with_attr(xml, tag, value, "", closing_parent);
}

/// Like `upsert_xml_element` but allows extra attributes on the opening tag.
fn upsert_xml_element_with_attr(
    xml: &mut String,
    tag: &str,
    value: &str,
    attr: &str,
    closing_parent: &str,
) {
    let escaped = escape_xml(value);
    let close_tag = format!("</{}>", tag);

    // Try to find and replace existing element (with or without attributes)
    let open_pattern = format!("<{}", tag);
    if let Some(start) = xml.find(&open_pattern) {
        // Find the end of the opening tag (handles attributes)
        if let Some(gt) = xml[start..].find('>') {
            let content_start = start + gt + 1;
            if let Some(close_offset) = xml[content_start..].find(&close_tag) {
                let close_end = content_start + close_offset + close_tag.len();
                let replacement = format!("<{}{}>{}{}",tag, attr, escaped, close_tag);
                xml.replace_range(start..close_end, &replacement);
                return;
            }
        }
    }

    // Element doesn't exist — insert before closing parent tag
    if let Some(pos) = xml.find(closing_parent) {
        let insert = format!("<{}{}>{}{}", tag, attr, escaped, close_tag);
        xml.insert_str(pos, &insert);
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// ── Figure extraction ─────────────────────────────────────────────

/// Extract all `#image(...)` paths from a Typst source file.
fn extract_image_paths(source: &str) -> Vec<String> {
    let re = regex::Regex::new(r#"#image\("([^"]*)""#).unwrap();
    re.captures_iter(source)
        .map(|cap| cap[1].to_string())
        .collect()
}

/// Export figures from a note to a target directory.
#[tauri::command]
pub async fn export_figures(
    path: String,
    output_dir: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, InkyCapError> {
    let storage = state.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let vault_root = state.vault_root.read().await;
    let root = vault_root
        .as_ref()
        .ok_or(InkyCapError::VaultNotOpen)?;

    let content = storage.read_file(&path_buf).await?;
    let image_paths = extract_image_paths(&content);

    let output_dir = PathBuf::from(&output_dir);
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to create output dir: {}", e)))?;

    let mut exported = Vec::new();
    for img_path in &image_paths {
        let abs_img = if img_path.starts_with('/') {
            root.join(&img_path[1..])
        } else {
            path_buf
                .parent()
                .unwrap_or(root)
                .join(img_path)
        };

        if abs_img.exists() {
            let file_name = abs_img
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unknown".to_string());
            let dest = output_dir.join(&file_name);
            tokio::fs::copy(&abs_img, &dest)
                .await
                .map_err(|e| InkyCapError::ExportFailed(format!("Failed to copy {}: {}", file_name, e)))?;
            exported.push(file_name);
        }
    }

    Ok(exported)
}

// ── CSV export (preserved from pre-pivot) ─────────────────────────

/// Export a collection table to a file. `delimiter` can be "comma" (CSV) or "tab" (TSV).
#[tauri::command]
pub async fn export_collection_csv_to_file(
    collection_path: String,
    view_name: String,
    output_path: String,
    delimiter: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let delim = match delimiter.as_deref() {
        Some("tab") => '\t',
        _ => ',',
    };
    let content = build_delimited_export(&collection_path, &view_name, delim, &state).await?;
    tokio::fs::write(&output_path, content.as_bytes())
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write file: {}", e)))?;
    Ok(())
}

#[tauri::command]
pub async fn export_collection_csv(
    collection_path: String,
    view_name: String,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    build_delimited_export(&collection_path, &view_name, ',', &state).await
}

async fn build_delimited_export(
    collection_path: &str,
    view_name: &str,
    delimiter: char,
    state: &State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let data = crate::commands::collections::get_collection_data_internal(
        collection_path, view_name, state,
    )
    .await?;

    let mut out = String::new();

    out.push_str(&delimited_row(&data.columns, delimiter));
    out.push('\n');

    for row in &data.rows {
        let cells: Vec<String> = data
            .columns
            .iter()
            .map(|col| {
                row.cells
                    .get(col)
                    .map(|v| property_value_to_string(v))
                    .unwrap_or_default()
            })
            .collect();
        out.push_str(&delimited_row(&cells, delimiter));
        out.push('\n');
    }

    Ok(out)
}

// ── Helpers ───────────────────────────────────────────────────────

/// Resolve a template reference to a Typst import path.
///
/// - Paths starting with `/` are vault-root-relative, passed through.
/// - Paths starting with `@` are package references, passed through.
/// - Bare names (e.g. `bananote`) are resolved by:
///   1. Scanning the templates folder for a package directory matching
///      `<name>-*` with a `typst.toml` → returns `@<namespace>/<name>:<version>`
///   2. Falling back to a simple file: `/<templates_folder>/<name>.typ`
///
/// When `vault_root` is provided, package-style directories are checked.
/// Without it, only simple file paths are resolved.
pub fn resolve_template_path(template: &str) -> String {
    resolve_template_path_with_root(template, None)
}

pub fn resolve_template_path_with_root(template: &str, vault_root: Option<&Path>) -> String {
    if template.starts_with('/') || template.starts_with('@') {
        return template.to_string();
    }

    let settings = crate::settings::load_settings();
    let folder = settings.files.typst_templates_folder.trim_matches('/');

    if let Some(root) = vault_root {
        let templates_dir = root.join(folder);
        if let Ok(entries) = std::fs::read_dir(&templates_dir) {
            let prefix = format!("{}-", template);
            for entry in entries.flatten() {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                if dir_name.starts_with(&prefix) && entry.path().is_dir() {
                    let toml_path = entry.path().join("typst.toml");
                    if toml_path.exists() {
                        if let Some(spec) = read_package_spec_from_toml(&toml_path) {
                            return spec;
                        }
                    }
                }
            }
            // Also check exact name match (folder named just "<name>")
            let exact_dir = templates_dir.join(template);
            if exact_dir.is_dir() {
                let toml_path = exact_dir.join("typst.toml");
                if toml_path.exists() {
                    if let Some(spec) = read_package_spec_from_toml(&toml_path) {
                        return spec;
                    }
                }
            }
        }
    }

    let name = if template.ends_with(".typ") {
        template.to_string()
    } else {
        format!("{}.typ", template)
    };

    format!("/{}/{}", folder, name)
}

/// Read `name` and `version` from a `typst.toml` and return `@preview/name:version`.
fn read_package_spec_from_toml(toml_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(toml_path).ok()?;
    let name = extract_toml_string_field(&content, "name")?;
    let version = extract_toml_string_field(&content, "version")?;
    Some(format!("@preview/{}:{}", name, version))
}

fn extract_toml_string_field(content: &str, key: &str) -> Option<String> {
    let pattern = format!("{} = \"", key);
    let start = content.find(&pattern)? + pattern.len();
    let end = content[start..].find('"')? + start;
    Some(content[start..end].to_string())
}

fn delimited_row(cells: &[String], delimiter: char) -> String {
    cells
        .iter()
        .map(|c| {
            if c.contains(delimiter) || c.contains('"') || c.contains('\n') {
                format!("\"{}\"", c.replace('"', "\"\""))
            } else {
                c.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(&delimiter.to_string())
}

fn property_value_to_string(value: &PropertyValue) -> String {
    match value {
        PropertyValue::String(s) => s.clone(),
        PropertyValue::Number(n) => n.to_string(),
        PropertyValue::Bool(b) => b.to_string(),
        PropertyValue::List(arr) => {
            let items: Vec<String> = arr.iter().map(property_value_to_string).collect();
            items.join(", ")
        }
        PropertyValue::Null => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocess_strips_import_line() {
        let source = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\n= Hello\n";
        let result = preprocess_for_pandoc(source);
        assert!(!result.contains("#import"));
        assert!(result.contains("= Hello"));
    }

    #[test]
    fn preprocess_strips_note_call() {
        let source = "#note(title: \"Test\", tags: (\"a\", \"b\"))\n\n= Hello\n";
        let result = preprocess_for_pandoc(source);
        assert!(!result.contains("#note("));
        assert!(result.contains("= Hello"));
    }

    #[test]
    fn preprocess_strips_multiline_note_call() {
        let source = concat!(
            "#note(\n",
            "  title: \"Test\",\n",
            "  tag: (\"dogtag\", \"animal\"),\n",
            "  date: \"2026-04-28\",\n",
            "  to-do: false,\n",
            "  alias: \"\",\n",
            ")\n",
            "\n= Hello\n",
        );
        let result = preprocess_for_pandoc(source);
        assert!(!result.contains("#note("), "should strip #note call");
        assert!(!result.contains("dogtag"), "should strip note args");
        assert!(!result.contains("to-do"), "should strip note args");
        assert!(result.contains("= Hello"));
    }

    #[test]
    fn preprocess_replaces_wikilink_with_text() {
        let source = "See #wikilink(\"Other Note\") for details.\n";
        let result = preprocess_for_pandoc(source);
        assert!(result.contains("See Other Note for details."));
    }

    #[test]
    fn preprocess_wikilink_display_label() {
        let source = "See #wikilink(\"Other Note\", display: \"the note\") for details.\n";
        let result = preprocess_for_pandoc(source);
        assert!(result.contains("See the note for details."));
    }

    #[test]
    fn preprocess_strips_tags() {
        let source = "Some text #tag(\"physics\") and more.\n";
        let result = preprocess_for_pandoc(source);
        assert!(!result.contains("#tag"));
        assert!(result.contains("Some text"));
        assert!(result.contains("and more."));
    }

    #[test]
    fn preprocess_strips_embed() {
        let source = "#embed(\"Embedded Note\")\n";
        let result = preprocess_for_pandoc(source);
        assert!(!result.contains("#embed"));
    }

    #[test]
    fn extract_image_paths_finds_all() {
        let source = r#"
= My Note

#image("figures/fig1.png")
Some text.
#image("/assets/photo.jpg", width: 80%)
"#;
        let paths = extract_image_paths(source);
        assert_eq!(paths, vec!["figures/fig1.png", "/assets/photo.jpg"]);
    }

    #[test]
    fn inline_package_replaces_import() {
        let source = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\n= Hello\n";
        let result = inline_package(source);
        assert!(result.contains("inkycap-vault package (inlined for portability)"));
        assert!(!result.contains("#import \"/.inkycap/packages"));
        assert!(result.contains("= Hello"));
    }

    #[test]
    fn inject_document_metadata_sets_title_and_author() {
        let source = concat!(
            "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n",
            "#note(title: \"My Paper\", author: \"Jane Doe\")\n",
            "\n= Hello\n",
        );
        let result = inject_document_metadata(source);
        assert!(result.contains("#set document(title: \"My Paper\", author: \"Jane Doe\")"));
        assert!(result.contains("= Hello"));
    }

    #[test]
    fn inject_document_metadata_date_as_datetime() {
        let source = "#note(title: \"Test\", date: \"2026-04-28\")\n\n= Body\n";
        let result = inject_document_metadata(source);
        assert!(result.contains("date: datetime(year: 2026, month: 4, day: 28)"), "got: {}", result);
    }

    #[test]
    fn inject_document_metadata_multiline_note_with_mixed_types() {
        let source = concat!(
            "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n",
            "#note(\n",
            "  tag: (\"dogtag\", \"animal\"),\n",
            "  date: \"2026-04-28\",\n",
            "  to-do: false,\n",
            "  alias: \"\",\n",
            ")\n",
            "\n= heading 1\n",
        );
        let result = inject_document_metadata(source);
        assert!(result.contains("= heading 1"));
        assert!(result.contains("datetime(year: 2026, month: 4, day: 28)"));
    }

    #[test]
    fn inject_document_metadata_handles_tags_as_keywords() {
        let source = "#note(title: \"Test\", tags: (\"physics\", \"quantum\"))\n\n= Body\n";
        let result = inject_document_metadata(source);
        assert!(result.contains("title: \"Test\""));
        assert!(result.contains("keywords: (\"physics\", \"quantum\")"));
    }

    #[test]
    fn inject_document_metadata_noop_without_note() {
        let source = "= Just a heading\n\nSome text.\n";
        let result = inject_document_metadata(source);
        assert_eq!(result, source);
    }

    #[test]
    fn inject_document_metadata_datetime_literal_passthrough() {
        let source = "#note(title: \"Test\", date: datetime(year: 2026, month: 4, day: 29))\n\n= Body\n";
        let result = inject_document_metadata(source);
        assert!(result.contains("date: datetime(year: 2026, month: 4, day: 29)"), "got: {}", result);
    }

    #[test]
    fn normalize_date_value_from_datetime() {
        assert_eq!(
            normalize_date_value("datetime(year: 2026, month: 4, day: 29)"),
            "2026-04-29"
        );
    }

    #[test]
    fn normalize_date_value_passthrough_iso() {
        assert_eq!(normalize_date_value("2026-04-29"), "2026-04-29");
    }

    #[test]
    fn normalize_metadata_maps_keys() {
        let raw = vec![
            ("title".to_string(), "Test".to_string()),
            ("tag".to_string(), "a, b".to_string()),
            ("to-do".to_string(), "false".to_string()),
            ("alias".to_string(), "alt".to_string()),
        ];
        let norm = normalize_metadata(&raw);
        let keys: Vec<&str> = norm.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"title"));
        assert!(keys.contains(&"keywords"));
        assert!(!keys.contains(&"tag"));
        assert!(!keys.contains(&"to-do"));
        assert!(!keys.contains(&"alias"));
    }

    #[test]
    fn inject_docx_core_properties_upserts() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:dcterms="http://purl.org/dc/terms/" "#,
            r#"xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
            r#"<dc:title>Old Title</dc:title>"#,
            r#"</cp:coreProperties>"#,
        );
        let meta = vec![
            ("title".to_string(), "New Title".to_string()),
            ("author".to_string(), "Jane Doe".to_string()),
            ("keywords".to_string(), "physics, quantum".to_string()),
        ];
        let result = inject_docx_core_properties(xml, &meta);
        assert!(result.contains("<dc:title>New Title</dc:title>"));
        assert!(result.contains("<dc:creator>Jane Doe</dc:creator>"));
        assert!(result.contains("<cp:keywords>physics, quantum</cp:keywords>"));
        assert!(!result.contains("Old Title"));
    }

    #[test]
    fn strip_docx_title_paragraphs_with_space_before_slash() {
        let xml = concat!(
            "<w:body>",
            r#"<w:p><w:pPr><w:pStyle w:val="Title" /></w:pPr>"#,
            "<w:r><w:t>Daisy Dog</w:t></w:r></w:p>",
            r#"<w:p><w:pPr><w:pStyle w:val="Date" /></w:pPr>"#,
            "<w:r><w:t>2026-04-28</w:t></w:r></w:p>",
            r#"<w:p><w:pPr><w:pStyle w:val="Heading1" /></w:pPr>"#,
            "<w:r><w:t>Section</w:t></w:r></w:p>",
            "</w:body>",
        );
        let title_styles = regex::Regex::new(
            r#"<w:pStyle w:val="(Title|Subtitle|Author|Date)"\s*/>"#,
        ).unwrap();
        let result = strip_docx_title_paragraphs(xml, &title_styles);
        assert!(!result.contains("Daisy Dog"), "title should be stripped");
        assert!(!result.contains("2026-04-28"), "date should be stripped");
        assert!(result.contains("Section"), "heading should remain");
    }

    #[test]
    fn inject_docx_core_properties_real_pandoc_output() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:dcterms="http://purl.org/dc/terms/" "#,
            r#"xmlns:dcmitype="http://purl.org/dc/dcmitype/" "#,
            r#"xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
            r#"<dc:title>Daisy Dog</dc:title>"#,
            r#"<dc:creator></dc:creator>"#,
            r#"<cp:keywords></cp:keywords>"#,
            r#"<dcterms:created xsi:type="dcterms:W3CDTF">2026-05-02T19:37:44Z</dcterms:created>"#,
            r#"<dcterms:modified xsi:type="dcterms:W3CDTF">2026-05-02T19:37:44Z</dcterms:modified>"#,
            r#"</cp:coreProperties>"#,
        );
        let meta = vec![
            ("title".to_string(), "Daisy Dog".to_string()),
            ("keywords".to_string(), "dogtag, animal".to_string()),
            ("date".to_string(), "2026-04-28".to_string()),
        ];
        let result = inject_docx_core_properties(xml, &meta);
        assert!(result.contains("<dc:title>Daisy Dog</dc:title>"));
        assert!(result.contains("<cp:keywords>dogtag, animal</cp:keywords>"));
        assert!(result.contains("<dcterms:created xsi:type=\"dcterms:W3CDTF\">2026-04-28T00:00:00Z</dcterms:created>"));
    }

    #[test]
    fn inject_odt_meta_properties_real_pandoc_output() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="utf-8"?>"#,
            r#"<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">"#,
            r#"<office:meta>"#,
            r#"<meta:generator>Pandoc/3.7.0.2</meta:generator>"#,
            r#"<dc:title>Daisy Dog</dc:title>"#,
            r#"<dc:description></dc:description>"#,
            r#"<dc:subject></dc:subject>"#,
            r#"<meta:keyword></meta:keyword>"#,
            r#"<meta:initial-creator></meta:initial-creator>"#,
            r#"<dc:creator></dc:creator>"#,
            r#"<dc:date>2026-05-02T19:39:28Z</dc:date>"#,
            r#"</office:meta>"#,
            r#"</office:document-meta>"#,
        );
        let meta = vec![
            ("title".to_string(), "Daisy Dog".to_string()),
            ("keywords".to_string(), "dogtag, animal".to_string()),
            ("date".to_string(), "2026-04-28".to_string()),
        ];
        let result = inject_odt_meta_properties(xml, &meta);
        assert!(result.contains("<dc:title>Daisy Dog</dc:title>"));
        assert!(result.contains("<meta:keyword>dogtag</meta:keyword>"));
        assert!(result.contains("<meta:keyword>animal</meta:keyword>"));
        assert!(result.contains("<dc:date>2026-04-28T00:00:00</dc:date>"));
        assert!(!result.contains("<meta:keyword></meta:keyword>"));
    }

    #[test]
    fn inject_odt_meta_properties_upserts() {
        let xml = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
            r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
            r#"xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">"#,
            r#"<office:meta>"#,
            r#"<dc:title>Old</dc:title>"#,
            r#"</office:meta>"#,
            r#"</office:document-meta>"#,
        );
        let meta = vec![
            ("title".to_string(), "New Title".to_string()),
            ("author".to_string(), "Jane".to_string()),
            ("keywords".to_string(), "a, b".to_string()),
            ("date".to_string(), "2026-04-29".to_string()),
        ];
        let result = inject_odt_meta_properties(xml, &meta);
        assert!(result.contains("<dc:title>New Title</dc:title>"));
        assert!(result.contains("<meta:initial-creator>Jane</meta:initial-creator>"));
        assert!(result.contains("<meta:keyword>a</meta:keyword>"));
        assert!(result.contains("<meta:keyword>b</meta:keyword>"));
        assert!(result.contains("<dc:date>2026-04-29T00:00:00</dc:date>"));
        assert!(!result.contains(">Old<"));
    }

    #[test]
    fn resolve_template_bare_name() {
        let result = resolve_template_path("ieee");
        assert!(result.starts_with('/'));
        assert!(result.ends_with("/ieee.typ"));
    }

    #[test]
    fn resolve_template_bare_name_with_extension() {
        let result = resolve_template_path("ieee.typ");
        assert!(result.starts_with('/'));
        assert!(result.ends_with("/ieee.typ"));
        assert!(!result.ends_with(".typ.typ"));
    }

    #[test]
    fn resolve_template_absolute_path_passthrough() {
        assert_eq!(resolve_template_path("/my/template.typ"), "/my/template.typ");
    }

    #[test]
    fn resolve_template_package_ref_passthrough() {
        assert_eq!(
            resolve_template_path("@preview/charged-ieee:0.1.0"),
            "@preview/charged-ieee:0.1.0",
        );
    }

    #[test]
    fn inject_bibliography_when_citations_present() {
        let source = "#note()\nSome text @smith2020 and more.".to_string();
        let result = maybe_inject_bibliography(source, Some("refs.bib"), None);
        assert!(result.contains("#bibliography(\"/refs.bib\")"));
    }

    #[test]
    fn inject_bibliography_with_style() {
        let source = "#note()\n@jones2021".to_string();
        let result = maybe_inject_bibliography(source, Some("refs.bib"), Some("ieee"));
        assert!(result.contains("#bibliography(\"/refs.bib\", style: \"ieee\")"));
    }

    #[test]
    fn no_bibliography_without_citations() {
        let source = "#note()\nNo citations here.".to_string();
        let result = maybe_inject_bibliography(source.clone(), Some("refs.bib"), None);
        assert_eq!(result, source);
    }

    #[test]
    fn no_bibliography_without_bib_file() {
        let source = "#note()\n@smith2020".to_string();
        let result = maybe_inject_bibliography(source.clone(), None, None);
        assert_eq!(result, source);
    }

    #[test]
    fn no_bibliography_for_import_at_signs() {
        let source = "#import \"@preview/pkg:0.1.0\": *\nNo citations.".to_string();
        let result = maybe_inject_bibliography(source.clone(), Some("refs.bib"), None);
        assert_eq!(result, source);
    }

    #[test]
    fn strip_callout_to_blockquote() {
        let source = r#"#callout("info")[This is important.]"#;
        let result = strip_inkycap_functions(source);
        assert!(result.contains("#quote(block: true)[This is important.]"));
        assert!(!result.contains("#callout"));
    }

    #[test]
    fn strip_callout_with_title() {
        let source = r#"#callout("warning", title: "Watch out")[Be careful.]"#;
        let result = strip_inkycap_functions(source);
        assert!(result.contains("#quote(block: true)[Be careful.]"));
        assert!(!result.contains("#callout"));
    }

    #[test]
    fn strip_callout_nested_brackets() {
        let source = r#"#callout("info")[Has [nested] brackets.]"#;
        let result = strip_inkycap_functions(source);
        assert!(result.contains("#quote(block: true)[Has [nested] brackets.]"));
    }

    #[test]
    fn strip_verse_string_arg() {
        let source = r#"#verse("roses are red")"#;
        let result = strip_inkycap_functions(source);
        assert!(result.contains("#quote(block: true)[roses are red]"));
        assert!(!result.contains("#verse"));
    }

    #[test]
    fn strip_set_vault() {
        let source = "#set-vault(show-inline-tags: false)\n= Hello\n";
        let result = strip_inkycap_functions(source);
        assert!(!result.contains("#set-vault"));
        assert!(result.contains("= Hello"));
    }
}
