use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::typst::CompilePurpose;
use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::compiler::PdfStandardPreset;
use crate::typst_pipeline::package_fetch::compile_with_auto_packages;
use crate::typst_pipeline::source_structure;
use crate::typst_pipeline::style_injection;

use super::companion::{CompanionFiles, CompanionReport, LinkedFilesOptions};
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
    let source =
        super::super::typst::maybe_inject_set_notebox(&source, &state, CompilePurpose::Export)
            .await;
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

/// Export one note to PDF at the given path. `metadata_mode`: "exclude" (default) or
/// "properties" (title, author, date and keywords as PDF properties through `#set
/// document(...)`).
#[tauri::command]
pub async fn export_note_pdf_to_file(
    path: String,
    output_path: String,
    metadata_mode: String,
    pdf_standard: Option<PdfStandardPreset>,
    include_bibliography: Option<bool>,
    review_mode: Option<String>,
    linked_files: Option<LinkedFilesOptions>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<CompanionReport>, InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_path)
        .await?;
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path_buf = PathBuf::from(&path);
    let content = storage.read_file(&path_buf).await?;
    let content = apply_review_mode(&content, review_mode.as_deref());
    let mut companion = CompanionFiles::beside_file(linked_files, Path::new(&output_path));
    let content = companion.prepare_note(&storage, &path_buf, &content);
    let content = crate::notebox_package::ensure_import(&content);

    let source = if metadata_mode == "properties" {
        inject_document_metadata(&content)
    } else {
        content
    };

    let source = super::super::typst::inject_style_cascade(&source, &path_buf, &state).await;
    let source =
        super::super::typst::maybe_inject_set_notebox(&source, &state, CompilePurpose::Export)
            .await;
    let source = prepare_bibliography(
        source,
        None,
        None,
        include_bibliography.unwrap_or(true),
        &state,
        &session,
    )
    .await;

    let standard = pdf_standard.unwrap_or_default();
    let source = ensure_document_date_for_standard(source, standard);
    check_pdf_standard_requirements(&source, standard)?;
    let pdf_bytes = {
        let mut guard = session.typst_compiler.lock().await;
        let compiler = guard.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
        compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);
        compile_with_auto_packages(compiler, |c| {
            c.compile_pdf(&path_buf, source.clone(), standard)
        })
        .await
        .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?
    };

    tokio::fs::write(&output_path, &pdf_bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))?;
    companion.copy().await
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
    linked_files: Option<LinkedFilesOptions>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<CompanionReport>, InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_path)
        .await?;
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let note_path_buf = PathBuf::from(&note_path);
    let collection_path_buf = PathBuf::from(&collection_path);

    let content = storage.read_file(&note_path_buf).await?;
    let content = apply_review_mode(&content, review_mode.as_deref());
    let mut companion = CompanionFiles::beside_file(linked_files, Path::new(&output_path));
    let content = companion.prepare_note(&storage, &note_path_buf, &content);
    let content = crate::notebox_package::ensure_import(&content);
    let collection_content = storage.read_file(&collection_path_buf).await?;
    let mut base = crate::collection_parser::model::parse_collection_file(&collection_content)?;
    // A template rule the collection's template can't supply (left from an
    // earlier template, or with none set) would stop the export.
    base.custom_typst = crate::commands::typst_packages::usable_custom_typst(
        &session,
        base.custom_typst.as_deref(),
        base.typst_template.as_deref(),
    )
    .await;

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
    let source =
        super::super::typst::maybe_inject_set_notebox(&source, &state, CompilePurpose::Export)
            .await;

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

    let resolved_template = base
        .typst_template
        .as_deref()
        .map(|t| resolve_template_path_with_root(t, notebox_root_ref));
    drop(notebox_root);

    let standard = pdf_standard.unwrap_or_default();
    let source = ensure_document_date_for_standard(source, standard);
    check_pdf_standard_requirements(&source, standard)?;
    let mut guard = session.typst_compiler.lock().await;
    let compiler = guard.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);
    let pdf_bytes: Vec<u8> = if let Some(ref template) = resolved_template {
        compiler
            .compile_pdf_with_template(
                &note_path_buf,
                source,
                template,
                base.bibliography_style.as_deref(),
                standard,
                false,
            )
            .map_err(|e| InkyCapError::ExportFailed(e.to_string()))?
            .bytes
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
    drop(guard);

    tokio::fs::write(&output_path, &pdf_bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))?;
    companion.copy().await
}

