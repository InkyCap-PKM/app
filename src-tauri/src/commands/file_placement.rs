//! Where new notes and incoming files are placed in the notebox.
//!
//! Note creation and files brought in from outside the notebox (copied,
//! dropped, pasted) share these rules so a note lands in the same folder
//! however it arrived:
//! - A file dropped on a folder in the file tree goes to that folder.
//! - Otherwise a note goes to the "New note location" folder, which for the
//!   "Current folder" option is the folder of the note the user is working in.
//! - Any other file goes to the attachment folder.

use serde::Deserialize;
use tauri::Manager;

use crate::state::{AppState, NoteboxSession};
use crate::storage::local::LocalNoteboxStorage;

/// Where the frontend wants an incoming file placed. Both fields are paths the
/// frontend already holds (absolute or notebox-relative); the backend turns
/// them into notebox-relative folders and validates them before writing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingPlacement {
    /// A folder the user explicitly chose (by dropping onto it in the file
    /// tree). When set, every file goes here, notes and attachments alike.
    pub target_folder: Option<String>,
    /// The note the user is working in, used by the "Current folder" option of
    /// "New note location".
    pub current_note: Option<String>,
}

/// The notebox-relative folder holding `note` (a path from the frontend), or
/// an empty string (the notebox root) when it is at the root, outside the
/// notebox, or not a valid path.
pub(crate) fn folder_of_note(note: &str, storage: &LocalNoteboxStorage) -> String {
    let Ok(arg) = crate::storage::path::sanitize_notebox_arg(note) else {
        return String::new();
    };
    let rel = crate::commands::file_ops::notebox_relative_path(&arg, storage);
    if rel.is_absolute() || rel.has_root() {
        return String::new();
    }
    rel.parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

/// The unexpanded "New note location" folder (see
/// [`crate::notebox_settings::NoteboxFileSettings::default_note_folder`]),
/// resolving "Current folder" against `current_note`.
pub(crate) async fn default_note_folder(
    session: &NoteboxSession,
    current_note: Option<&str>,
) -> String {
    let current_folder = match current_note {
        Some(note) => match session.get_storage().await {
            Ok(storage) => folder_of_note(note, &storage),
            Err(_) => String::new(),
        },
        None => String::new(),
    };
    session
        .notebox_settings
        .read()
        .await
        .files
        .default_note_folder(&current_folder)
}

/// The notebox-relative folder an incoming file should be written to, per the
/// rules in the module comment. `is_note` is true for Typst notes (including
/// Markdown converted to Typst). The result is not yet validated; callers
/// write through code that rejects folders outside the notebox.
pub(crate) async fn incoming_folder(
    app: &tauri::AppHandle,
    session: &NoteboxSession,
    placement: &IncomingPlacement,
    is_note: bool,
) -> String {
    if let Some(target) = placement.target_folder.as_deref() {
        return match session.get_storage().await {
            Ok(storage) => {
                let arg = crate::storage::path::sanitize_notebox_arg(target)
                    .unwrap_or_else(|_| target.into());
                let rel = crate::commands::file_ops::notebox_relative_path(&arg, &storage);
                // An absolute path that didn't strip is outside the notebox;
                // pass it on so the write is refused rather than redirected.
                rel.to_string_lossy().replace('\\', "/")
            }
            Err(_) => String::new(),
        };
    }
    if !is_note {
        return session
            .notebox_settings
            .read()
            .await
            .files
            .attachment_folder
            .clone();
    }
    let raw = default_note_folder(session, placement.current_note.as_deref()).await;
    let state = app.state::<AppState>();
    let locale = crate::scaffolds::chrono_locale(&state.settings.read().await.appearance.ui_locale);
    crate::creation_rules::expand_folder(&raw, locale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notebox_settings::NoteboxFileSettings;

    fn with_location(location: &str, folder: &str) -> NoteboxFileSettings {
        NoteboxFileSettings {
            new_note_location: location.to_string(),
            new_note_folder: folder.to_string(),
            ..NoteboxFileSettings::default()
        }
    }

    #[test]
    fn default_note_folder_follows_location() {
        assert_eq!(
            with_location("root", "Inbox").default_note_folder("Work"),
            ""
        );
        assert_eq!(
            with_location("specified", "/Inbox/").default_note_folder("Work"),
            "Inbox"
        );
        assert_eq!(
            with_location("current", "Inbox").default_note_folder("Work/Café"),
            "Work/Café"
        );
        assert_eq!(
            with_location("current", "Inbox").default_note_folder(""),
            ""
        );
    }

    #[test]
    fn folder_of_note_is_notebox_relative() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("Work/Café")).unwrap();
        let storage = LocalNoteboxStorage::new(dir.path().to_path_buf()).unwrap();
        let root = storage.canonical_root().to_path_buf();

        let nested = root.join("Work/Café/Note.typ");
        assert_eq!(
            folder_of_note(&nested.to_string_lossy(), &storage),
            "Work/Café"
        );
        let top = root.join("Note.typ");
        assert_eq!(folder_of_note(&top.to_string_lossy(), &storage), "");
        assert_eq!(folder_of_note("Work/Note.typ", &storage), "Work");
        // Outside the notebox, or trying to climb out of it: notebox root.
        assert_eq!(folder_of_note("/elsewhere/Note.typ", &storage), "");
        assert_eq!(folder_of_note("../Note.typ", &storage), "");
    }
}
