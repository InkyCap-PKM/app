//! Typst-related Tauri commands. Exposes `compile_typst_svg` for paginated
//! reading mode and `compile_typst_html` for the flowing HTML reading mode.

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::bibliography::extract_citations;
use crate::typst_pipeline::style_injection;
use crate::typst_pipeline::{TypstCompileResult, TypstDiagnostic, TypstHtmlResult};

/// Shift main-note diagnostic line numbers back to the user's on-disk file.
///
/// InkyCap inserts style/notebox lines into the note source (after the import
/// line) before handing it to Typst, so Typst's diagnostic lines are offset
/// from what the source editor shows. The insertions all land near the top of
/// the file, so every position below them shifts by the same line count —
/// subtract it. Spans in imported files (`is_main == false`) are untouched.
fn remap_diagnostic_lines(diagnostics: &mut [TypstDiagnostic], injected_line_offset: usize) {
    if injected_line_offset == 0 {
        return;
    }
    for diag in diagnostics {
        if let Some(span) = diag.primary.as_mut() {
            if span.is_main {
                if let Some(line) = span.line {
                    span.line = Some(line.saturating_sub(injected_line_offset).max(1));
                }
            }
        }
    }
}

/// Compile the note at `path` and return per-page SVG frames + diagnostics.
///
/// `path` may be notebox-relative or absolute. Either way it is canonicalized
/// against the open notebox root and rejected if it escapes the sandbox via
/// `..`, an absolute reference outside the notebox, or a symlink. The source is
/// read through the [`NoteboxStorage`] trait so the same validation applies to
/// the file read itself.
///
/// When the source contains `@` citations but no explicit `#bibliography()`
/// call, a bibliography is appended so citations resolve and the bibliography
/// section renders in reading mode.
#[tauri::command]
pub async fn compile_typst_svg(
    path: String,
    state: State<'_, AppState>,
) -> Result<TypstCompileResult, InkyCapError> {
    let path_arg = sanitize_notebox_arg(&path)?;
    let storage = state.get_storage().await?;
    let canonical = storage.resolve_path(&path_arg)?;
    let source = storage.read_file(&path_arg).await?;

    // Track lines inserted near the top of the file: only the set-notebox and
    // style-cascade steps shift existing line numbers. The bibliography step
    // appends at the end, below all user content, so it never does.
    let original_lines = source.lines().count();
    let source = maybe_inject_set_notebox(&source, &state).await;
    let source = inject_style_cascade(&source, &path_arg, &state).await;
    let injected_line_offset = source.lines().count().saturating_sub(original_lines);
    let source = maybe_inject_preview_bibliography(&source, &state).await;
    let source = escape_non_bib_citations(&source, &state).await;

    let mut guard = state.typst_compiler.lock().await;
    let compiler = guard
        .as_mut()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    ensure_system_fonts_if_needed(compiler, &state).await;
    let mut result = compiler
        .compile_svg(&canonical, source)
        .map_err(|err| InkyCapError::Typst(err.to_string()))?;
    remap_diagnostic_lines(&mut result.diagnostics, injected_line_offset);
    Ok(result)
}

/// Resolve the user's chosen citation style. The per-notebox
/// `custom_csl_path` overrides the user-global named style; otherwise the
/// global style applies. Returns `None` when nothing is configured (Typst's
/// built-in default will apply).
async fn resolve_citation_style(state: &AppState) -> Option<String> {
    let notebox = state.notebox_settings.read().await;
    if let Some(p) = notebox.citations.custom_csl_path.clone() {
        return Some(p);
    }
    let settings = state.settings.read().await;
    settings
        .citations
        .citation_style
        .as_deref()
        .filter(|s| !s.is_empty() && *s != "custom")
        .map(String::from)
}

/// Ensure the source has a bibliography call that resolves citations and
/// respects the user's style setting from preferences.
///
/// Three cases:
/// 1. No `#bibliography(...)` and valid citations exist → append full call
///    with path and style.
/// 2. Explicit `#bibliography(...)` present but no `style:` argument →
///    inject the user's style from settings so they don't get Typst's
///    default (IEEE) when they've chosen e.g. Chicago Notes.
/// 3. Explicit `#bibliography(...)` with `style:` → leave untouched.
async fn maybe_inject_preview_bibliography(source: &str, state: &AppState) -> String {
    let explicit_bib_line = source.lines().enumerate().find(|(_, line)| {
        let trimmed = line.trim();
        !trimmed.starts_with("//") && trimmed.contains("#bibliography(")
    });

    if let Some((line_idx, line)) = explicit_bib_line {
        // User has an explicit #bibliography() — inject style if missing.
        return inject_style_into_explicit_bib(source, line, line_idx, state).await;
    }

    if !source_has_citation(source) {
        return source.to_string();
    }

    // Resolve the notebox-global bibliography source for this note's citations.
    let Some(bib) = resolve_preview_bib_path(state).await else {
        return source.to_string();
    };

    // Only inject if at least one extracted citation key actually exists
    // in the bibliography. Prevents false-positives from email addresses
    // like `user@domain.com` where Typst sees `@domain` as a citation.
    if let Ok(entries) = super::bibliography::load_entries_inner(state).await {
        let extracted = extract_citations(source);
        let has_valid = extracted.iter().any(|k| entries.iter().any(|e| e.key == *k))
            || source_has_attribution(source);
        if !has_valid {
            return source.to_string();
        }
    }

    let style = resolve_citation_style(state).await;
    match style {
        Some(s) => format!(
            "{}\n\n#bibliography(\"{}\", style: \"{}\")\n",
            source.trim_end(),
            bib,
            s.replace('\\', "\\\\").replace('"', "\\\"")
        ),
        None => format!(
            "{}\n\n#bibliography(\"{}\")\n",
            source.trim_end(),
            bib
        ),
    }
}

