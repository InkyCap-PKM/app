use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::compiler::PdfStandardPreset;
use crate::typst_pipeline::package_fetch::compile_with_auto_packages;
use crate::typst_pipeline::style_injection;

use super::helpers::{
    apply_review_mode, args_has_named_arg, find_matching_paren, inject_document_metadata,
    parse_date_to_typst_datetime, parse_first_string_arg, parse_named_string_arg,
    prepare_bibliography, resolve_effective_bib, resolve_template_path_with_root,
};

// ── Single-note PDF export ──────────────────────────────────────

/// Export a single note to PDF. Returns the raw PDF bytes.
#[tauri::command]
pub async fn export_note_pdf(
    path: String,
    include_bibliography: Option<bool>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<u8>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = crate::notebox_package::ensure_import(&content);

    let source = super::super::typst::inject_style_cascade(&content, &path_buf, &state).await;
    let source = super::super::typst::maybe_inject_set_notebox(&source, &state).await;
    let source = prepare_bibliography(
        source,
        None,
        None,
        include_bibliography.unwrap_or(true),
        &state,
        &session,
    )
    .await;

    let mut compiler = session.typst_compiler.lock().await;
    let compiler = compiler.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    let pdf_bytes = compile_with_auto_packages(compiler, |c| {
        c.compile_pdf(&path_buf, source.clone(), PdfStandardPreset::default())
    })
    .await
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
    include_bibliography: Option<bool>,
    review_mode: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = apply_review_mode(&content, review_mode.as_deref());
    let content = crate::notebox_package::ensure_import(&content);

    let source = if metadata_mode == "properties" {
        inject_document_metadata(&content)
    } else {
        content
    };

    let source = super::super::typst::inject_style_cascade(&source, &path_buf, &state).await;
    let source = super::super::typst::maybe_inject_set_notebox(&source, &state).await;
    let source = prepare_bibliography(
        source,
        None,
        None,
        include_bibliography.unwrap_or(true),
        &state,
        &session,
    )
    .await;

    let mut compiler = session.typst_compiler.lock().await;
    let compiler = compiler.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    let standard = pdf_standard.unwrap_or_default();
    let source = ensure_document_date_for_standard(source, standard);
    check_pdf_standard_requirements(&source, standard)?;
    let pdf_bytes = compile_with_auto_packages(compiler, |c| {
        c.compile_pdf(&path_buf, source.clone(), standard)
    })
    .await
    .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?;

    tokio::fs::write(&output_path, &pdf_bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))
}

// ── Collection-level PDF export ─────────────────────────────────

