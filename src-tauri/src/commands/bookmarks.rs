use tauri::State;

use crate::bookmarks::{self, Bookmark, BookmarkKind};
use crate::errors::InkyCapError;
use crate::state::AppState;

#[tauri::command]
pub async fn list_bookmarks(
    state: State<'_, AppState>,
) -> Result<Vec<Bookmark>, InkyCapError> {
    let bm = state.bookmarks.read().await;
    Ok(bm.clone())
}

#[tauri::command]
pub async fn add_bookmark(
    kind: BookmarkKind,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError> {
    let mut bm = state.bookmarks.write().await;
    let id = bookmarks::add_bookmark(&mut bm, kind);
    bookmarks::save_bookmarks(&bm)?;
    Ok(id)
}

#[tauri::command]
pub async fn remove_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
) -> Result<bool, InkyCapError> {
    let mut bm = state.bookmarks.write().await;
    let removed = bookmarks::remove_bookmark(&mut bm, &bookmark_id);
    if removed {
        bookmarks::save_bookmarks(&bm)?;
    }
    Ok(removed)
}

#[tauri::command]
pub async fn reorder_bookmarks(
    from_index: usize,
    to_index: usize,
    state: State<'_, AppState>,
) -> Result<(), InkyCapError> {
    let mut bm = state.bookmarks.write().await;
    bookmarks::reorder_bookmark(&mut bm, from_index, to_index);
    bookmarks::save_bookmarks(&bm)?;
    Ok(())
}
