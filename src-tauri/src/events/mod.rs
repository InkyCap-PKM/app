//! The app event bus: every significant backend event is an [`AppEvent`], and
//! [`publish`] is the one place events leave the backend for the frontend.
//!
//! Each variant has a fixed frontend event name and payload (see
//! [`AppEvent::frontend_form`]); the frontend listens for those names in
//! `src/lib/events.ts` and `src/stores/`. Code that wants to tell the webview
//! something adds or reuses a variant here and calls [`publish`], rather than
//! emitting a Tauri event directly. Plugin hooks, when they exist, attach at
//! [`publish`] too.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::git::backend::GitStatusSummary;
use crate::state::IndexStats;
use crate::storage::to_frontend_string;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum AppEvent {
    NoteboxOpened {
        path: PathBuf,
    },
    /// The open notebox's folder no longer exists (deleted, moved, or its
    /// drive was unplugged).
    NoteboxLost {
        path: PathBuf,
    },
    FileChanged {
        path: PathBuf,
        change: ChangeKind,
    },
    FileCreated {
        path: PathBuf,
    },
    FileDeleted {
        path: PathBuf,
    },
    /// Atomic rename observed by the watcher with both endpoints known
    /// (notify's `RenameMode::Both`). Carries paired paths so the index
    /// layer can rewrite wikilinks in referencing notes instead of
    /// orphaning them, which is what a split delete+create would do.
    FileRenamed {
        from: PathBuf,
        to: PathBuf,
    },
    /// The user's bookmarks changed (they are app-wide, not per notebox).
    BookmarksChanged,
    IndexRebuilt,
    /// A notebox index build finished; carries the counts it found.
    IndexReady(IndexStats),
    /// A notebox index build failed; the indexes stay as they were.
    IndexError {
        error: String,
    },
    /// One note's index entries were updated or removed.
    NoteIndexUpdated {
        path: PathBuf,
    },
    /// A renamed note's index entries moved from `from` to `to`.
    NoteRenameIndexed {
        from: PathBuf,
        to: PathBuf,
    },
    /// Every index was rebuilt from disk ("Rebuild cache").
    IndexesRebuiltFromDisk,
    CollectionUpdated {
        collection_path: PathBuf,
    },
    /// The last-backup state changed (a backup ran, or its settings moved).
    BackupStateChanged,

    // --- Notebox-level git collaboration (see `crate::git`) ---
    // The collaboration loop never blocks on a command for credentials;
    // when fetch/push need a credential the backend doesn't have, it raises
    // `GitCredentialNeeded` and the frontend prompts. The fetch/consolidate/
    // push lifecycle reports progress through the remaining variants.
    /// Git state of a collaborative notebox, sent when it is opened.
    GitStatus {
        remote: String,
        branch: String,
        status: GitStatusSummary,
    },
    /// The notebox is a git repository with a remote but no collaboration
    /// settings; the frontend offers to reconnect it.
    GitReconnectable {
        remote: String,
        branch: String,
    },
    /// A fetch from the configured remote has begun.
    GitFetchStarted,
    /// A fetch finished; the working tree is untouched (review sits between
    /// fetch and apply).
    GitFetchCompleted,
    /// There are `count` incoming notes staged for inline review.
    GitReviewPending {
        count: usize,
    },
    /// A staged note was resolved and written back to the working tree as a
    /// commit.
    GitConsolidated {
        path: PathBuf,
    },
    /// A push to the remote has begun.
    GitPushStarted,
    /// A push finished.
    GitPushCompleted,
    /// Fetch/push could not authenticate with the stored (or absent)
    /// credentials for `remote`. The frontend prompts the user to sign in;
    /// the backend never blocks waiting on a command. `transport` is what
    /// needs a credential ("ssh" or "https"). (Field is not named `kind`
    /// because that is the serde tag for this enum.)
    GitCredentialNeeded {
        remote: String,
        transport: String,
    },
    /// A git operation failed; `message` is safe to show (no note content).
    GitError {
        message: String,
    },

    /// An `inkycap://` link for this window to follow (see `crate::deep_link`).
    DeepLink(crate::deep_link::Delivery),
}

#[derive(Debug, Clone, Serialize)]
pub enum ChangeKind {
    Content,
    Metadata,
}

/// Which windows an event is for.
#[derive(Debug, Clone, Copy)]
pub enum Audience<'a> {
    /// The window with this label: events about the notebox open in it.
    Window(&'a str),
    /// Every window: events about app-wide state (bookmarks, backups).
    AllWindows,
}

/// Send `event` to the frontend windows in `audience`.
///
/// Delivery is best-effort: a window that has closed just misses the event.
/// Frontend listeners for per-notebox events without a path to filter on
/// must scope themselves with `thisWindowOnly()` (see `src/lib/events.ts`),
/// because Tauri's default listener also hears events sent to other windows.
pub fn publish(app: &AppHandle, audience: Audience<'_>, event: AppEvent) {
    let (name, payload) = event.frontend_form();
    let sent = match audience {
        Audience::Window(label) => app.emit_to(label, name, payload),
        Audience::AllWindows => app.emit(name, payload),
    };
    if let Err(err) = sent {
        log::debug!("event {name} not delivered: {err}");
    }
}