/// Export a single note from a collection as PDF, applying the collection's
/// `typst_template` and `bibliography_style` if set.
#[tauri::command]
pub async fn export_collection_note_pdf(
    note_path: String,
    collection_path: String,
    output_path: String,
    metadata_mode: Option<String>,
    pdf_standard: Option<PdfStandardPreset>,
    include_bibliography: Option<bool>,
    review_mode: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let note_path_buf = PathBuf::from(&note_path);
    let collection_path_buf = PathBuf::from(&collection_path);

    let content = storage.read_file(&note_path_buf).await?;
    let content = apply_review_mode(&content, review_mode.as_deref());
    let content = crate::notebox_package::ensure_import(&content);
    let collection_content = storage.read_file(&collection_path_buf).await?;
    let base = crate::collection_parser::model::parse_collection_file(&collection_content)?;

    let source = if metadata_mode.as_deref() == Some("properties") {
        inject_document_metadata(&content)
    } else {
        content
    };

    let app_settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_show_call_resolved(&app_settings);
    drop(app_settings);
    let collection_rules = base.style.as_ref().map(|s| s.to_typst_show_call());
    let source = style_injection::inject_style_rules(
        &source,
        if defaults_rules.is_empty() {
            None
        } else {
            Some(&defaults_rules)
        },
        collection_rules.as_deref().filter(|r| !r.is_empty()),
        base.custom_typst
            .as_deref()
            .filter(|c| !c.trim().is_empty()),
    );
    let source = super::super::typst::maybe_inject_set_notebox(&source, &state).await;

    let notebox_root = session.notebox_root.read().await;
    let notebox_root_ref = notebox_root.as_deref();

    let source = prepare_bibliography(
        source,
        base.bibliography_file.as_deref(),
        base.bibliography_style.as_deref(),
        include_bibliography.unwrap_or(true),
        &state,
        &session,
    )
    .await;

    let mut compiler = session.typst_compiler.lock().await;
    let compiler = compiler.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    let resolved_template = base
        .typst_template
        .as_deref()
        .map(|t| resolve_template_path_with_root(t, notebox_root_ref));

    let standard = pdf_standard.unwrap_or_default();
    let source = ensure_document_date_for_standard(source, standard);
    check_pdf_standard_requirements(&source, standard)?;
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
    include_bibliography: Option<bool>,
    review_mode: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let data = crate::commands::collections::get_collection_data_internal(
        &collection_path,
        &view_name,
        &session,
    )
    .await?;

    let storage = session.get_storage().await?;
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

    let notebox_root = session.notebox_root.read().await;
    let notebox_root_ref = notebox_root.as_deref();
    let resolved_template = base
        .typst_template
        .as_deref()
        .map(|t| resolve_template_path_with_root(t, notebox_root_ref));
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

        let content = apply_review_mode(&content, review_mode.as_deref());
        let content = crate::notebox_package::ensure_import(&content);
        let source = if metadata_mode.as_deref() == Some("properties") {
            inject_document_metadata(&content)
        } else {
            content
        };
        let source = style_injection::inject_style_rules(
            &source,
            if defaults_rules.is_empty() {
                None
            } else {
                Some(&defaults_rules)
            },
            collection_rules.as_deref().filter(|r| !r.is_empty()),
            base.custom_typst
                .as_deref()
                .filter(|c| !c.trim().is_empty()),
        );
        let source = super::super::typst::maybe_inject_set_notebox(&source, &state).await;
        let source = prepare_bibliography(
            source,
            base.bibliography_file.as_deref(),
            base.bibliography_style.as_deref(),
            include_bibliography.unwrap_or(true),
            &state,
            &session,
        )
        .await;

        let mut compiler = session.typst_compiler.lock().await;
        let compiler = compiler.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
        compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

        let standard = pdf_standard.unwrap_or_default();
        let source = ensure_document_date_for_standard(source, standard);
        check_pdf_standard_requirements(&source, standard)?;
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

        let pdf_name = row.file_name.strip_suffix(".typ").unwrap_or(&row.file_name);
        let pdf_path = output_dir.join(format!("{}.pdf", pdf_name));
        if let Err(e) = tokio::fs::write(&pdf_path, &pdf_bytes).await {
            errors.push(format!("{}: {}", pdf_name, e));
            continue;
        }
        exported.push(crate::storage::to_frontend_string(&pdf_path));
    }

    if exported.is_empty() && !errors.is_empty() {
        return Err(InkyCapError::ExportFailed(format!(
            "All files failed to export:\n{}",
            errors.join("\n")
        )));
    }

    if !errors.is_empty() {
        log::error!(
            "Batch export: {} of {} files failed:\n{}",
            errors.len(),
            data.rows.len(),
            errors.join("\n")
        );
    }

    Ok(exported)
}

