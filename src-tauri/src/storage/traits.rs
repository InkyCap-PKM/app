use async_trait::async_trait;
use std::path::{Path, PathBuf};

use crate::errors::Result;
use crate::models::note::FileMetadata;

/// A node in the vault's file/directory tree, returned by
/// [`VaultStorage::get_file_tree`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileTreeNode>>,
}

/// The sole interface for all file I/O in InkyCap.
/// All vault access must go through this trait — never bypass it.
/// This prepares for future sync backends (cloud, encrypted vaults).
#[async_trait]
pub trait VaultStorage: Send + Sync {
    /// Read the full contents of a file as a UTF-8 string.
    async fn read_file(&self, path: &Path) -> Result<String>;

    /// List files matching a glob pattern under the given directory.
    async fn list_files(&self, dir: &Path, pattern: &str) -> Result<Vec<PathBuf>>;

    /// Get filesystem metadata for a file.
    async fn file_metadata(&self, path: &Path) -> Result<FileMetadata>;

    /// Build the full directory tree for the vault root. Returns the
    /// top-level entries; directories carry nested children.
    async fn get_file_tree(&self) -> Result<Vec<FileTreeNode>>;

    /// Write content to a file, creating it if it doesn't exist.
    async fn write_file(&self, path: &Path, content: &str) -> Result<()>;

    /// Delete a file.
    async fn delete_file(&self, path: &Path) -> Result<()>;

    /// Rename/move a file. Both paths are relative to vault root.
    async fn rename_file(&self, from: &Path, to: &Path) -> Result<()>;

    /// Check if a path exists.
    async fn exists(&self, path: &Path) -> bool;

    /// Create a directory (and all parent directories).
    async fn create_dir(&self, path: &Path) -> Result<()>;

    /// Move a file or directory to the system trash.
    async fn move_to_trash(&self, path: &Path) -> Result<()>;
}