/// Export every note of a collection as its own PDF in the output folder. A
/// note that can't be read, compiled or written is listed in `skipped_notes`.
/// `only_files` limits the run to those notes (to retry skipped ones); with
/// `bypass_errors`, a failing note is exported with its errored markup as plain
/// text.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_collection_batch_pdf(
    collection_path: String,
    view_name: String,
    output_dir: String,
    metadata_mode: Option<String>,
    pdf_standard: Option<PdfStandardPreset>,
    include_bibliography: Option<bool>,
    review_mode: Option<String>,
    only_files: Option<Vec<String>>,
    bypass_errors: Option<bool>,
    linked_files: Option<LinkedFilesOptions>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<super::BatchExportResult, InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_dir)
        .await?;
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
    let mut base = crate::collection_parser::model::parse_collection_file(&collection_content)?;
    // A template rule the collection's template can't supply (left from an
    // earlier template, or with none set) would stop the export.
    base.custom_typst = crate::commands::typst_packages::usable_custom_typst(
        &session,
        base.custom_typst.as_deref(),
        base.typst_template.as_deref(),
    )
    .await;

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
    let bypass = bypass_errors.unwrap_or(false);
    let mut exported = Vec::new();
    let mut skipped_notes = Vec::new();
    let mut bypassed_count = 0;
    let mut companion =
        CompanionFiles::for_collection(linked_files, &output_dir, &collection_path_buf);

    for row in &data.rows {
        if let Some(only) = &only_files {
            if !only.contains(&row.file_path) {
                continue;
            }
        }
        let note_path_buf = PathBuf::from(&row.file_path);
        let content = match storage.read_file(&note_path_buf).await {
            Ok(c) => c,
            Err(e) => {
                skipped_notes.push(super::SkippedNote::for_row(row, e));
                continue;
            }
        };

        let content = apply_review_mode(&content, review_mode.as_deref());
        let content = companion.prepare_note(&storage, &note_path_buf, &content);
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
        let source =
            super::super::typst::maybe_inject_set_notebox(&source, &state, CompilePurpose::Export)
                .await;
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
        // A note that doesn't meet the chosen PDF standard is skipped like a
        // compile failure, so it can't abort the rest of the batch.
        if let Err(e) = check_pdf_standard_requirements(&source, standard) {
            skipped_notes.push(super::SkippedNote::for_row(row, e));
            continue;
        }
        let compile_result = if let Some(ref template) = resolved_template {
            compiler.compile_pdf_with_template(
                &note_path_buf,
                source,
                template,
                base.bibliography_style.as_deref(),
                standard,
                bypass,
            )
        } else {
            if let Some(ref style) = base.bibliography_style {
                compiler.set_bibliography_style(Some(style.clone()));
            }
            let result = compiler.compile_pdf_with(&note_path_buf, source, standard, bypass);
            compiler.set_bibliography_style(None);
            result
        };

        let output = match compile_result {
            Ok(output) => output,
            Err(e) => {
                skipped_notes.push(super::SkippedNote::for_row(row, e));
                continue;
            }
        };

        let pdf_name = row.file_name.strip_suffix(".typ").unwrap_or(&row.file_name);
        let pdf_path = output_dir.join(format!("{}.pdf", pdf_name));
        if let Err(e) = tokio::fs::write(&pdf_path, &output.bytes).await {
            skipped_notes.push(super::SkippedNote::for_row(row, e));
            continue;
        }
        if output.bypassed {
            bypassed_count += 1;
        }
        exported.push(crate::storage::to_frontend_string(&pdf_path));
    }

    drop(notebox_root);
    let companion = companion.copy().await?;

    // Even when every note failed, the list comes back as a normal result so
    // the user can open each note or choose to bypass the errors.
    Ok(super::BatchExportResult {
        files: exported,
        skipped_notes,
        bypassed_count,
        companion,
    })
}