// ── Book (merged collection) export ─────────────────────────────

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
    pub inject_chapter_heading: Option<crate::collection_parser::model::InjectChapterHeading>,
    pub wikilink_mode: Option<crate::collection_parser::model::BookWikilinkMode>,
    pub include_title_page: Option<bool>,
    pub include_outline: Option<bool>,
    pub page_numbering: Option<crate::collection_parser::model::BookPageNumbering>,
    pub pdf_standard: Option<PdfStandardPreset>,
    pub toc_placement: Option<crate::collection_parser::model::TocPlacement>,
    pub bibliography_mode: Option<crate::collection_parser::model::BibliographyMode>,
    /// Review-markup policy ("accept"/"reject"/"keep") applied to every note
    /// before it is inlined into the book. Absent → keep marks.
    pub review_mode: Option<String>,
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
    // Note stems to omit from the book (notes the user chose to skip after a
    // previous attempt reported them as failing to compile). Empty/None on the
    // first attempt.
    exclude_notes: Option<Vec<String>>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<BookExportResult, InkyCapError> {
    let session = state.session(window.label()).await;
    use crate::typst_pipeline::book_wrapper::{self, BookExportOptions, BookNote};
    let exclude: std::collections::HashSet<String> =
        exclude_notes.unwrap_or_default().into_iter().collect();

    let data = crate::commands::collections::get_collection_data_internal(
        &collection_path,
        &view_name,
        &session,
    )
    .await?;

    let storage = session.get_storage().await?;
    let collection_path_buf = PathBuf::from(&collection_path);
    let collection_content = storage.read_file(&collection_path_buf).await?;
    let base = crate::collection_parser::model::parse_collection_file(&collection_content)?;

    if data.rows.is_empty() {
        return Err(InkyCapError::ExportFailed(
            "Collection contains no notes to export.".to_string(),
        ));
    }

    let book_pdf_standard = overrides
        .as_ref()
        .and_then(|o| o.pdf_standard)
        .unwrap_or_default();
    let review_mode = overrides.as_ref().and_then(|o| o.review_mode.clone());
    let mut options = BookExportOptions::from_config(base.book.as_ref());
    if let Some(ov) = overrides {
        if ov.title.is_some() {
            options.title = ov.title;
        }
        if ov.subtitle.is_some() {
            options.subtitle = ov.subtitle;
        }
        if ov.author.is_some() {
            options.author = ov.author;
        }
        if ov.date.is_some() {
            options.date = ov.date;
        }
        if ov.abstract_text.is_some() {
            options.abstract_text = ov.abstract_text;
        }
        if let Some(v) = ov.toc_depth {
            options.toc_depth = v;
        }
        if let Some(v) = ov.inject_chapter_heading {
            options.inject_chapter_heading = v;
        }
        if let Some(v) = ov.wikilink_mode {
            options.wikilink_mode = v;
        }
        if let Some(v) = ov.include_title_page {
            options.include_title_page = v;
        }
        if let Some(v) = ov.include_outline {
            options.include_outline = v;
        }
        if let Some(v) = ov.page_numbering {
            options.page_numbering = v;
        }
        if let Some(v) = ov.toc_placement {
            options.toc_placement = v;
        }
        if let Some(v) = ov.bibliography_mode {
            options.bibliography_mode = v;
        }
    }

    // Acquire notebox root up front: per-note path rebasing needs it to
    // compute each note's notebox-relative directory. The same guard is
    // read again further down for template / bibliography resolution.
    let notebox_root_for_rebase = session.notebox_root.read().await.clone();

    let mut notes: Vec<BookNote> = Vec::with_capacity(data.rows.len());
    for row in &data.rows {
        let note_path_buf = PathBuf::from(&row.file_path);
        let content = storage.read_file(&note_path_buf).await?;
        let content = apply_review_mode(&content, review_mode.as_deref());
        let stem = note_path_buf
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| row.file_name.clone());
        let title = extract_note_title(&content);

        // Rebase relative path arguments in the note's source so calls
        // like `image("daisy.png")` resolve against the note's own
        // folder once inlined into the merged document's synthetic main
        // (which lives at the notebox root, not next to the note). Absolute
        // paths and non-literal arguments are left untouched. See
        // typst_pipeline::path_rebase.
        let rebased = if let Some(ref vroot) = notebox_root_for_rebase {
            let note_dir = note_path_buf
                .parent()
                .and_then(|p| p.strip_prefix(vroot).ok())
                .map(|p| p.to_path_buf())
                .unwrap_or_default();
            crate::typst_pipeline::path_rebase::rebase_relative_paths(&content, &note_dir)
        } else {
            content.clone()
        };

        notes.push(BookNote {
            stem,
            abs_path: note_path_buf,
            content: rebased,
            title,
        });
    }

    // Drop notes the user chose to exclude after a previous attempt flagged
    // them as failing to compile (matched by chapter stem — the book's chapter
    // identity). If that empties the book, there's nothing to export.
    if !exclude.is_empty() {
        notes.retain(|n| !exclude.contains(&n.stem));
        if notes.is_empty() {
            return Err(InkyCapError::ExportFailed(
                "Every note was excluded — nothing left to export.".to_string(),
            ));
        }
    }

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

    // In-place bibliography mode keeps each note's own `#bibliography(...)`.
    // Typst 0.14 allows only one bibliography per document, so more than one
    // declaring note can't produce a valid merged book. Catch it here with a
    // clear message instead of surfacing Typst's cryptic multi-bibliography
    // error after a full compile.
    if matches!(
        options.bibliography_mode,
        crate::collection_parser::model::BibliographyMode::InPlace
    ) {
        let declaring = book_wrapper::notes_declaring_bibliography(&notes);
        if declaring.len() > 1 {
            return Err(InkyCapError::ExportFailed(format!(
                "Multiple bibliographies in a merged book are not supported: {} notes declare their own #bibliography(...) ({}). Typst allows only one bibliography per document. Switch to a unified bibliography to consolidate them, or keep a #bibliography(...) in only one note.",
                declaring.len(),
                declaring.join(", ")
            )));
        }
    }

    let app_settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_show_call_resolved(&app_settings);
    drop(app_settings);
    let collection_rules = base.style.as_ref().map(|s| s.to_typst_show_call());

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

    let notebox_root_guard = session.notebox_root.read().await;
    let notebox_root_ref = notebox_root_guard.as_deref();
    let resolved_template = base
        .typst_template
        .as_deref()
        .map(|t| resolve_template_path_with_root(t, notebox_root_ref));
    let template_import_line = resolved_template
        .as_ref()
        .map(|t| format!("#import \"{}\": *\n", t));
    let effective_bib = resolve_effective_bib(
        base.bibliography_file.as_deref(),
        notebox_root_ref,
        &state,
        &session,
    )
    .await;
    let bib_path_for_wrapper: Option<String> = effective_bib.as_deref().map(|b| {
        if b.starts_with('/') {
            b.to_string()
        } else {
            format!("/{b}")
        }
    });

    let synthetic_main = {
        let stem = collection_path_buf
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "book".to_string());
        // Anchor at the notebox root so relative paths in inlined notes
        // (e.g. `image("daisy.png")`) resolve against the notebox — not the
        // reserved `.inkycap/collections/` location of the .collection file.
        let parent = notebox_root_ref
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| {
                collection_path_buf
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_default()
            });
        parent.join(format!("{}.book.typ", stem))
    };
    drop(notebox_root_guard);

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

    let normalize_headings = book_pdf_standard == PdfStandardPreset::PdfUa1;
    let source = book_wrapper::build_book_source(
        &notes,
        &options,
        if style_rules.is_empty() {
            None
        } else {
            Some(&style_rules)
        },
        base.custom_typst
            .as_deref()
            .filter(|c| !c.trim().is_empty()),
        template_import_line.as_deref(),
        bib_path_for_wrapper.as_deref(),
        base.bibliography_style.as_deref(),
        normalize_headings,
        body_numbering_pattern.as_deref(),
        heading_numbering_pattern.as_deref(),
    );

    let mut compiler = session.typst_compiler.lock().await;
    let compiler = compiler.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    if let Some(ref style) = base.bibliography_style {
        compiler.set_bibliography_style(Some(style.clone()));
    }
    let source = super::super::typst::maybe_inject_set_notebox(&source, &state).await;
    let source = ensure_document_date_for_standard(source, book_pdf_standard);
    check_pdf_standard_requirements(&source, book_pdf_standard)?;
    // Keep a copy to map any compile error's offset back to the note it came
    // from (the merged source is consumed by the compiler).
    let source_for_diag = source.clone();
    let compile_result =
        compiler.compile_pdf_diagnostics(&synthetic_main, source, book_pdf_standard);
    compiler.set_bibliography_style(None);
    let pdf_bytes = match compile_result {
        Ok(bytes) => bytes,
        Err(diags) => {
            let message = book_wrapper::describe_book_diagnostics(&source_for_diag, &diags);
            let failing = book_wrapper::book_diagnostic_note_stems(&source_for_diag, &diags);
            // Errors attributable to specific notes → let the caller offer to
            // exclude them and retry. Otherwise (front-matter, package, or
            // span-less errors that excluding a note can't fix) it's a hard
            // failure.
            if failing.is_empty() {
                return Err(InkyCapError::ExportFailed(message));
            }
            return Ok(BookExportResult {
                output_path: None,
                failing_notes: failing,
                message: Some(message),
            });
        }
    };

    tokio::fs::write(&output_path, &pdf_bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))?;

    Ok(BookExportResult {
        output_path: Some(output_path),
        failing_notes: Vec::new(),
        message: None,
    })
}

