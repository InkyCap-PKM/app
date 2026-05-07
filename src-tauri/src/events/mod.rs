use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AppEvent {
    VaultOpened { path: PathBuf },
    FileChanged { path: PathBuf, change: ChangeKind },
    FileCreated { path: PathBuf },
    FileDeleted { path: PathBuf },
    IndexRebuilt,
    CollectionUpdated { collection_path: PathBuf },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChangeKind {
    Content,
    Metadata,
}
