use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AppEvent {
    NoteboxOpened {
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
    IndexRebuilt,
    CollectionUpdated {
        collection_path: PathBuf,
    },

    // --- Notebox-level git collaboration (see `crate::git`) ---
    // The collaboration loop never blocks on a command for credentials;
    // when fetch/push need a credential the backend doesn't have, it raises
    // `GitCredentialNeeded` and the frontend prompts. The fetch/consolidate/
    // push lifecycle reports progress through the remaining variants.
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChangeKind {
    Content,
    Metadata,
}