impl AppEvent {
    /// The frontend event name and JSON payload for this event. Paths go out
    /// in the canonical frontend shape (see [`to_frontend_string`]).
    fn frontend_form(&self) -> (&'static str, serde_json::Value) {
        let path = |p: &PathBuf| to_frontend_string(p);
        match self {
            AppEvent::NoteboxOpened { path: p } => ("notebox:opened", json!({ "path": path(p) })),
            AppEvent::NoteboxLost { path: p } => ("notebox:lost", json!({ "path": path(p) })),
            AppEvent::FileChanged { path: p, change } => (
                "notebox:file-changed",
                json!({ "path": path(p), "change": change }),
            ),
            AppEvent::FileCreated { path: p } => {
                ("notebox:file-created", json!({ "path": path(p) }))
            }
            AppEvent::FileDeleted { path: p } => {
                ("notebox:file-deleted", json!({ "path": path(p) }))
            }
            AppEvent::FileRenamed { from, to } => (
                "notebox:file-renamed",
                json!({ "from": path(from), "to": path(to) }),
            ),
            AppEvent::BookmarksChanged => ("notebox:bookmarks-changed", json!(null)),
            AppEvent::IndexRebuilt => ("notebox:index-rebuilt", json!(null)),
            AppEvent::IndexReady(stats) => ("notebox:index-ready", json!(stats)),
            AppEvent::IndexError { error } => ("notebox:index-error", json!({ "error": error })),
            AppEvent::NoteIndexUpdated { path: p } => {
                ("notebox:index-updated", json!({ "path": path(p) }))
            }
            AppEvent::NoteRenameIndexed { from, to } => (
                "notebox:index-updated",
                json!({ "from": path(from), "to": path(to) }),
            ),
            AppEvent::IndexesRebuiltFromDisk => {
                ("notebox:index-updated", json!({ "rebuilt": true }))
            }
            AppEvent::CollectionUpdated { collection_path } => (
                "notebox:collection-updated",
                json!({ "path": path(collection_path) }),
            ),
            AppEvent::BackupStateChanged => ("backup:state-changed", json!(null)),
            AppEvent::GitStatus {
                remote,
                branch,
                status,
            } => (
                "notebox:git-status",
                json!({ "remote": remote, "branch": branch, "status": status }),
            ),
            AppEvent::GitReconnectable { remote, branch } => (
                "notebox:git-reconnectable",
                json!({ "remote": remote, "branch": branch }),
            ),
            AppEvent::GitFetchStarted => ("notebox:git-fetch-started", json!(null)),
            AppEvent::GitFetchCompleted => ("notebox:git-fetch-completed", json!(null)),
            AppEvent::GitReviewPending { count } => {
                ("notebox:git-review-pending", json!({ "count": count }))
            }
            AppEvent::GitConsolidated { path: p } => {
                ("notebox:git-consolidated", json!({ "path": path(p) }))
            }
            AppEvent::GitPushStarted => ("notebox:git-push-started", json!(null)),
            AppEvent::GitPushCompleted => ("notebox:git-push-completed", json!(null)),
            AppEvent::GitCredentialNeeded { remote, transport } => (
                "notebox:git-credential-needed",
                json!({ "remote": remote, "transport": transport }),
            ),
            // The frontend receives the message itself as the payload.
            AppEvent::GitError { message } => ("notebox:git-error", json!(message)),
            AppEvent::DeepLink(delivery) => ("app:deep-link", json!(delivery)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_events_keep_their_frontend_shape() {
        let (name, payload) = AppEvent::FileChanged {
            path: PathBuf::from("/nb/a.typ"),
            change: ChangeKind::Content,
        }
        .frontend_form();
        assert_eq!(name, "notebox:file-changed");
        assert_eq!(payload, json!({ "path": "/nb/a.typ", "change": "Content" }));
    }

    #[test]
    fn index_updates_share_one_frontend_event() {
        let note = AppEvent::NoteIndexUpdated {
            path: PathBuf::from("/nb/a.typ"),
        };
        let rename = AppEvent::NoteRenameIndexed {
            from: PathBuf::from("/nb/a.typ"),
            to: PathBuf::from("/nb/b.typ"),
        };
        assert_eq!(note.frontend_form().0, "notebox:index-updated");
        assert_eq!(rename.frontend_form().0, "notebox:index-updated");
        assert_eq!(
            AppEvent::IndexesRebuiltFromDisk.frontend_form(),
            ("notebox:index-updated", json!({ "rebuilt": true }))
        );
    }

    #[test]
    fn git_error_payload_is_the_bare_message() {
        let (name, payload) = AppEvent::GitError {
            message: "offline".into(),
        }
        .frontend_form();
        assert_eq!(name, "notebox:git-error");
        assert_eq!(payload, json!("offline"));
    }
}
