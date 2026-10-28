//! Commands for the Typst packages a note imports: listing them, and adding,
//! removing or moving their imports (see
//! [`crate::typst_pipeline::note_package_edits`]).
//!
//! Like property edits, each change is written to the file on disk and the
//! note is reindexed; the frontend saves the editor first and reloads it after.

use std::collections::HashSet;
use std::path::Path;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::{AppState, NoteboxSession};
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_package_edits;
use crate::typst_pipeline::package_imports::{
    package_facts, package_imports, replaced_notebox_names,
};

/// The packages the note at `path` imports at top level, as canonical specs
/// (`@namespace/name:version`) in the order they appear, from the file on disk.
#[tauri::command]
pub async fn list_note_package_imports(
    state: State<'_, AppState>,
    path: String,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let path_arg = sanitize_notebox_arg(&path)?;
    let source = session.get_storage().await?.read_file(&path_arg).await?;
    let mut specs: Vec<String> = Vec::new();
    for import in package_imports(&source) {
        let spec = crate::typst_packages::PackageSpec::parse(&import.spec)
            .map(|p| p.canonical())
            .unwrap_or(import.spec);
        if !specs.contains(&spec) {
            specs.push(spec);
        }
    }
    Ok(specs)
}

/// Import everything from `spec` in the note at `path`, above the notebox
/// import so the package can't replace InkyCap's own functions. Nothing changes
/// if the note already imports it.
#[tauri::command]
pub async fn add_note_package(
    state: State<'_, AppState>,
    path: String,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    rewrite_note(&session, &path, |source| {
        Ok(note_package_edits::add_package(source, &spec))
    })
    .await
}

/// `source` (an editor's text) importing everything from `spec` above the
/// notebox import, or unchanged if it already imports it. For edits made in the
/// open editor, such as inserting a package's function from the `/` menu.
#[tauri::command]
pub fn add_package_to_source(source: String, spec: String) -> String {
    note_package_edits::add_package(&source, &spec)
}

/// Remove the note's imports of `spec`, and the whole-document `#show:` rules
/// that apply its functions (a template's), which would fail without it.
#[tauri::command]
pub async fn remove_note_package(
    state: State<'_, AppState>,
    path: String,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let exports = package_exports(&session, &spec).await;
    rewrite_note(&session, &path, |source| {
        Ok(note_package_edits::remove_package(source, &spec, &exports))
    })
    .await
}

/// Move a `*` import of `spec` that replaces InkyCap's functions above the
/// notebox import, keeping the clashing functions under the package's name
/// (`note as example-notes-note`). The fix offered by the clash warning.
#[tauri::command]
pub async fn fix_note_package_import(
    state: State<'_, AppState>,
    path: String,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let clashing = {
        let mut guard = session.typst_compiler.lock().await;
        let compiler = guard.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
        package_facts(compiler, &spec)
            .map(|facts| replaced_notebox_names(&facts))
            .unwrap_or_default()
    };
    rewrite_note(&session, &path, |source| {
        Ok(note_package_edits::fix_clashing_import(
            source, &spec, &clashing,
        ))
    })
    .await
}

/// Every name `spec` exports, or none if it isn't installed.
async fn package_exports(session: &NoteboxSession, spec: &str) -> HashSet<String> {
    let mut guard = session.typst_compiler.lock().await;
    let Some(compiler) = guard.as_mut() else {
        return HashSet::new();
    };
    package_facts(compiler, spec)
        .map(|facts| facts.exports.clone())
        .unwrap_or_default()
}

/// Read the note at `path`, apply `edit`, and write and reindex it if that
/// changed anything. Documentation noteboxes are read-only, as for property
/// edits.
async fn rewrite_note(
    session: &NoteboxSession,
    path: &str,
    edit: impl FnOnce(&str) -> Result<String, InkyCapError>,
) -> Result<(), InkyCapError> {
    if session.is_documentation() {
        return Ok(());
    }
    let storage = session.get_storage().await?;
    let path_buf = sanitize_notebox_arg(path)?;
    let source = storage.read_file(&path_buf).await?;
    let updated = edit(&crate::notebox_package::ensure_import(&source))?;
    if updated != source {
        storage.write_file(&path_buf, &updated).await?;
        session.reindex_note(Path::new(&path_buf), &updated).await;
    }
    Ok(())
}
