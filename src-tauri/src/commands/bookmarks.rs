//! Bookmark commands. Every change is announced to all windows with
//! [`AppEvent::BookmarksChanged`], since bookmarks are app-wide, so each
//! window's Bookmarks pane reloads without the caller having to ask.

use tauri::{AppHandle, State};

use crate::bookmarks::{self, Bookmark, BookmarkKind};
use crate::errors::InkyCapError;
use crate::events::{publish, AppEvent, Audience};
use crate::state::AppState;

/// Return all bookmarks in their current order.
#[tauri::command]
pub async fn list_bookmarks(state: State<'_, AppState>) -> Result<Vec<Bookmark>, InkyCapError> {
    let bm = state.bookmarks.read().await;
    Ok(bm.clone())
}

/// Add a bookmark of the given kind and persist to disk; returns the new bookmark's ID.
#[tauri::command]
pub async fn add_bookmark(
    kind: BookmarkKind,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, InkyCapError> {
    let mut bm = state.bookmarks.write().await;
    let id = bookmarks::add_bookmark(&mut bm, kind);
    bookmarks::save_bookmarks(&bm)?;
    drop(bm);
    announce(&app);
    Ok(id)
}

/// Remove a bookmark by ID and persist; returns whether the bookmark existed.
#[tauri::command]
pub async fn remove_bookmark(
    bookmark_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<bool, InkyCapError> {
    let mut bm = state.bookmarks.write().await;
    let removed = bookmarks::remove_bookmark(&mut bm, &bookmark_id);
    if removed {
        bookmarks::save_bookmarks(&bm)?;
        drop(bm);
        announce(&app);
    }
    Ok(removed)
}

/// Move a bookmark from one position to another and persist the new order.
#[tauri::command]
pub async fn reorder_bookmarks(
    from_index: usize,
    to_index: usize,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), InkyCapError> {
    let mut bm = state.bookmarks.write().await;
    bookmarks::reorder_bookmark(&mut bm, from_index, to_index);
    bookmarks::save_bookmarks(&bm)?;
    drop(bm);
    announce(&app);
    Ok(())
}

fn announce(app: &AppHandle) {
    publish(app, Audience::AllWindows, AppEvent::BookmarksChanged);
}
