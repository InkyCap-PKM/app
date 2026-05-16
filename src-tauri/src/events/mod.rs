use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AppEvent {
    NoteboxOpened { path: PathBuf },
    FileChanged { path: PathBuf, change: ChangeKind },
    FileCreated { path: PathBuf },
    FileDeleted { path: PathBuf },
    /// Atomic rename observed by the watcher with both endpoints known
    /// (notify's `RenameMode::Both`). Carries paired paths so the index
    /// layer can rewrite wikilinks in referencing notes instead of
    /// orphaning them, which is what a split delete+create would do.
    FileRenamed { from: PathBuf, to: PathBuf },
    IndexRebuilt,
    CollectionUpdated { collection_path: PathBuf },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChangeKind {
    Content,
    Metadata,
}
