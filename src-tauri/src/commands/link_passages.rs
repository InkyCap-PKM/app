//! Commands that return the passages of text around wikilinks (or around a
//! recurring phrase), for the Links pane and Compose mode, and that help
//! Compose edit its draft. The link index says *which* notes link; these read
//! the notes on request to find *where*. See [`crate::typst_pipeline::link_passages`] for what a passage
//! is.
//!
//! Text meant for copying is returned with relative paths
//! (`#image("pic.png")`) rebased to the notebox root, so it still finds its
//! files when pasted into a note in another folder.

use std::path::Path;
use std::time::Instant;

use tauri::State;

use crate::errors::InkyCapError;
use crate::link_index::note_stem;
use crate::state::AppState;
use crate::storage::local::LocalNoteboxStorage;
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::link_passages::{self, LinkPassage};

/// The passages in `source_path` that link to `target_path`, in document
/// order. Empty when the source links to the target only from its
/// properties (a `link-ref` value), since such a link has no surrounding
/// text.
#[tauri::command]
pub async fn get_link_passages(
    source_path: String,
    target_path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<LinkPassage>, InkyCapError> {
    let started = Instant::now();
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let source = sanitize_notebox_arg(&source_path)?;
    let target = sanitize_notebox_arg(&target_path)?;

    let content = storage.read_file(&source).await?;
    let mut passages = link_passages::inbound_passages(&content, &note_stem(&target));
    let dir = note_dir(&source, &storage);
    for p in &mut passages {
        rebase_passage(p, &dir);
    }
    log::debug!(
        "get_link_passages: {} passage(s) in {:?}",
        passages.len(),
        started.elapsed()
    );
    Ok(passages)
}

/// The opening passage of the note at `path`: its first paragraph or list
/// item, or its first heading with the paragraph after it. Compose shows it
/// for a note the origin links to, which has no passage linking back. `None`
/// when the note's body is empty.
#[tauri::command]
pub async fn get_lead_passage(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<LinkPassage>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path).await?;
    let mut passage = link_passages::lead_passage(&content);
    if let Some(p) = passage.as_mut() {
        rebase_passage(p, &note_dir(&path, &storage));
    }
    Ok(passage)
}

/// The passages in the note at `path` whose prose holds `phrase`, in
/// document order, with the phrase marked. Compose shows these for a page
/// made from a Mycelial View emergent concept, from the notes the concept
/// recurs in.
#[tauri::command]
pub async fn get_phrase_passages(
    path: String,
    phrase: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<LinkPassage>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path).await?;
    let mut passages = link_passages::phrase_passages(&content, &phrase);
    let dir = note_dir(&path, &storage);
    for p in &mut passages {
        rebase_passage(p, &dir);
    }
    Ok(passages)
}

/// The whole body of the note at `path`, ready to copy into another note:
/// without its `#import` lines, its `#note(...)` call, or any
/// `#bibliography(...)` call (a document may hold only one), and with
/// relative paths rebased to the notebox root.
#[tauri::command]
pub async fn get_note_body_for_copy(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    use crate::typst_pipeline::book_wrapper::prepare_note_for_include;
    use crate::typst_pipeline::path_rebase::rebase_relative_paths;
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path = sanitize_notebox_arg(&path)?;
    let content = storage.read_file(&path).await?;
    let body = prepare_note_for_include(&content);
    Ok(rebase_relative_paths(
        body.trim(),
        &note_dir(&path, &storage),
    ))
}

/// `content` with `source_name` added to its `derived-from` property, the
/// list of notes a draft copied passages from. `None` when the list already
/// holds that note. Works on text rather than the file so the editor can
/// apply the change to an open, unsaved note without reloading it.
#[tauri::command]
pub fn note_with_derived_from(content: String, source_name: String) -> Option<String> {
    let content = crate::notebox_package::ensure_import(&content);
    crate::typst_pipeline::note_rewriter::append_link_ref(&content, "derived-from", &source_name)
}

/// The lowercase names of the notes that `content`'s wikilinks point at, in
/// order and without repeats. Works on text so it can read an open note's
/// unsaved changes.
#[tauri::command]
pub fn wikilink_names(content: String) -> Vec<String> {
    link_passages::wikilink_names(&content)
}

/// The notebox-relative folder holding the note at `path`, which relative
/// paths in its text are resolved against.
fn note_dir(path: &Path, storage: &LocalNoteboxStorage) -> std::path::PathBuf {
    crate::commands::file_ops::notebox_relative_path(path, storage)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn rebase_passage(passage: &mut LinkPassage, note_dir: &Path) {
    use crate::typst_pipeline::path_rebase::rebase_relative_paths;
    let parts = [
        Some(&mut passage.paragraph),
        passage.before.as_mut(),
        passage.after.as_mut(),
    ];
    for part in parts.into_iter().flatten() {
        part.source = rebase_relative_paths(&part.source, note_dir);
    }
}