/// When the user has an explicit `#bibliography(...)` call but no `style:`
/// argument, inject their preferred style from settings so the rendered
/// bibliography matches their choice (not Typst's default IEEE).
async fn inject_style_into_explicit_bib(
    source: &str,
    bib_line: &str,
    _line_idx: usize,
    state: &AppState,
) -> String {
    if bib_line.contains("style:") {
        return source.to_string();
    }
    let Some(style) = resolve_citation_style(state).await else {
        return source.to_string();
    };
    let escaped = style.replace('\\', "\\\\").replace('"', "\\\"");
    // Insert `style: "..."` before the closing `)` of the #bibliography() call.
    let trimmed = bib_line.trim();
    if let Some(close_paren) = trimmed.rfind(')') {
        let before = &trimmed[..close_paren];
        let after = &trimmed[close_paren..];
        let separator = if before.trim_end().ends_with(',') || before.trim_end().ends_with('(') {
            " "
        } else {
            ", "
        };
        let new_line = format!("{}{separator}style: \"{escaped}\"{after}", before);
        source.replace(trimmed, &new_line)
    } else {
        source.to_string()
    }
}

/// Escape `@key` patterns that don't match any entry in the user's
/// bibliography, so Typst treats them as literal text (e.g. email
/// addresses like `user@domain.com`). Runs after bibliography injection.
async fn escape_non_bib_citations(source: &str, state: &AppState) -> String {
    let valid_keys: std::collections::HashSet<String> = match super::bibliography::load_entries_inner(state).await {
        Ok(entries) => entries.into_iter().map(|e| e.key).collect(),
        Err(_) => std::collections::HashSet::new(),
    };
    crate::typst_pipeline::bibliography::escape_invalid_citations(source, &valid_keys)
}

/// True when `source` contains anything Typst will treat as a citation
/// (and therefore needs a bibliography to resolve).
///
/// Two forms count:
/// - `@key` — markup-mode citation sugar (via `extract_citations`).
/// - `attribution: <key>` — `quote`'s label-as-cite parameter form.
///
/// Comment lines (`//`) and `#import` / `#set` lines are excluded so an
/// `@` inside an import path or set rule doesn't false-positive.
pub(crate) fn source_has_citation(source: &str) -> bool {
    if !crate::typst_pipeline::bibliography::extract_citations(source).is_empty() {
        return true;
    }
    source_has_attribution(source)
}

/// True when `source` contains `attribution: <key>` — `quote`'s
/// label-as-cite parameter form that also requires a bibliography.
fn source_has_attribution(source: &str) -> bool {
    source.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with("//") { return false; }
        if let Some(idx) = trimmed.find("attribution") {
            let after = &trimmed[idx + "attribution".len()..];
            let after = after.trim_start();
            if let Some(rest) = after.strip_prefix(':') {
                let rest = rest.trim_start();
                if rest.starts_with('<') {
                    return true;
                }
            }
        }
        false
    })
}

/// Compile the note at `path` to flowing HTML using Typst's native HTML
/// backend. Same path validation and bibliography injection as `compile_typst_svg`.
#[tauri::command]
pub async fn compile_typst_html(
    path: String,
    state: State<'_, AppState>,
) -> Result<TypstHtmlResult, InkyCapError> {
    let path_arg = sanitize_notebox_arg(&path)?;
    let storage = state.get_storage().await?;
    let canonical = storage.resolve_path(&path_arg)?;
    let source = storage.read_file(&path_arg).await?;

    let original_lines = source.lines().count();
    let source = maybe_inject_set_notebox(&source, &state).await;
    let source = inject_style_cascade(&source, &path_arg, &state).await;
    // Tag citations with `data-cite-key` so the Scroll Context panel can
    // locate and highlight them. HTML render path only — see
    // `style_injection::inject_cite_tagging`.
    let source = style_injection::inject_cite_tagging(&source);
    let injected_line_offset = source.lines().count().saturating_sub(original_lines);
    let source = maybe_inject_preview_bibliography(&source, &state).await;
    let source = escape_non_bib_citations(&source, &state).await;

    let mut guard = state.typst_compiler.lock().await;
    let compiler = guard
        .as_mut()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    ensure_system_fonts_if_needed(compiler, &state).await;
    let mut result = compiler
        .compile_html(&canonical, source)
        .map_err(|err| InkyCapError::Typst(err.to_string()))?;
    remap_diagnostic_lines(&mut result.diagnostics, injected_line_offset);
    Ok(result)
}

