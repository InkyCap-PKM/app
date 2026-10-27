use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::AsyncWriteExt;
use walkdir::WalkDir;

use super::path::{canonicalize_root, to_frontend_string, validate_notebox_path};
use super::traits::{FileTreeNode, NoteboxStorage};
use crate::errors::{InkyCapError, Result};
use crate::models::note::FileMetadata;

/// File storage for a local notebox. Every path is validated against
/// `canonical_root` before any I/O; paths that leave the notebox (through `..`,
/// symlinks or outside absolute paths) fail with [`InkyCapError::InvalidPath`].
/// This is the main enforcement of the notebox sandbox, so don't bypass it for
/// notebox content.
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

    /// Resolve a path to its canonical location inside the notebox, or fail if
    /// it leaves it. Public so other subsystems (e.g. the compiler) can use the
    /// same check; for I/O, prefer the [`NoteboxStorage`] methods, which check
    /// internally.
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
        tokio::fs::read_to_string(&full).await.map_err(|e| {
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

        for entry in WalkDir::new(&full_dir).into_iter().filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // Skip hidden dirs below the starting folder (which is itself
            // allowed to have a hidden name).
            if e.file_type().is_dir() && e.depth() > 0 {
                !name.starts_with('.') && name != "node_modules"
            } else {
                true
            }
        }) {
            let entry = entry.map_err(|e| InkyCapError::Io(std::io::Error::other(e)))?;
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
            .map(to_frontend_string)
            .unwrap_or_else(|_| to_frontend_string(&full));

        let ctime = meta.created().ok().map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        });
        let mtime = meta.modified().ok().map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
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
            .map_err(|e| InkyCapError::Io(std::io::Error::other(e)))?
    }

    async fn write_file(&self, path: &Path, content: &str) -> Result<()> {
        let full = self.resolve(path)?;
        atomic_write(&full, content.as_bytes()).await?;
        Ok(())
    }

    async fn write_file_bytes(&self, path: &Path, content: &[u8]) -> Result<()> {
        let full = self.resolve(path)?;
        atomic_write(&full, content).await?;
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
        // A path outside the notebox simply doesn't exist, so probes reveal
        // nothing about the rest of the filesystem.
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

        // In a flatpak sandbox, the `trash` crate's mount detection is confused
        // by bind mounts and tries the unwritable `/home/.Trash-$uid`. Use the
        // flatpak path instead, which ends up in the user's normal trash.
        // Checked at runtime, so one binary works in and out of the sandbox.
        #[cfg(target_os = "linux")]
        if is_flatpak() {
            return trash_in_flatpak(&full).await;
        }

        // trash::delete is blocking, run on spawn_blocking
        let full_clone = full.clone();
        tokio::task::spawn_blocking(move || {
            trash::delete(&full_clone)
                .map_err(|e| InkyCapError::Io(std::io::Error::other(format!("Trash error: {}", e))))
        })
        .await
        .map_err(|e| InkyCapError::Io(std::io::Error::other(format!("Join error: {}", e))))?
    }
}

/// True inside a flatpak sandbox: `/.flatpak-info` exists there (`FLATPAK_ID`
/// isn't always set).
#[cfg(target_os = "linux")]
fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Move a path to the trash from inside a flatpak sandbox.
///
/// Tries the XDG Desktop Portal first, which handles external drives. Portal
/// versions 1.20.4 to 1.21.1 reject every sandboxed request with "Failed to
/// trash file" (a mount-id check that never matches under flatpak;
/// xdg-desktop-portal#1972, PR #1982), and 1.22.1 has been seen failing the same
/// way. Then fall back to moving the file into the home trash, which is the real
/// host trash because the flatpak has `--filesystem=home`.
#[cfg(target_os = "linux")]
async fn trash_in_flatpak(full: &Path) -> Result<()> {
    match trash_via_portal(full).await {
        Ok(()) => Ok(()),
        Err(portal_err) => trash_into_home_trash(full).map_err(|home_err| {
            // Surface both causes: the portal failure explains why we fell back,
            // the home-trash failure explains why the fallback couldn't recover.
            InkyCapError::Io(std::io::Error::other(format!(
                "portal trash failed ({portal_err}); home-trash fallback also failed ({home_err})"
            )))
        }),
    }
}

