use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::path::{canonicalize_root, to_frontend_string, validate_notebox_path};
use super::traits::{FileTreeNode, NoteboxStorage};
use crate::errors::{InkyCapError, Result};
use crate::models::note::FileMetadata;

/// Filesystem-backed notebox storage for local noteboxes.
///
/// All path arguments passed to this storage are validated against
/// `canonical_root` before any I/O. Paths that escape the notebox via `..`,
/// symlinks, or absolute references outside the root are rejected with
/// [`InkyCapError::InvalidPath`]. This is the primary enforcement point for
/// the notebox sandbox — callers should not bypass this type to perform
/// filesystem operations against notebox content.
pub struct LocalNoteboxStorage {
    root: PathBuf,
    canonical_root: PathBuf,
}

impl LocalNoteboxStorage {
    /// Open a notebox at `root`. Canonicalizes the root once up-front; fails if
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

    /// Canonical (symlink-resolved) notebox root. Use when comparing paths
    /// against the notebox boundary.
    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    /// Resolve a caller-supplied path to a canonical location inside the
    /// notebox. Returns an error if the path escapes the notebox.
    ///
    /// Public so adjacent subsystems (e.g. the Typst compile pipeline) can
    /// participate in the same notebox-bound validation without duplicating the
    /// canonicalization logic. Callers that perform I/O should still prefer
    /// the [`NoteboxStorage`] trait methods, which validate internally.
    pub fn resolve_path(&self, path: &Path) -> Result<PathBuf> {
        validate_notebox_path(&self.canonical_root, path)
    }

    fn resolve(&self, path: &Path) -> Result<PathBuf> {
        self.resolve_path(path)
    }
}

#[async_trait]
impl NoteboxStorage for LocalNoteboxStorage {
    async fn read_file(&self, path: &Path) -> Result<String> {
        let full = self.resolve(path)?;
        tokio::fs::read_to_string(&full)
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    InkyCapError::FileNotFound(full.display().to_string()) // path-stringification-ok: error message, not IPC
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
                let rel = p.strip_prefix(&self.canonical_root).unwrap_or(p);
                to_frontend_string(rel)
            })
            .unwrap_or_default();
        let ext = full
            .extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_default();
        let path_str = full
            .strip_prefix(&self.canonical_root)
            .map(|p| to_frontend_string(p))
            .unwrap_or_else(|_| to_frontend_string(&full));

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
                InkyCapError::FileNotFound(full.display().to_string()) // path-stringification-ok: error message, not IPC
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
                InkyCapError::FileNotFound(full_from.display().to_string()) // path-stringification-ok: error message, not IPC
            } else {
                InkyCapError::Io(e)
            }
        })
    }

    async fn exists(&self, path: &Path) -> bool {
        // An invalid / out-of-notebox path "doesn't exist" from the caller's
        // perspective, so callers that are only probing for presence don't
        // leak information about the filesystem outside the notebox.
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
        // Read stat times before consuming `entry`. WalkDir caches the
        // metadata so this doesn't trigger an extra syscall. Either time
        // is allowed to fail (some platforms / filesystems don't track
        // creation time); fall back to zero so the frontend can treat it
        // as unknown.
        let (modified_time, created_time) = match entry.metadata() {
            Ok(m) => (
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                m.created()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            ),
            Err(_) => (0, 0),
        };
        let path = entry.into_path();

        if is_dir {
            dir_order.push(path.clone());
            children_map.entry(path.clone()).or_default();
        }

        let node = FileTreeNode {
            name,
            path: to_frontend_string(&path),
            is_dir,
            children: if is_dir { Some(Vec::new()) } else { None },
            modified_time,
            created_time,
        };

        children_map.entry(parent).or_default().push(node);
    }

    for dir_path in dir_order.into_iter().rev() {
        if let Some(kids) = children_map.remove(&dir_path) {
            let parent = dir_path.parent().unwrap_or(root).to_path_buf();
            if let Some(siblings) = children_map.get_mut(&parent) {
                let dir_path_str = to_frontend_string(&dir_path);
                if let Some(dir_node) = siblings.iter_mut().find(|n| n.path == dir_path_str) {
                    dir_node.children = Some(kids);
                }
            }
        }
    }

    Ok(children_map.remove(&root.to_path_buf()).unwrap_or_default())
}
