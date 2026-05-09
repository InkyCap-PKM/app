//! Typst-related Tauri commands. Exposes `compile_typst_svg` for paginated
//! reading mode and `compile_typst_html` for the flowing HTML reading mode.

use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::VaultStorage;
use crate::typst_pipeline::style_injection;
use crate::typst_pipeline::{TypstCompileResult, TypstHtmlResult};

/// Compile the note at `path` and return per-page SVG frames + diagnostics.
///
/// `path` may be vault-relative or absolute. Either way it is canonicalized
/// against the open vault root and rejected if it escapes the sandbox via
/// `..`, an absolute reference outside the vault, or a symlink. The source is
/// read through the [`VaultStorage`] trait so the same validation applies to
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
    let path_arg = PathBuf::from(&path);
    let storage = state.get_storage().await?;
    let canonical = storage.resolve_path(&path_arg)?;
    let source = storage.read_file(&path_arg).await?;

    let source = maybe_inject_set_vault(&source, &state).await;
    let source = inject_style_cascade(&source, &path_arg, &state).await;
    let source = maybe_inject_preview_bibliography(&source, &state).await;

    let mut guard = state.typst_compiler.lock().await;
    let compiler = guard
        .as_mut()
        .ok_or(InkyCapError::VaultNotOpen)?;
    ensure_system_fonts_if_needed(compiler, &state).await;
    compiler
        .compile_svg(&canonical, source)
        .map_err(|err| InkyCapError::Typst(err.to_string()))
}

/// If the source has `@` citations but no `#bibliography(...)` call, append a
/// bibliography so citations resolve and the bibliography section renders in
/// reading mode.
async fn maybe_inject_preview_bibliography(source: &str, state: &AppState) -> String {
    let has_explicit_bib = source.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.starts_with("//") && trimmed.contains("#bibliography(")
    });
    if has_explicit_bib {
        return source.to_string();
    }

    let has_citation = source.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with("//") { return false; }
        trimmed.contains('@')
            && !trimmed.starts_with("#import")
            && !trimmed.starts_with("#set")
    });
    if !has_citation {
        return source.to_string();
    }

    let bib_path = resolve_preview_bib_path(state).await;
    let Some(bib) = bib_path else {
        return source.to_string();
    };

    let style = {
        let settings = state.settings.read().await;
        settings
            .citations
            .custom_csl_path
            .clone()
            .or_else(|| {
                settings
                    .citations
                    .citation_style
                    .as_deref()
                    .filter(|s| !s.is_empty() && *s != "custom")
                    .map(String::from)
            })
    };

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

/// Compile the note at `path` to flowing HTML using Typst's native HTML
/// backend. Same path validation and bibliography injection as `compile_typst_svg`.
#[tauri::command]
pub async fn compile_typst_html(
    path: String,
    state: State<'_, AppState>,
) -> Result<TypstHtmlResult, InkyCapError> {
    let path_arg = PathBuf::from(&path);
    let storage = state.get_storage().await?;
    let canonical = storage.resolve_path(&path_arg)?;
    let source = storage.read_file(&path_arg).await?;

    let source = maybe_inject_set_vault(&source, &state).await;
    let source = inject_style_cascade(&source, &path_arg, &state).await;
    let source = maybe_inject_preview_bibliography(&source, &state).await;

    let mut guard = state.typst_compiler.lock().await;
    let compiler = guard
        .as_mut()
        .ok_or(InkyCapError::VaultNotOpen)?;
    ensure_system_fonts_if_needed(compiler, &state).await;
    compiler
        .compile_html(&canonical, source)
        .map_err(|err| InkyCapError::Typst(err.to_string()))
}