/// Outcome of a book export. Either the PDF was written (`output_path` set), or
/// the compile failed in one or more notes the caller can choose to exclude and
/// retry (`failing_notes` — note stems — plus a human-readable `message`).
/// A failure that no note exclusion could fix comes back as `Err` instead.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookExportResult {
    pub output_path: Option<String>,
    pub failing_notes: Vec<String>,
    pub message: Option<String>,
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

// ── PDF standards / compliance ──────────────────────────────────

/// Pre-flight a source for issues that would block export under the
/// chosen PDF standard, and return them all in a single actionable error.
///
/// Reporting issues up-front (rather than letting typst-pdf surface a
/// single cryptic message for the first failure) is especially valuable
/// for accessibility-driven exports like PDF/UA-1: the author needs the
/// full list of fixes — alt text on every image, gap-free headings,
/// document metadata — to make the document genuinely conformant. A
/// silent fallback (e.g. injecting `alt: "<filename>"`) would let the
/// export succeed but defeat the point of choosing the standard.
///
/// Returns `Ok(())` when the standard is `Standard` (no requirements) or
/// when no issues are found.
pub fn check_pdf_standard_requirements(
    source: &str,
    standard: PdfStandardPreset,
) -> Result<(), InkyCapError> {
    if standard == PdfStandardPreset::Standard {
        return Ok(());
    }

    let mut issues: Vec<String> = Vec::new();

    if standard == PdfStandardPreset::PdfUa1 {
        let alt_offenders = images_missing_alt(source);
        if !alt_offenders.is_empty() {
            let mut block =
                String::from("Images missing alt text (PDF/UA-1 requires alt: on every image):\n");
            for (line, path) in &alt_offenders {
                block.push_str(&format!("  line {line}: #image(\"{path}\")\n"));
            }
            block.push_str("  Fix: add `alt: \"description\"` to each call.");
            issues.push(block);
        }

        let gaps = heading_level_gaps(source);
        if !gaps.is_empty() {
            let mut block = String::from(
                "Heading levels skip a step (PDF/UA-1 requires consecutive nesting):\n",
            );
            for (line, prev_lvl, this_lvl, text) in &gaps {
                block.push_str(&format!(
                    "  line {line}: jumps from level {prev_lvl} to level {this_lvl} ({text})\n"
                ));
            }
            block.push_str(
                "  Fix: insert the intermediate heading(s), or reduce this heading's depth.",
            );
            issues.push(block);
        }
    }

    if issues.is_empty() {
        return Ok(());
    }

    let label = match standard {
        PdfStandardPreset::PdfUa1 => "PDF/UA-1",
        PdfStandardPreset::PdfA4 => "PDF/A-4",
        PdfStandardPreset::Standard => "PDF",
    };
    Err(InkyCapError::ExportFailed(format!(
        "{label} export blocked by the following issue(s):\n\n{}",
        issues.join("\n\n")
    )))
}

