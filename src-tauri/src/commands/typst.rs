//! Typst-related Tauri commands. Exposes `compile_typst_svg` for paginated
//! reading mode and `compile_typst_html` for the flowing HTML reading mode.

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::{AppState, NoteboxSession};
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::bibliography::extract_citations;
use crate::typst_pipeline::package_fetch::compile_with_auto_packages;
use crate::typst_pipeline::style_injection;
use crate::typst_pipeline::{html_drawings, package_imports};
use crate::typst_pipeline::{TypstCompileResult, TypstCompiler, TypstDiagnostic, TypstHtmlResult};

/// Shift diagnostic line numbers in the main note back to the file on disk.
/// InkyCap inserts lines near the top before compiling, so everything below is
/// offset by the same count. Spans in imported files (`is_main == false`) are
/// unchanged.
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

/// Warnings for imports in `source` that replace InkyCap's own functions (see
/// [`package_imports::collision_warnings`]), for the note at `canonical`.
fn import_warnings(
    compiler: &mut TypstCompiler,
    source: &str,
    canonical: &std::path::Path,
    storage: &crate::storage::local::LocalNoteboxStorage,
) -> Vec<TypstDiagnostic> {
    let rel = crate::storage::to_frontend_string(
        &crate::commands::file_ops::notebox_relative_path(canonical, storage),
    );
    package_imports::collision_warnings(compiler, source, &rel)
}

/// Compile the note at `path` to per-page SVG with diagnostics. `path` may be
/// notebox-relative or absolute; it is canonicalized against the notebox root
/// and rejected if it leaves it (through `..`, an outside absolute path or a
/// symlink). The source is read through [`NoteboxStorage`], which applies the
/// same checks.
///
/// With `@` citations and no `#bibliography()`, one is appended so citations
/// resolve in reading mode.
#[tauri::command]
pub async fn compile_typst_svg(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TypstCompileResult, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_arg = sanitize_notebox_arg(&path)?;
    let storage = session.get_storage().await?;
    let canonical = storage.resolve_path(&path_arg)?;
    let source = storage.read_file(&path_arg).await?;

    // Count the lines inserted near the top (set-notebox and style cascade);
    // the bibliography goes at the end and shifts nothing.
    let original_lines = source.lines().count();
    let source = maybe_inject_set_notebox(&source, &state, CompilePurpose::ReadingView).await;
    let source = inject_style_cascade(&source, &path_arg, &state).await;
    let injected_line_offset = source.lines().count().saturating_sub(original_lines);
    let source = maybe_inject_preview_bibliography(&source, &state, &session).await;
    let source = escape_non_bib_citations(&source, &state, &session).await;

    let mut guard = session.typst_compiler.lock().await;
    let compiler = guard.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    ensure_system_fonts_if_needed(compiler, &state).await;
    // Paged reading shows the note as its PDF would look, template included.
    let import_warnings = import_warnings(compiler, &source, &canonical, &storage);
    let mut result =
        compile_with_auto_packages(compiler, |c| c.compile_svg(&canonical, source.clone()))
            .await
            .map_err(|err| InkyCapError::Typst(err.to_string()))?;
    result.diagnostics.extend(import_warnings);
    remap_diagnostic_lines(&mut result.diagnostics, injected_line_offset);
    Ok(result)
}