/// Inject the style cascade: app document defaults, then collection style
/// overrides. Both are injected after the inkycap-vault import line so that
/// collection overrides beat app defaults, and any template import or user
/// `#set` rules later in the document win over both.
pub(crate) async fn inject_style_cascade(source: &str, note_path: &std::path::Path, state: &AppState) -> String {
    let settings = state.settings.read().await;
    let defaults_rules = style_injection::build_defaults_rules(
        &settings.document,
        &settings.appearance.monospace_font,
    );

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
    let vault_root = state.vault_root.read().await.clone()?;

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

    // Find the .collection file for this collection. Convention: the .collection file
    // is named `<collection>.collection` and can live at the vault root or in
    // any subdirectory. We scan known collection paths from the collection list.
    let storage = match state.get_storage().await {
        Ok(s) => s,
        Err(_) => return None,
    };

    let collection_filename = format!("{}.collection", collection_name);
    let collection_path = vault_root.join(&collection_filename);
    let collection_content = if let Ok(content) = storage.read_file(&collection_path).await {
        content
    } else {
        // Try to find it by scanning — but for now, just return None if the
        // direct path doesn't work. The collection might be defined elsewhere.
        return None;
    };

    let base = crate::collection_parser::model::parse_collection_file(&collection_content).ok()?;
    let style = base.style?;
    let call = style.to_typst_show_call();

    if call.is_empty() { None } else { Some(call) }
}

/// Inject `#set-vault(...)` after the `#import` line when the user has toggled
/// show-inline-tags or show-inline-wikilinks off, or has a verse-font configured
/// for compiled output. Defaults are `true`/`none` in the Typst package, so we
/// only inject when overriding. `pub(crate)` so export paths share the same
/// directive — without it, exports rendered verse blocks in the document text
/// font instead of the user's configured verse font.
pub(crate) async fn maybe_inject_set_vault(source: &str, state: &AppState) -> String {
    let settings = state.settings.read().await;
    let show_tags = settings.editor.show_inline_tags;
    let show_wikilinks = settings.editor.show_inline_wikilinks;
    let verse_font = if settings.editor.apply_verse_font_to_output {
        settings
            .editor
            .verse_font
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    } else {
        None
    };

    if show_tags && show_wikilinks && verse_font.is_none() {
        return source.to_string();
    }

    let mut args: Vec<String> = Vec::new();
    if !show_tags {
        args.push("show-inline-tags: false".to_string());
    }
    if !show_wikilinks {
        args.push("show-inline-wikilinks: false".to_string());
    }
    if let Some(font) = verse_font.as_deref() {
        // Escape backslashes and quotes for the Typst string literal.
        let escaped = font.replace('\\', "\\\\").replace('"', "\\\"");
        args.push(format!("verse-font: \"{}\"", escaped));
    }
    let directive = format!("#set-vault({})", args.join(", "));

    let mut out = String::with_capacity(source.len() + directive.len() + 2);
    let mut injected = false;
    for line in source.lines() {
        out.push_str(line);
        out.push('\n');
        // Use the canonical helper so this matches both the current
        // `/.inkycap/vault.typ` import and the legacy versioned package
        // path. The previous check (`line.contains("inkycap-vault")`)
        // missed the canonical form, causing the directive to fall
        // through to the end-of-file fallback below — which placed it
        // AFTER any `#verse(...)` calls, so state.update() ran after
        // state.get() and the verse-font override silently did nothing.
        if !injected && crate::vault_package::is_vault_import_line(line) {
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
    let vault_root = state.vault_root.read().await.clone()?;
    let settings = state.settings.read().await;
    match settings.citations.source.as_str() {
        "zotero" => {
            let export_path = vault_root.join(".inkycap/zotero-export.bib");
            if export_path.exists() {
                Some("/.inkycap/zotero-export.bib".to_string())
            } else {
                None
            }
        }
        _ => {
            let bib = settings.citations.bibliography_path.as_ref()?;
            let abs = vault_root.join(bib);
            if abs.exists() {
                if bib.starts_with('/') { Some(bib.clone()) } else { Some(format!("/{bib}")) }
            } else {
                None
            }
        }
    }
}
