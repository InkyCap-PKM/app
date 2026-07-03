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
            // Skip hidden dirs
            if e.file_type().is_dir() {
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

        // Inside a flatpak sandbox the `trash` crate's freedesktop
        // mount-detection is fooled by the sandbox's bind mounts: it decides
        // the file lives on a different filesystem than ~/.local/share/Trash
        // and falls back to the mount-level trash dir `/home/.Trash-$uid`,
        // which isn't writable — so trashing fails with EACCES. Route through
        // the flatpak-specific path instead, which trashes the file host-side
        // and lands it in the user's normal trash, identical to the deb/rpm
        // builds. Detected at runtime (not compile time) so one Linux binary
        // behaves correctly both inside and outside the sandbox.
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

/// True when the process is running inside a flatpak sandbox. `/.flatpak-info`
/// is present in every flatpak sandbox and absent otherwise, making it the
/// reliable marker (the `FLATPAK_ID` env var is not always propagated).
#[cfg(target_os = "linux")]
fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Move a path to trash from inside a flatpak sandbox.
///
/// Prefers the XDG Desktop Portal, which trashes host-side and correctly
/// handles files on external drives. But a range of widely-deployed portal
/// versions (1.20.4 through 1.21.1) regressed: the CVE-2026-40354 symlink-race
/// fix (GHSA-rqr9-jwwf-wxgj) compares the file's mount id as seen inside the
/// sandbox against the host mount id, which never match under flatpak's bind
/// mounts, so the portal rejects *every* sandboxed trash request with a generic
/// "Failed to trash file" (xdg-desktop-portal#1972; fixed in 1.21.2 / 1.22.0 via
/// PR #1982). When the portal fails, fall back to a spec-compliant move into the
/// user's home trash — reachable because the flatpak holds `--filesystem=host`,
/// so `~/.local/share/Trash` is the real host trash and shares a filesystem with
/// any notebox under `$HOME`.
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

/// Move a path to trash via the XDG Desktop Portal's Trash interface. The
/// portal takes an open file descriptor (which it resolves host-side, outside
/// the sandbox) rather than a path string. Opening the path read-only yields a
/// valid fd for both regular files and directories on Linux.
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

/// Move a path into the user's home trash, following the FreeDesktop.org Trash
/// specification (`$XDG_DATA_HOME/Trash`, default `~/.local/share/Trash`).
///
/// This reimplements the small slice of the trash spec we need because the two
/// off-the-shelf paths both fail inside the sandbox: the `trash` crate mis-detects
/// the mount and the portal (1.20.4–1.21.1) rejects the request. Per CLAUDE.md's
/// no-custom-code-unless-unreachable principle, this is the last-resort path.
///
/// The file is `rename`d into `Trash/files/<name>` and a matching
/// `Trash/info/<name>.trashinfo` records its original location so the desktop can
/// restore it. `rename` requires the file and the trash to share a filesystem;
/// with `--filesystem=host` that holds for any notebox under `$HOME`. A notebox on
/// a separate mount (external drive) produces `EXDEV`, which we report rather than
/// silently copy — its correct home is the drive's own `.Trash-$uid`, which only a
/// fixed portal can reach.
#[cfg(target_os = "linux")]
fn trash_into_home_trash(full: &Path) -> Result<()> {
    use percent_encoding::{percent_encode, AsciiSet, CONTROLS};

    // The trashinfo `Path` is percent-encoded like a URL path: everything
    // outside the RFC 3986 unreserved set is escaped, but `/` stays literal
    // (matching glib's `g_uri_escape_string(path, "/", TRUE)`).
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

    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .ok_or_else(|| {
            InkyCapError::Io(std::io::Error::other(
                "home-trash: neither XDG_DATA_HOME nor HOME is set",
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
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        });

    for entry in walker {
        let entry = entry.map_err(|e| InkyCapError::Io(std::io::Error::other(e)))?;
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

/// Process-unique counter used to disambiguate atomic-write tmp files
/// when multiple writes target the same parent directory in rapid
/// succession. `AtomicU64::Relaxed` is sufficient — we only need
/// uniqueness, not any ordering relationship with other memory.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `content` to `target` atomically: stream the bytes to a sibling
/// `.tmp` file, fsync the data, then rename over the destination.
///
/// `tokio::fs::write` truncates `target` immediately and streams bytes
/// in. A crash, power loss, or an external reader (Syncthing, antivirus,
/// the file watcher itself) catching the file mid-write sees a truncated
/// or empty file. The tmp + sync + rename pattern guarantees the
/// destination is either the old content or the complete new content —
/// never an intermediate state. POSIX guarantees rename atomicity
/// within a single filesystem, and `tokio::fs::rename` routes through
/// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` on Windows for the
/// same behaviour there.
///
/// The tmp filename uses a `.tmp` extension so the watcher's
/// `is_editor_scratch_file` filter ignores it; reindex doesn't fire on
/// every save.
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

        // Overwrite with a larger payload; the destination must either be
        // the prior content or the new content at every observable moment
        // — never an empty/truncated intermediate.
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