/// Find heading-level jumps that skip one or more levels (e.g. `=` →
/// `===`, which violates PDF/UA-1's consecutive-nesting rule).
fn heading_level_gaps(source: &str) -> Vec<(usize, u8, u8, String)> {
    let mut last_level: Option<u8> = None;
    let mut offenders = Vec::new();
    for (i, raw_line) in source.lines().enumerate() {
        let trimmed = raw_line.trim_start();
        if !trimmed.starts_with('=') {
            continue;
        }
        let count = trimmed.bytes().take_while(|&b| b == b'=').count();
        if count == 0 || count > u8::MAX as usize {
            continue;
        }
        let after = &trimmed[count..];
        if !(after.is_empty() || after.starts_with(' ') || after.starts_with('\t')) {
            continue;
        }
        let level = count as u8;
        if let Some(prev) = last_level {
            if level > prev + 1 {
                let text = after.trim().chars().take(60).collect::<String>();
                offenders.push((i + 1, prev, level, text));
            }
        }
        last_level = Some(level);
    }
    offenders
}

/// Find every `#image(...)` call in `source` that lacks an `alt:`
/// argument.
fn images_missing_alt(source: &str) -> Vec<(usize, String)> {
    let mut offenders: Vec<(usize, String)> = Vec::new();
    let pattern = "#image(";
    let bytes = source.as_bytes();
    let mut search_from: usize = 0;
    while let Some(rel) = source[search_from..].find(pattern) {
        let start = search_from + rel;
        let after_hash = &source[start + 1..];
        let args_open = "image".len();
        let Some(args_close) = find_matching_paren(after_hash, args_open) else {
            search_from = start + pattern.len();
            continue;
        };
        let args_str = &after_hash[args_open + 1..args_close];
        let has_alt = parse_named_string_arg(args_str, "alt").is_some()
            || args_has_named_arg(args_str, "alt");
        if !has_alt {
            let line = bytes[..start].iter().filter(|&&b| b == b'\n').count() + 1;
            let path = parse_first_string_arg(args_str).unwrap_or_else(|| "<unknown>".to_string());
            offenders.push((line, path));
        }
        search_from = start + 1 + args_close + 1;
    }
    offenders
}