// ── Book (merged collection) export ─────────────────────────────

/// Overrides from the "Export as book" dialog. `None` falls back to the
/// collection's `book:` block, then the default. The optional fields of
/// [`crate::collection_parser::model::BookExportConfig`], plus whether to save
/// the values back to the collection.
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
    /// A note name. When set, each chapter holds only the passages linking to
    /// it. Notes without such passages are left out and listed in
    /// [`BookExportResult::without_passages`].
    pub passages_linking_to: Option<String>,
    /// Overrides the collection's saved `export.linked_files`.
    pub linked_files: Option<LinkedFilesOptions>,
}

/// Detected user-label collision returned to the frontend so the UI can
/// present a clear error before any compile is attempted.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BookLabelCollision {
    pub label: String,
    pub notes: Vec<String>,
}

/// Export a collection's notes as one PDF: title page, optional abstract,
/// outline, chapters and one bibliography. The notes are inlined into a
/// generated document; only the PDF is written.
#[tauri::command]
pub async fn export_collection_book_pdf(
    collection_path: String,
    view_name: String,
    output_path: String,
    overrides: Option<BookExportOverrides>,
    // Chapter stems to leave out (notes the user chose to skip after a previous
    // attempt failed on them). Empty on the first attempt.
    exclude_notes: Option<Vec<String>>,
    // Keep errored markup as plain text instead of failing (the user chose to
    // bypass errors after a previous attempt reported them).
    bypass_errors: Option<bool>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<BookExportResult, InkyCapError> {
    crate::commands::export::destination::require_export_destination(&state, &window, &output_path)
        .await?;
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
    let mut base = crate::collection_parser::model::parse_collection_file(&collection_content)?;
    // A template rule the collection's template can't supply (left from an
    // earlier template, or with none set) would stop the export.
    base.custom_typst = crate::commands::typst_packages::usable_custom_typst(
        &session,
        base.custom_typst.as_deref(),
        base.typst_template.as_deref(),
    )
    .await;

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
    let passages_target = overrides
        .as_ref()
        .and_then(|o| o.passages_linking_to.as_deref())
        .and_then(crate::link_index::link_name_key);
    let linked_files = overrides
        .as_ref()
        .and_then(|o| o.linked_files)
        .or_else(|| base.export.as_ref().and_then(|e| e.linked_files));
    let mut companion = CompanionFiles::beside_file(linked_files, Path::new(&output_path));
    let mut without_passages: Vec<String> = Vec::new();
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

    // The notebox root, needed to rebase each note's paths.
    let notebox_root_for_rebase = session.notebox_root.read().await.clone();

    let mut notes: Vec<BookNote> = Vec::with_capacity(data.rows.len());
    for row in &data.rows {
        let note_path_buf = PathBuf::from(&row.file_path);
        let content = storage.read_file(&note_path_buf).await?;
        let content = apply_review_mode(&content, review_mode.as_deref());
        let content = companion.prepare_note(&storage, &note_path_buf, &content);
        let stem = note_path_buf
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| row.file_name.clone());
        let title = extract_note_title(&content);

        let content = match &passages_target {
            Some(target) => match passage_chapter(&content, target) {
                Some(chapter) => chapter,
                None => {
                    without_passages.push(stem);
                    continue;
                }
            },
            None => content,
        };

        // Rebase relative paths so `image("daisy.png")` still resolves from the
        // note's folder once inlined into the generated document at the notebox
        // root. See typst_pipeline::path_rebase.
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

    if passages_target.is_some() && notes.is_empty() {
        return Err(InkyCapError::ExportFailed(
            "No note in the collection has a passage linking to the chosen note.".to_string(),
        ));
    }

    // Leave out the notes the user excluded (by chapter stem). If none remain,
    // there's nothing to export.
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

    // In-place mode keeps each note's `#bibliography(...)`; Typst 0.15 allows
    // several per document.

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
    let notebox_root_owned = notebox_root_ref.map(|p| p.to_path_buf());
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
    let mut bib_path_for_wrapper: Option<String> = effective_bib.as_deref().map(|b| {
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
        // Anchor at the notebox root, not the `.collection` file's
        // `.inkycap/collections/` folder.
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

    // A collection template applies the bibliography through its own `#show:
    // …(bibliography: bibliography("<path>"))`. Generate that file from the works
    // the notes cite, and leave out our own `#bibliography(...)`, so there is
    // exactly one.
    if let (Some(root), Some(custom)) = (
        notebox_root_owned.as_deref(),
        base.custom_typst
            .as_deref()
            .filter(|c| !c.trim().is_empty()),
    ) {
        if let Some(bib_arg_path) = book_wrapper::extract_bibliography_path(custom) {
            let mut cited = std::collections::HashSet::new();
            for note in &notes {
                for key in crate::typst_pipeline::bibliography::extract_citations(&note.content) {
                    cited.insert(key);
                }
            }
            if !cited.is_empty() {
                let entries = crate::commands::bibliography::load_entries_inner(&state, &session)
                    .await
                    .unwrap_or_default();
                let filtered: Vec<_> = entries
                    .into_iter()
                    .filter(|e| cited.contains(&e.key))
                    .collect();
                if !filtered.is_empty() {
                    if let Err(e) = crate::typst_pipeline::bibliography::write_bibliography_file(
                        root,
                        &bib_arg_path,
                        &filtered,
                    ) {
                        log::warn!("failed to write collection bibliography {bib_arg_path}: {e}");
                    }
                }
            }
            // The template emits the bibliography via its argument — never also
            // emit the consolidated one (Typst allows one bibliography per doc).
            bib_path_for_wrapper = None;
        }
    }

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

    let normalize_headings = book_pdf_standard.includes_ua1();
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

    let mut compiler_guard = session.typst_compiler.lock().await;
    let compiler = compiler_guard
        .as_mut()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    compiler.ensure_system_fonts_for_settings(&*state.settings.read().await);

    if let Some(ref style) = base.bibliography_style {
        compiler.set_bibliography_style(Some(style.clone()));
    }
    let source =
        super::super::typst::maybe_inject_set_notebox(&source, &state, CompilePurpose::Export)
            .await;
    // Escape stray `@` (emails like `athena@inkycap.org`) from the inlined
    // notes. The book doesn't go through `prepare_bibliography`, so it needs
    // this too, or one email would fail the whole compile.
    let source =
        super::super::typst::escape_non_bib_citations(&source, state.inner(), &session).await;
    let source = ensure_document_date_for_standard(source, book_pdf_standard);
    check_pdf_standard_requirements(&source, book_pdf_standard)?;
    // Keep a copy to map any compile error's offset back to the note it came
    // from (the merged source is consumed by the compiler).
    let source_for_diag = source.clone();
    let compile_result = compiler.compile_pdf_diagnostics(
        &synthetic_main,
        source,
        book_pdf_standard,
        bypass_errors.unwrap_or(false),
    );
    compiler.set_bibliography_style(None);
    let output = match compile_result {
        Ok(output) => output,
        Err(diags) => {
            let message = book_wrapper::describe_book_diagnostics(
                &source_for_diag,
                &diags,
                effective_bib.as_deref(),
            );
            let failing = book_wrapper::book_diagnostic_note_stems(&source_for_diag, &diags);
            // Errors in specific notes: the caller can offer to exclude them
            // and retry. Others (front matter, package, no span) can't be fixed
            // that way.
            if failing.is_empty() {
                return Err(InkyCapError::ExportFailed(message));
            }
            return Ok(BookExportResult {
                output_path: None,
                failing_notes: failing,
                message: Some(message),
                bypassed: false,
                without_passages,
                companion: None,
            });
        }
    };
    drop(compiler_guard);

    tokio::fs::write(&output_path, &output.bytes)
        .await
        .map_err(|e| InkyCapError::ExportFailed(format!("Failed to write PDF: {}", e)))?;

    Ok(BookExportResult {
        output_path: Some(output_path),
        failing_notes: Vec::new(),
        message: None,
        bypassed: output.bypassed,
        without_passages,
        companion: companion.copy().await?,
    })
}

/// A chapter of the passages in `content` linking to `target` (lowercase),
/// separated by blank lines, or `None`.
fn passage_chapter(content: &str, target: &str) -> Option<String> {
    let parts: Vec<String> =
        crate::typst_pipeline::link_passages::inbound_passages(content, target)
            .into_iter()
            .map(|p| p.paragraph.source)
            .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

#[cfg(test)]
mod passage_chapter_tests {
    use super::passage_chapter;

    const NOTE: &str =
        "#note(title: \"S\")\n\n= One\nA #wikilink(\"T\").\n\nB #wikilink(\"T\").\n\n= Two\nC.";

    #[test]
    fn paragraphs_joined_in_order() {
        assert_eq!(
            passage_chapter(NOTE, "t").as_deref(),
            Some("A #wikilink(\"T\").\n\nB #wikilink(\"T\").")
        );
    }

    #[test]
    fn note_without_passage_is_none() {
        assert_eq!(passage_chapter(NOTE, "other"), None);
    }
}

/// Result of a book export: the PDF was written (`output_path`), or compiling
/// failed in notes the caller can exclude and retry (`failing_notes`, as stems,
/// and `message`). A failure excluding notes can't fix is returned as `Err`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookExportResult {
    pub output_path: Option<String>,
    pub failing_notes: Vec<String>,
    pub message: Option<String>,
    /// True when the book was written with errored markup kept as plain text.
    pub bypassed: bool,
    /// Stems of notes left out of a passages-only book because they hold no
    /// passage linking to the chosen note.
    pub without_passages: Vec<String>,
    /// The files copied into the folder beside the book.
    pub companion: Option<CompanionReport>,
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

/// Check a source for everything that would block export under the chosen PDF
/// standard, and report all of it in one error. For PDF/UA-1 the author needs
/// the full list (alt text on every image, gap-free headings, metadata);
/// silently filling in, e.g., `alt: "<filename>"` would pass but defeat the
/// point of the standard. `Ok(())` for `Standard` or when nothing is found.
pub fn check_pdf_standard_requirements(
    source: &str,
    standard: PdfStandardPreset,
) -> Result<(), InkyCapError> {
    if standard == PdfStandardPreset::Standard {
        return Ok(());
    }

    let mut issues: Vec<String> = Vec::new();

    if standard.includes_ua1() {
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

    let label = standard.label();
    Err(InkyCapError::ExportFailed(format!(
        "{label} export blocked by the following issue(s):\n\n{}",
        issues.join("\n\n")
    )))
}

/// Heading jumps that skip levels (e.g. `=` → `===`), which PDF/UA-1 forbids.
/// Headings come from Typst's parser, so `=== Example` in a code block doesn't
/// count.
fn heading_level_gaps(source: &str) -> Vec<(usize, u8, u8, String)> {
    let mut last_level: Option<u8> = None;
    let mut offenders = Vec::new();
    for heading in source_structure::headings(source) {
        if let Some(prev) = last_level {
            if heading.level > prev.saturating_add(1) {
                let text = heading.text.chars().take(60).collect::<String>();
                offenders.push((heading.line, prev, heading.level, text));
            }
        }
        last_level = Some(heading.level);
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
