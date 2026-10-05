//! Commands that return the passages of text around wikilinks, for the Links
//! pane and Compose mode, and that help Compose edit its draft. The link index says *which* notes link; these read
//! the notes on request to find *where*. See
//! [`crate::typst_pipeline::link_passages`] for what a passage is.
//!
//! Passage sources are returned with relative paths (`#image("pic.png")`)
//! rebased to the notebox root, so text copied into a note in another folder
//! still finds its files.

use std::path::{Path, PathBuf};
use std::time::Instant;

use tauri::State;

use crate::errors::InkyCapError;
use crate::link_index::note_stem;
use crate::state::{AppState, NoteboxSession};
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
    let note_dir = note_dir_in_notebox(&session, &source).await;
    for p in &mut passages {
        rebase_passage(p, &note_dir);
    }
    log::debug!(
        "get_link_passages: {} passage(s) in {:?}",
        passages.len(),
        started.elapsed()
    );
    Ok(passages)
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

/// The folder holding `path`, relative to the notebox root (empty at the
/// root or when the root is unknown).
async fn note_dir_in_notebox(session: &NoteboxSession, path: &Path) -> PathBuf {
    let root = session.notebox_root.read().await.clone();
    path.parent()
        .and_then(|dir| root.as_deref().and_then(|r| dir.strip_prefix(r).ok()))
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