/// The citation style: the notebox's `custom_csl_path`, else the user's named
/// style, else `None` (Typst's default).
async fn resolve_citation_style(state: &AppState, session: &NoteboxSession) -> Option<String> {
    let notebox = session.notebox_settings.read().await;
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

/// Make sure citations resolve with the user's style:
///
/// 1. No `#bibliography(...)` and real citations: append one with path and
///    style.
/// 2. A `#bibliography(...)` without `style:`: add the user's style, so they
///    don't get Typst's IEEE default.
/// 3. A `#bibliography(...)` with `style:`: leave it.
async fn maybe_inject_preview_bibliography(
    source: &str,
    state: &AppState,
    session: &NoteboxSession,
) -> String {
    let explicit_bib_line = source.lines().enumerate().find(|(_, line)| {
        let trimmed = line.trim();
        !trimmed.starts_with("//") && trimmed.contains("#bibliography(")
    });

    if let Some((line_idx, line)) = explicit_bib_line {
        // User has an explicit #bibliography() — inject style if missing.
        return inject_style_into_explicit_bib(source, line, line_idx, state, session).await;
    }

    if !source_has_citation(source) {
        return source.to_string();
    }

    // Resolve the notebox-global bibliography source for this note's citations.
    let Some(bib) = resolve_preview_bib_path(session).await else {
        return source.to_string();
    };

    // Only if a citation key exists in the bibliography, so an email's
    // `@domain` doesn't trigger it.
    if let Ok(entries) = super::bibliography::load_entries_inner(state, session).await {
        let extracted = extract_citations(source);
        let has_valid = extracted
            .iter()
            .any(|k| entries.iter().any(|e| e.key == *k))
            || source_has_attribution(source);
        if !has_valid {
            return source.to_string();
        }
    }

    let style = resolve_citation_style(state, session).await;
    match style {
        Some(s) => format!(
            "{}\n\n#bibliography(\"{}\", style: \"{}\")\n",
            source.trim_end(),
            bib,
            s.replace('\\', "\\\\").replace('"', "\\\"")
        ),
        None => format!("{}\n\n#bibliography(\"{}\")\n", source.trim_end(), bib),
    }
}

/// Add the user's style to a `#bibliography(...)` that has no `style:`.
async fn inject_style_into_explicit_bib(
    source: &str,
    bib_line: &str,
    _line_idx: usize,
    state: &AppState,
    session: &NoteboxSession,
) -> String {
    if bib_line.contains("style:") {
        return source.to_string();
    }
    let Some(style) = resolve_citation_style(state, session).await else {
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

/// Escape `@key`s that match no bibliography entry (e.g. email addresses) so
/// Typst shows them as text. Runs after the bibliography step. Also used by
/// export (`export::helpers::prepare_bibliography` and the book export), so a
/// strict export doesn't fail on an email that renders fine in the reading
/// view.
pub(crate) async fn escape_non_bib_citations(
    source: &str,
    state: &AppState,
    session: &NoteboxSession,
) -> String {
    let valid_keys: std::collections::HashSet<String> =
        match super::bibliography::load_entries_inner(state, session).await {
            Ok(entries) => entries.into_iter().map(|e| e.key).collect(),
            Err(_) => std::collections::HashSet::new(),
        };
    crate::typst_pipeline::bibliography::escape_invalid_citations(source, &valid_keys)
}

/// True when `source` has anything Typst treats as a citation: `@key` (via
/// `extract_citations`) or `attribution: <key>` in a quote. Comment, `#import`
/// and `#set` lines are ignored.
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
        if trimmed.starts_with("//") {
            return false;
        }
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
    window: tauri::WebviewWindow,
) -> Result<TypstHtmlResult, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_arg = sanitize_notebox_arg(&path)?;
    let storage = session.get_storage().await?;
    let source = storage.read_file(&path_arg).await?;
    compile_html_source(&path_arg, &source, &state, &session).await
}

/// An HTML compile of part of a note, from [`compile_typst_html_excerpt`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExcerptHtmlResult {
    #[serde(flatten)]
    pub result: TypstHtmlResult,
    /// Part of the note was left out; false when the whole note was short
    /// enough to show as it is.
    pub truncated: bool,
}

/// Compile only the passages of `path` around its links to `linked_with` (or
/// its opening passage if there are none), with a unit of writing either side,
/// for the Journal Scroll's Neighbourhood. See
/// [`crate::typst_pipeline::note_excerpt`].
#[tauri::command]
pub async fn compile_typst_html_excerpt(
    path: String,
    linked_with: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<ExcerptHtmlResult, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_arg = sanitize_notebox_arg(&path)?;
    let linked_with = sanitize_notebox_arg(&linked_with)?;
    let storage = session.get_storage().await?;
    let source = storage.read_file(&path_arg).await?;
    let excerpt = crate::typst_pipeline::note_excerpt::excerpt_source(
        &source,
        &crate::link_index::note_stem(&linked_with),
    );
    let truncated = excerpt.is_some();
    let source = excerpt.unwrap_or(source);
    let result = compile_html_source(&path_arg, &source, &state, &session).await?;
    Ok(ExcerptHtmlResult { result, truncated })
}

/// Compile `source` to HTML as the note at `path_arg`, so its relative paths
/// and style settings resolve as they do for that note.
async fn compile_html_source(
    path_arg: &std::path::Path,
    source: &str,
    state: &AppState,
    session: &NoteboxSession,
) -> Result<TypstHtmlResult, InkyCapError> {
    let storage = session.get_storage().await?;
    let canonical = storage.resolve_path(path_arg)?;

    let original_lines = source.lines().count();
    let source = maybe_inject_set_notebox(source, state, CompilePurpose::ReadingView).await;
    let source = inject_style_cascade(&source, path_arg, state).await;
    // Tag citations with `data-cite-key` so the Scroll Context panel can find
    // them (HTML only; see `style_injection::inject_cite_tagging`).
    let source = style_injection::inject_cite_tagging(&source);
    // Re-emit `align()` blocks, which typst-html drops, as styled `<div>`s.
    // Done before the offset count so diagnostics map correctly.
    let source = style_injection::inject_html_align_shim(&source);
    let injected_line_offset = source.lines().count().saturating_sub(original_lines);
    let source = maybe_inject_preview_bibliography(&source, state, session).await;
    let source = escape_non_bib_citations(&source, state, session).await;

    let mut guard = session.typst_compiler.lock().await;
    let compiler = guard.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    ensure_system_fonts_if_needed(compiler, state).await;
    let import_warnings = import_warnings(compiler, &source, &canonical, &storage);
    // Templates lay notes out for print and apply only to PDF; the line
    // structure is kept, so diagnostics still map.
    let source = package_imports::without_template_rules(compiler, &source);
    let mut framed = html_drawings::frame_drawings(compiler, &source);
    let mut result = compile_with_auto_packages(compiler, |c| {
        c.compile_html(&canonical, framed.source.clone())
    })
    .await
    .map_err(|err| InkyCapError::Typst(err.to_string()))?;
    // Packages whose drawings HTML left out are learned from this compile; if
    // that changes what gets wrapped, compile again with them as images.
    if html_drawings::record_dropped(compiler, &result.dropped_by_packages) {
        let reframed = html_drawings::frame_drawings(compiler, &source);
        if reframed != framed {
            framed = reframed;
            result = compile_with_auto_packages(compiler, |c| {
                c.compile_html(&canonical, framed.source.clone())
            })
            .await
            .map_err(|err| InkyCapError::Typst(err.to_string()))?;
        }
    }
    framed.remap(&mut result.diagnostics, &source);
    result.diagnostics.extend(import_warnings);
    remap_diagnostic_lines(&mut result.diagnostics, injected_line_offset);
    Ok(result)
}

