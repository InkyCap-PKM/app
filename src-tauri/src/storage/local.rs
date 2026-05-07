use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::path::{canonicalize_root, validate_vault_path};
use super::traits::{FileTreeNode, VaultStorage};
use crate::errors::{InkyCapError, Result};
use crate::models::note::FileMetadata;

/// Filesystem-backed vault storage for local vaults.
///
/// All path arguments passed to this storage are validated against
/// `canonical_root` before any I/O. Paths that escape the vault via `..`,
/// symlinks, or absolute references outside the root are rejected with
/// [`InkyCapError::InvalidPath`]. This is the primary enforcement point for
/// the vault sandbox — callers should not bypass this type to perform
/// filesystem operations against vault content.
pub struct LocalVaultStorage {
    root: PathBuf,
    canonical_root: PathBuf,
}

impl LocalVaultStorage {
    /// Open a vault at `root`. Canonicalizes the root once up-front; fails if
    /// the directory does not exist or cannot be resolved.
    pub fn new(root: PathBuf) -> Result<Self> {
        let canonical_root = canonicalize_root(&root)?;
        Ok(Self {
            root,
            canonical_root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Canonical (symlink-resolved) vault root. Use when comparing paths
    /// against the vault boundary.
    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    /// Resolve a caller-supplied path to a canonical location inside the
    /// vault. Returns an error if the path escapes the vault.
    ///
    /// Public so adjacent subsystems (e.g. the Typst compile pipeline) can
    /// participate in the same vault-bound validation without duplicating the
    /// canonicalization logic. Callers that perform I/O should still prefer
    /// the [`VaultStorage`] trait methods, which validate internally.
    pub fn resolve_path(&self, path: &Path) -> Result<PathBuf> {
        validate_vault_path(&self.canonical_root, path)
    }

    fn resolve(&self, path: &Path) -> Result<PathBuf> {
        self.resolve_path(path)
    }
}

#[async_trait]
impl VaultStorage for LocalVaultStorage {
    async fn read_file(&self, path: &Path) -> Result<String> {
        let full = self.resolve(path)?;
        tokio::fs::read_to_string(&full)
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    InkyCapError::FileNotFound(full.display().to_string())
                } else {
                    InkyCapError::Io(e)
                }
            })
    }

    async fn list_files(&self, dir: &Path, pattern: &str) -> Result<Vec<PathBuf>> {
        let full_dir = self.resolve(dir)?;
        let ext = pattern.trim_start_matches("*.");
        let mut files = Vec::new();

        for entry in WalkDir::new(&full_dir)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                // Skip hidden dirs
                if e.file_type().is_dir() {
                    !name.starts_with('.') && name != "node_modules"
                } else {
                    true
                }
            })
        {
            let entry = entry.map_err(|e| {
                InkyCapError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
            })?;
            if entry.file_type().is_file() {
                if let Some(file_ext) = entry.path().extension() {
                    if file_ext == ext {
                        files.push(entry.into_path());
                    }
                }
            }
        }

        Ok(files)
    }

    async fn file_metadata(&self, path: &Path) -> Result<FileMetadata> {
        let full = self.resolve(path)?;
        let meta = tokio::fs::metadata(&full).await?;

        let name = full
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let folder = full
            .parent()
            .map(|p| {
                p.strip_prefix(&self.canonical_root)
                    .unwrap_or(p)
                    .display()
                    .to_string()
            })
            .unwrap_or_default();
        let ext = full
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default();
        let path_str = full
            .strip_prefix(&self.canonical_root)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| full.display().to_string());

        let ctime = meta
            .created()
            .ok()
            .and_then(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                Some(dt.to_rfc3339())
            });
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                Some(dt.to_rfc3339())
            });

        Ok(FileMetadata {
            name,
            folder,
            ext,
            path: path_str,
            ctime,
            mtime,
            size: meta.len(),
        })
    }

    async fn get_file_tree(&self) -> Result<Vec<FileTreeNode>> {
        let root = self.canonical_root.clone();
        tokio::task::spawn_blocking(move || build_file_tree(&root))
            .await
            .map_err(|e| InkyCapError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
    }

    async fn write_file(&self, path: &Path, content: &str) -> Result<()> {
        let full = self.resolve(path)?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full, content).await?;
        Ok(())
    }

    async fn delete_file(&self, path: &Path) -> Result<()> {
        let full = self.resolve(path)?;
        tokio::fs::remove_file(&full).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                InkyCapError::FileNotFound(full.display().to_string())
            } else {
                InkyCapError::Io(e)
            }
        })
    }

    async fn rename_file(&self, from: &Path, to: &Path) -> Result<()> {
        let full_from = self.resolve(from)?;
        let full_to = self.resolve(to)?;
        if let Some(parent) = full_to.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&full_from, &full_to).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                InkyCapError::FileNotFound(full_from.display().to_string())
            } else {
                InkyCapError::Io(e)
            }
        })
    }

    async fn exists(&self, path: &Path) -> bool {
        // An invalid / out-of-vault path "doesn't exist" from the caller's
        // perspective, so callers that are only probing for presence don't
        // leak information about the filesystem outside the vault.
        let Ok(full) = self.resolve(path) else {
            return false;
        };
        tokio::fs::try_exists(&full).await.unwrap_or(false)
    }

    async fn create_dir(&self, path: &Path) -> Result<()> {
        let full = self.resolve(path)?;
        tokio::fs::create_dir_all(&full).await?;
        Ok(())
    }

    async fn move_to_trash(&self, path: &Path) -> Result<()> {
        let full = self.resolve(path)?;
        // trash::delete is blocking, run on spawn_blocking
        let full_clone = full.clone();
        tokio::task::spawn_blocking(move || {
            trash::delete(&full_clone).map_err(|e| {
                InkyCapError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Trash error: {}", e),
                ))
            })
        })
        .await
        .map_err(|e| {
            InkyCapError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Join error: {}", e),
            ))
        })?
    }
}

/// Single-pass WalkDir traversal that builds the full directory tree.
fn build_file_tree(root: &Path) -> Result<Vec<FileTreeNode>> {
    let mut children_map: HashMap<PathBuf, Vec<FileTreeNode>> = HashMap::new();
    let mut dir_order: Vec<PathBuf> = Vec::new();

    let walker = WalkDir::new(root)
        .min_depth(1)
        .sort_by(|a, b| {
            let a_dir = a.file_type().is_dir();
            let b_dir = b.file_type().is_dir();
            b_dir.cmp(&a_dir).then_with(|| a.file_name().cmp(b.file_name()))
        })
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        });

    for entry in walker {
        let entry = entry.map_err(|e| {
            InkyCapError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
        })?;
        let parent = entry.path().parent().unwrap_or(root).to_path_buf();
        let is_dir = entry.file_type().is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.into_path();

        if is_dir {
            dir_order.push(path.clone());
            children_map.entry(path.clone()).or_default();
        }

        let node = FileTreeNode {
            name,
            path: path.display().to_string(),
            is_dir,
            children: if is_dir { Some(Vec::new()) } else { None },
        };

        children_map.entry(parent).or_default().push(node);
    }

    for dir_path in dir_order.into_iter().rev() {
        if let Some(kids) = children_map.remove(&dir_path) {
            let parent = dir_path.parent().unwrap_or(root).to_path_buf();
            if let Some(siblings) = children_map.get_mut(&parent) {
                if let Some(dir_node) = siblings.iter_mut().find(|n| n.path == dir_path.display().to_string()) {
                    dir_node.children = Some(kids);
                }
            }
        }
    }

    Ok(children_map.remove(&root.to_path_buf()).unwrap_or_default())
}
