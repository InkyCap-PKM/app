//! Commands for `inkycap://` links (see [`crate::deep_link`]).

use tauri::{AppHandle, State, WebviewWindow};

use crate::deep_link::{Delivery, Inbox};
use crate::errors::InkyCapError;

/// Called once by the main window when it has loaded, before it restores a
/// notebox. Returns the link InkyCap was started with (or that arrived while
/// it was starting), which the window follows in place of restoring the last
/// notebox. From this call on, links go straight to the windows. Other windows
/// get `None` and change nothing.
#[tauri::command]
pub fn deep_link_ready(window: WebviewWindow, inbox: State<'_, Inbox>) -> Option<Delivery> {
    if window.label() != "main" {
        return None;
    }
    inbox.take_for_startup()
}

/// Follow an `inkycap://` link clicked inside InkyCap, exactly as if another
/// app had sent it. Fails with `BadRequest` when the link is not well formed,
/// so the note's author can be told; a well-formed link to a missing notebox
/// or note is reported to the window as an `app:deep-link` event instead.
#[tauri::command]
pub fn open_inkycap_url(app: AppHandle, url: String) -> Result<(), InkyCapError> {
    if crate::deep_link::receive(&app, &url) {
        Ok(())
    } else {
        Err(InkyCapError::BadRequest("not a valid inkycap link".into()))
    }
}