/// Add the app's document defaults (font, size, page) after the notebox import.
///
/// Collection styles aren't applied here: a note's `collection:` property lets a
/// collection include it, but the note's own reading view and export don't take
/// on the collection's styling (and a note in several collections would have no
/// clear winner). Collection styles apply only in collection exports (see
/// `commands::export`).
///
/// This is the single-note path: preview (`compile_typst_svg` / `_html`) and
/// single-note export. Templates and `#set` rules in the note still win through
/// the cascade.
pub(crate) async fn inject_style_cascade(
    source: &str,
    _note_path: &std::path::Path,
    state: &AppState,
) -> String {
    let settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_show_call_resolved(&settings);

    style_injection::inject_style_rules(
        source,
        if defaults_rules.is_empty() {
            None
        } else {
            Some(&defaults_rules)
        },
        None,
        None,
    )
}

/// What a compile is for. The reading view leaves annotations out (the editor's
/// pills and Changes & History show them); exports keep them, so reviewers'
/// remarks reach the shared copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompilePurpose {
    ReadingView,
    Export,
}

/// Add `#set-notebox(...)` after the import when a rendering toggle differs
/// from the package default (`true`): inline tags or wikilinks are turned off,
/// or the compile is for the reading view, which hides annotations.
///
/// The verse font isn't added: it is an editor-only preference (`--verse-font`
/// in CSS). For compiled output, use `#set-notebox(verse-font: ...)`,
/// `#verse(font: ...)` or a show rule, which adding it here would override.
pub(crate) async fn maybe_inject_set_notebox(
    source: &str,
    state: &AppState,
    purpose: CompilePurpose,
) -> String {
    let settings = state.settings.read().await;
    inject_set_notebox(
        source,
        settings.editor.show_inline_tags,
        settings.editor.show_inline_wikilinks,
        purpose,
    )
}

fn inject_set_notebox(
    source: &str,
    show_tags: bool,
    show_wikilinks: bool,
    purpose: CompilePurpose,
) -> String {
    let mut args: Vec<&str> = Vec::new();
    if !show_tags {
        args.push("show-inline-tags: false");
    }
    if !show_wikilinks {
        args.push("show-inline-wikilinks: false");
    }
    if purpose == CompilePurpose::ReadingView {
        args.push("show-annotations: false");
    }
    if args.is_empty() {
        return source.to_string();
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

/// The bibliography file for preview, if it exists. Unlike
/// `configure_bibliography`, this never re-exports.
async fn resolve_preview_bib_path(session: &NoteboxSession) -> Option<String> {
    let notebox_root = session.notebox_root.read().await.clone()?;
    let notebox = session.notebox_settings.read().await;
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
                if bib.starts_with('/') {
                    Some(bib.clone())
                } else {
                    Some(format!("/{bib}"))
                }
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{inject_set_notebox, CompilePurpose};

    const NOTE: &str = "#import \"/.inkycap/notebox.typ\": *\n= Body\n";

    #[test]
    fn export_with_default_toggles_is_unchanged() {
        assert_eq!(
            inject_set_notebox(NOTE, true, true, CompilePurpose::Export),
            NOTE
        );
    }

    #[test]
    fn reading_view_hides_annotations_after_the_import() {
        let out = inject_set_notebox(NOTE, true, true, CompilePurpose::ReadingView);
        assert_eq!(
            out,
            "#import \"/.inkycap/notebox.typ\": *\n#set-notebox(show-annotations: false)\n= Body\n"
        );
    }

    #[test]
    fn toggles_share_one_directive() {
        let out = inject_set_notebox(NOTE, false, true, CompilePurpose::ReadingView);
        assert!(out.contains("#set-notebox(show-inline-tags: false, show-annotations: false)\n"));
        let out = inject_set_notebox(NOTE, false, false, CompilePurpose::Export);
        assert!(
            out.contains("#set-notebox(show-inline-tags: false, show-inline-wikilinks: false)\n")
        );
    }
}