/// Trash a path through the portal, which takes a file descriptor (resolved
/// host-side) rather than a path. A read-only open works for files and folders.
#[cfg(target_os = "linux")]
async fn trash_via_portal(full: &Path) -> Result<()> {
    use std::os::fd::AsFd;
    let file = std::fs::File::open(full).map_err(|e| {
        InkyCapError::Io(std::io::Error::other(format!(
            "Trash error: opening {}: {e}",
            full.display() // path-stringification-ok: subprocess/portal error message, not IPC
        )))
    })?;
    ashpd::desktop::trash::trash_file(&file.as_fd())
        .await
        .map_err(|e| InkyCapError::Io(std::io::Error::other(format!("Trash error: {e}"))))
}

/// Move a path into the home trash (`$XDG_DATA_HOME/Trash`, default
/// `~/.local/share/Trash`) per the FreeDesktop.org spec. Only used in the flatpak
/// sandbox, where the `trash` crate and the portal both fail. Per CLAUDE.md's
/// Typst-first principle, this is the last-resort path.
///
/// The file is renamed to `Trash/files/<name>` with a
/// `Trash/info/<name>.trashinfo` recording where it came from. `rename` needs one
/// filesystem, which holds for noteboxes under `$HOME`; on another drive it fails
/// with `EXDEV`, which is reported rather than copying, since that file belongs in
/// the drive's own trash.
#[cfg(target_os = "linux")]
fn trash_into_home_trash(full: &Path) -> Result<()> {
    use percent_encoding::{percent_encode, AsciiSet, CONTROLS};

    // The trashinfo `Path` is percent-encoded like a URL path: everything
    // outside the RFC 3986 unreserved set except `/` (as glib's
    // `g_uri_escape_string(path, "/", TRUE)`).
    const TRASH_PATH: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'[')
        .add(b'\\')
        .add(b']')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}');

    let io_err = |ctx: &str, e: std::io::Error| {
        // path-stringification-ok: portal/trash error message, not IPC.
        InkyCapError::Io(std::io::Error::other(format!("home-trash: {ctx}: {e}")))
    };

    // Inside flatpak, `XDG_DATA_HOME` is the app's private data folder (a
    // separate mount, and not the desktop's trash). The host's value, if set,
    // is in `HOST_XDG_DATA_HOME`.
    let data_home = std::env::var_os("HOST_XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .ok_or_else(|| {
            InkyCapError::Io(std::io::Error::other(
                "home-trash: neither HOST_XDG_DATA_HOME nor HOME is set",
            ))
        })?;

    let trash = data_home.join("Trash");
    let files_dir = trash.join("files");
    let info_dir = trash.join("info");
    std::fs::create_dir_all(&files_dir).map_err(|e| io_err("creating Trash/files", e))?;
    std::fs::create_dir_all(&info_dir).map_err(|e| io_err("creating Trash/info", e))?;

    let base = full.file_name().ok_or_else(|| {
        InkyCapError::Io(std::io::Error::other("home-trash: path has no filename"))
    })?;

    // Reserve a unique name across both files/ and info/, disambiguating
    // collisions with a numeric suffix as the spec prescribes.
    let mut name = base.to_os_string();
    let mut counter = 1u32;
    loop {
        let dest = files_dir.join(&name);
        let info = info_dir.join(format!("{}.trashinfo", name.to_string_lossy()));
        if !dest.exists() && !info.exists() {
            break;
        }
        let mut candidate = base.to_os_string();
        candidate.push(format!(".{counter}"));
        name = candidate;
        counter += 1;
    }

    // Write the info file *before* moving, so a restorer never sees an
    // orphaned file with no recorded origin.
    let encoded = percent_encode(full.as_os_str().as_encoded_bytes(), TRASH_PATH);
    let deletion_date = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S");
    let info_contents = format!("[Trash Info]\nPath={encoded}\nDeletionDate={deletion_date}\n");
    let info_path = info_dir.join(format!("{}.trashinfo", name.to_string_lossy()));
    std::fs::write(&info_path, info_contents).map_err(|e| io_err("writing trashinfo", e))?;

    let dest = files_dir.join(&name);
    if let Err(e) = std::fs::rename(full, &dest) {
        // Roll back the info file so it doesn't dangle.
        let _ = std::fs::remove_file(&info_path);
        return Err(io_err("moving file into Trash/files", e));
    }
    Ok(())
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
            b_dir
                .cmp(&a_dir)
                .then_with(|| a.file_name().cmp(b.file_name()))
        })
        .into_iter()
        .filter_entry(|e| {
            // The notebox root itself may have a hidden name; skip hidden
            // entries below it.
            let name = e.file_name().to_string_lossy();
            e.depth() == 0 || (!name.starts_with('.') && name != "node_modules")
        });

    for entry in walker {
        let entry = entry.map_err(|e| InkyCapError::Io(std::io::Error::other(e)))?;
        let parent = entry.path().parent().unwrap_or(root).to_path_buf();
        let is_dir = entry.file_type().is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        // Read the times before consuming `entry` (WalkDir caches the
        // metadata). Either may be unavailable; zero means unknown.
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
            // The storage layer doesn't parse note metadata; the
            // `get_file_tree` command fills zid from the property index.
            zid: None,
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

/// Counter making atomic-write temp file names unique. Relaxed ordering is
/// enough.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `content` to `target` atomically: write a sibling `.tmp` file, fsync
/// it, then rename it over the target. A plain write truncates first, so a
/// crash or a reader (Syncthing, antivirus, the watcher) could see an empty or
/// partial file; with the rename the target is always the old or the complete
/// new content (rename is atomic on POSIX, and `tokio::fs::rename` replaces
/// atomically on Windows).
///
/// The watcher ignores `.tmp` files; the rename is reported as a created file,
/// so the note is reindexed and editors get `notebox:file-created` after each
/// save.
async fn atomic_write(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "atomic_write: target has no parent directory",
        )
    })?;
    tokio::fs::create_dir_all(parent).await?;

    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("write");
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let tmp_name = format!(".{file_name}.{pid}.{counter}.inkycap.tmp");
    let tmp_path = parent.join(&tmp_name);

    let result = async {
        let mut f = tokio::fs::File::create(&tmp_path).await?;
        f.write_all(content).await?;
        f.sync_data().await?;
        // Drop the handle before rename — on Windows the rename can
        // otherwise fail with a sharing-violation error.
        drop(f);
        tokio::fs::rename(&tmp_path, target).await
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn write_file_persists_content_and_leaves_no_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let storage = LocalNoteboxStorage::new(dir.path().to_path_buf()).unwrap();
        let rel = Path::new("note.typ");

        storage.write_file(rel, "hello world").await.unwrap();
        assert_eq!(storage.read_file(rel).await.unwrap(), "hello world");

        // No stray .tmp siblings after a successful write.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s == "tmp")
                    .unwrap_or(false)
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic_write left {} stray tmp file(s)",
            leftovers.len()
        );
    }

    #[tokio::test]
    async fn overwrite_preserves_existing_until_rename() {
        let dir = tempfile::tempdir().unwrap();
        let storage = LocalNoteboxStorage::new(dir.path().to_path_buf()).unwrap();
        let rel = Path::new("note.typ");

        storage.write_file(rel, "v1").await.unwrap();
        assert_eq!(storage.read_file(rel).await.unwrap(), "v1");

        // The target must hold the old or new content at every moment, never a
        // partial file.
        let big = "v2".repeat(50_000);
        storage.write_file(rel, &big).await.unwrap();
        assert_eq!(storage.read_file(rel).await.unwrap(), big);
    }

    #[tokio::test]
    async fn write_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let storage = LocalNoteboxStorage::new(dir.path().to_path_buf()).unwrap();
        let rel = Path::new("nested/sub/note.typ");

        storage.write_file(rel, "deep").await.unwrap();
        assert_eq!(storage.read_file(rel).await.unwrap(), "deep");
    }
}