/// Inject the style cascade: app document defaults, then collection style
/// overrides. Both are injected after the inkycap-notebox import line so that
/// collection overrides beat app defaults, and any template import or user
/// `#set` rules later in the document win over both.
pub(crate) async fn inject_style_cascade(source: &str, note_path: &std::path::Path, state: &AppState) -> String {
    let settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_show_call_resolved(&settings);

    let collection_rules = resolve_collection_style(note_path, state).await;

    style_injection::inject_style_rules(
        source,
        if defaults_rules.is_empty() { None } else { Some(&defaults_rules) },
        collection_rules.as_deref(),
    )
}

/// Look up which collection a note belongs to and return the collection's
/// style overrides as Typst `#set` rules, if any.
async fn resolve_collection_style(note_path: &std::path::Path, state: &AppState) -> Option<String> {
    // Find the note's collection property
    let idx = state.property_index.read().await;
    let note = idx.notes.get(note_path)?;
    let collection_val = note.properties.get("collection")?;

    let collection_name = match collection_val {
        crate::models::note::PropertyValue::String(s) => s.clone(),
        crate::models::note::PropertyValue::List(list) => {
            list.first()?.as_str()?.to_string()
        }
        _ => return None,
    };
    drop(idx);

    if collection_name.is_empty() {
        return None;
    }

    // Resolve the `.collection` file from the authoritative list (collections
    // live under `.inkycap/collections/`, not the notebox root), matching by
    // file stem — the same value the `collection` property carries.
    let storage = state.get_storage().await.ok()?;
    let collection_files = state.collection_files.read().await.clone();
    let collection_path = collection_files
        .iter()
        .find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(collection_name.as_str()))?;
    let collection_content = storage.read_file(collection_path).await.ok()?;

    let base = crate::collection_parser::model::parse_collection_file(&collection_content).ok()?;
    let style = base.style?;
    let call = style.to_typst_show_call();

    if call.is_empty() { None } else { Some(call) }
}

/// Inject `#set-notebox(...)` after the `#import` line when the user has toggled
/// show-inline-tags or show-inline-wikilinks off. Defaults are `true` in the
/// Typst package, so we only inject when overriding.
///
/// Note: the verse font is intentionally NOT auto-injected here. It's an
/// editor-only preference (preview affordance via `--verse-font` in CSS); a
/// user who wants verse styled differently in compiled output should reach
/// for Typst-native control — `#set-notebox(verse-font: ...)`, the `font:`
/// argument on `#verse(...)`, or a document-level show-rule on the verse
/// element. Auto-injecting would silently override those choices.
pub(crate) async fn maybe_inject_set_notebox(source: &str, state: &AppState) -> String {
    let settings = state.settings.read().await;
    let show_tags = settings.editor.show_inline_tags;
    let show_wikilinks = settings.editor.show_inline_wikilinks;

    if show_tags && show_wikilinks {
        return source.to_string();
    }

    let mut args: Vec<String> = Vec::new();
    if !show_tags {
        args.push("show-inline-tags: false".to_string());
    }
    if !show_wikilinks {
        args.push("show-inline-wikilinks: false".to_string());
    }
    let directive = format!("#set-notebox({})", args.join(", "));

    let mut out = String::with_capacity(source.len() + directive.len() + 2);
    let mut injected = false;
    for line in source.lines() {
        out.push_str(line);
        out.push('\n');
        if !injected && crate::notebox_package::is_notebox_import_line(line) {
            out.push_str(&directive);
            out.push('\n');
            injected = true;
        }
    }
    if !injected {
        out.push_str(&directive);
        out.push('\n');
    }
    out
}

async fn ensure_system_fonts_if_needed(
    compiler: &mut crate::typst_pipeline::TypstCompiler,
    state: &AppState,
) {
    if compiler.system_fonts_loaded() {
        return;
    }
    let settings = state.settings.read().await;
    compiler.ensure_system_fonts_for_settings(&settings);
}

/// Resolve the bibliography file path for preview injection. Unlike
/// `configure_bibliography`, this never re-exports — it just checks whether
/// the expected file already exists on disk.
async fn resolve_preview_bib_path(state: &AppState) -> Option<String> {
    let notebox_root = state.notebox_root.read().await.clone()?;
    let notebox = state.notebox_settings.read().await;
    match notebox.citations.source.as_str() {
        "zotero" => {
            let export_path = notebox_root.join(".inkycap/zotero-export.bib");
            if export_path.exists() {
                Some("/.inkycap/zotero-export.bib".to_string())
            } else {
                None
            }
        }
        _ => {
            let bib = notebox.citations.bibliography_path.as_ref()?;
            let abs = notebox_root.join(bib);
            if abs.exists() {
                if bib.starts_with('/') { Some(bib.clone()) } else { Some(format!("/{bib}")) }
            } else {
                None
            }
        }
    }
}
