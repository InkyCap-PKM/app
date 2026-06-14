use async_trait::async_trait;
use std::path::{Path, PathBuf};

use crate::errors::Result;
use crate::models::note::FileMetadata;

/// A node in the notebox's file/directory tree, returned by
/// [`NoteboxStorage::get_file_tree`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileTreeNode>>,
    /// Unix epoch seconds. Zero when the platform doesn't expose the
    /// stat field (rare) — frontend treats zero as "unknown" for sort.
    pub modified_time: u64,
    pub created_time: u64,
    /// The note's `#note(zid:)`, when present. The storage layer leaves this
    /// `None` (it does not parse note metadata); the `get_file_tree` command
    /// enriches it from the property index so the file tree can sort by zid.
    #[serde(default)]
    pub zid: Option<String>,
}

/// The sole interface for all file I/O in InkyCap.
/// All notebox access must go through this trait — never bypass it.
/// This prepares for future sync backends (cloud, encrypted noteboxes).
#[async_trait]
pub trait NoteboxStorage: Send + Sync {
    /// Read the full contents of a file as a UTF-8 string.
    async fn read_file(&self, path: &Path) -> Result<String>;

    /// List files matching a glob pattern under the given directory.
    async fn list_files(&self, dir: &Path, pattern: &str) -> Result<Vec<PathBuf>>;

    /// Get filesystem metadata for a file.
    async fn file_metadata(&self, path: &Path) -> Result<FileMetadata>;

    /// Build the full directory tree for the notebox root. Returns the
    /// top-level entries; directories carry nested children.
    async fn get_file_tree(&self) -> Result<Vec<FileTreeNode>>;

    /// Write content to a file, creating it if it doesn't exist.
    async fn write_file(&self, path: &Path, content: &str) -> Result<()>;

    /// Write raw bytes to a file (binary content such as attachments).
    /// Same atomicity guarantees as [`write_file`].
    async fn write_file_bytes(&self, path: &Path, content: &[u8]) -> Result<()>;

    /// Delete a file.
    async fn delete_file(&self, path: &Path) -> Result<()>;

    /// Rename/move a file. Both paths are relative to notebox root.
    async fn rename_file(&self, from: &Path, to: &Path) -> Result<()>;

    /// Check if a path exists.
    async fn exists(&self, path: &Path) -> bool;

    /// Create a directory (and all parent directories).
    async fn create_dir(&self, path: &Path) -> Result<()>;

    /// Move a file or directory to the system trash.
    async fn move_to_trash(&self, path: &Path) -> Result<()>;
}