/// Ensure the source has a `#set document(date: ...)` rule when exporting to a
/// PDF standard that requires one (PDF/A-4, PDF/UA-1).
pub fn ensure_document_date_for_standard(source: String, standard: PdfStandardPreset) -> String {
    if standard == PdfStandardPreset::Standard {
        return source;
    }

    if existing_document_set_has_date(&source) {
        return source;
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let dt = parse_date_to_typst_datetime(&today).unwrap_or_else(|| "datetime.today()".to_string());
    let set_rule = format!("#set document(date: {})\n", dt);

    let mut byte_pos: usize = 0;
    for line in source.lines() {
        let line_with_nl_len = line.len() + 1;
        if crate::notebox_package::is_notebox_import_line(line) {
            let insert_at = (byte_pos + line_with_nl_len).min(source.len());
            let mut result = String::with_capacity(source.len() + set_rule.len());
            result.push_str(&source[..insert_at]);
            result.push_str(&set_rule);
            result.push_str(&source[insert_at..]);
            return result;
        }
        byte_pos += line_with_nl_len;
    }

    format!("{}{}", set_rule, source)
}

fn existing_document_set_has_date(source: &str) -> bool {
    let bytes = source.as_bytes();
    let needle = "#set document(";
    let mut search_from = 0;
    while let Some(rel) = source[search_from..].find(needle) {
        let abs = search_from + rel;
        let mut i = abs + needle.len();
        let mut depth: i32 = 1;
        let mut in_string = false;
        let mut escape = false;
        while i < bytes.len() && depth > 0 {
            let c = bytes[i];
            if escape {
                escape = false;
                i += 1;
                continue;
            }
            if in_string {
                match c {
                    b'\\' => escape = true,
                    b'"' => in_string = false,
                    _ => {}
                }
                i += 1;
                continue;
            }
            match c {
                b'"' => in_string = true,
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        let call_end = i;
        let call_args = &source[abs + needle.len()..call_end.saturating_sub(1)];
        if contains_top_level_keyword(call_args, "date") {
            return true;
        }
        search_from = call_end;
    }
    false
}

fn contains_top_level_keyword(args: &str, keyword: &str) -> bool {
    let bytes = args.as_bytes();
    let kw_with_colon = format!("{}:", keyword);
    let kw_bytes = kw_with_colon.as_bytes();
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if escape {
            escape = false;
            i += 1;
            continue;
        }
        if in_string {
            match c {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                in_string = true;
                i += 1;
                continue;
            }
            b'(' | b'[' | b'{' => {
                depth += 1;
                i += 1;
                continue;
            }
            b')' | b']' | b'}' => {
                depth -= 1;
                i += 1;
                continue;
            }
            _ => {}
        }
        if depth == 0 && bytes[i..].starts_with(kw_bytes) {
            let prev_ok = if i == 0 {
                true
            } else {
                let p = bytes[i - 1];
                p == b',' || p == b' ' || p == b'\t' || p == b'\n' || p == b'\r' || p == b'('
            };
            if prev_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}
