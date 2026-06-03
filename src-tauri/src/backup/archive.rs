//! Build a zip archive from a notebox root (and optionally the user-global
//! config folder). Uses the `zip` crate's AES-256 mode when a password is
//! supplied — see CLAUDE.md and the planning thread for why ZIP+AES-256
//! over 7z / tar.gz.
//!
//! Path handling notes (per CLAUDE.md's Windows guidance):
//!
//!   - **Inside the archive**, all entries use forward slashes — that's
//!     the zip spec convention and lets the archive round-trip cleanly
//!     across OSes.
//!   - **Outside**, callers pass `PathBuf` (`std::path::Path`) so the
//!     OS-native separator is preserved for filesystem I/O.
//!   - **Symlinks are followed**, not stored as link entries — Windows
//!     can't recreate them on restore in the general case, and a
//!     followed-link archive extracts identically everywhere.
//!   - **`.git/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`** are skipped —
//!     `.git/` because it's large and recoverable from the remote, the
//!     OS files because they're machine-local cruft.
//!   - **`.inkycap/git/`** is skipped — once the git-collaboration
//!     feature ships, this is where the per-collection mirror worktrees
//!     live. They're recoverable by re-fetching from the configured
//!     remotes, and including them would balloon every backup with a
//!     full duplicate of the working notebox. The rest of `.inkycap/`
//!     is intentionally *not* excluded — it holds user-authored content
//!     (templates, scaffolds, settings) that belongs in the archive.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use walkdir::WalkDir;

use crate::errors::{InkyCapError, Result};
use crate::storage::zip_archive::ZipBuilder;

/// Inputs for one archive build.
pub struct ArchiveJob<'a> {
    /// Absolute path to the notebox root. Every file under this folder
    /// (minus excludes) is added to the archive at the prefix
    /// `notebox/`. The notebox name (filename of the root) is *not* in
    /// the interior path — the archive is "this is a notebox", and the
    /// filename on disk carries the identity via the configured pattern.
    pub notebox_root: &'a Path,
    /// Path the archive will be written to. Caller is responsible for
    /// pre-creating the destination folder.
    pub destination: &'a Path,
    /// Optional path to the user-global config folder (typically
    /// `~/.config/inkycap/`). When `Some`, its contents are added at
    /// the prefix `user-config/`. `backup_state.json` is excluded
    /// inside (circular self-reference).
    pub user_config_root: Option<&'a Path>,
    /// AES-256 password. `None` produces an unencrypted archive.
    pub password: Option<&'a str>,
    /// Cooperative cancellation flag. Polled before each new file
    /// entry and between 64KiB chunks within a large file, so a
    /// cancel request on a multi-gigabyte attachment doesn't have to
    /// wait until the next file boundary.
    pub cancel: Arc<AtomicBool>,
}

/// One entry added to the archive. Exposed for diagnostics / future
/// progress reporting; the public `write` returns the count + total
/// bytes for the settings UI's "Last backup: 1.2 MB" line.
#[derive(Debug, Default)]
pub struct ArchiveSummary {
    pub file_count: u64,
    pub uncompressed_bytes: u64,
}

/// Path components that we never include in the archive — applies to
/// any segment of any path, not just the leaf. `.git/` is excluded
/// here both because of the directory itself and any nested `.git`
/// folders under submodules.
const DIRECTORY_EXCLUDES: &[&str] = &[".git"];

/// Pairs of consecutive path components that, when found adjacent in
/// the path, mark the subtree for exclusion. Used when a single
/// segment name would be too broad — e.g. excluding `.inkycap/git/`
/// (the per-collection git mirror worktrees) without excluding the
/// rest of `.inkycap/`, which holds user content like templates and
/// scaffolds. Match order is `(parent, child)` and is detected by
/// scanning adjacent components anywhere in the path.
const DIRECTORY_PAIR_EXCLUDES: &[(&str, &str)] = &[(".inkycap", "git")];

/// Leaf filenames that we never include. OS-specific cruft that bloats
/// every backup without carrying any user-meaningful state.
const FILE_EXCLUDES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// Build one archive. Returns a summary describing what made it in;
/// errors bubble up through `Result` and surface to the UI verbatim.
pub fn write(job: ArchiveJob<'_>) -> Result<ArchiveSummary> {
    if !job.notebox_root.is_dir() {
        return Err(InkyCapError::InvalidPath(format!(
            "notebox root is not a directory: {}",
            job.notebox_root.display()
        )));
    }

    // Refuse to write the archive into the very tree we're archiving —
    // recursive backup-inside-notebox would either blow up the archive
    // (it would try to read the file currently being written) or
    // succeed with garbled contents. Cheap to detect; spare the user.
    let dest_canonical = job
        .destination
        .parent()
        .and_then(|p| std::fs::canonicalize(p).ok());
    let notebox_canonical = std::fs::canonicalize(job.notebox_root).ok();
    if let (Some(d), Some(n)) = (&dest_canonical, &notebox_canonical) {
        if d.starts_with(n) {
            return Err(InkyCapError::BadRequest(
                "Backup destination must be outside the notebox folder \
                 (otherwise the backup would try to archive itself)."
                    .to_string(),
            ));
        }
    }

    let mut builder = ZipBuilder::create(job.destination, job.password.map(str::to_owned))?;

    let mut summary = ArchiveSummary::default();

    add_tree(
        &mut builder,
        job.notebox_root,
        "notebox",
        None, // no per-tree extra exclusion
        &mut summary,
        &job.cancel,
    )?;

    if let Some(cfg) = job.user_config_root {
        // Skip backup_state.json inside the user-config snapshot so the
        // archive's own "last_success" record doesn't end up inside the
        // archive (a confusing artefact at restore time).
        add_tree(
            &mut builder,
            cfg,
            "user-config",
            Some("backup_state.json"),
            &mut summary,
            &job.cancel,
        )?;
    }

    builder.finish()?;

    Ok(summary)
}

/// Walk one source tree, adding each file to the archive under `prefix/`.
/// Directory entries are written for empty folders only — populated
/// folders are implied by their files' paths, which is how most zip
/// extractors expect things. The per-entry mechanics (AES, chunked
/// streaming, cancellation) live in [`ZipBuilder`]; this function owns
/// the tree walk, exclusion rules, and interior-path construction.
fn add_tree(
    builder: &mut ZipBuilder,
    src: &Path,
    prefix: &str,
    extra_leaf_exclude: Option<&str>,
    summary: &mut ArchiveSummary,
    cancel: &Arc<AtomicBool>,
) -> Result<()> {
    // follow_links(true): per CLAUDE.md/our planning thread, symlinks
    // are stored as their target contents rather than as link entries.
    // Keeps the archive portable to Windows where symlink restoration
    // is second-class.
    let walker = WalkDir::new(src).follow_links(true).into_iter();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            // Don't fail the whole archive on one bad file — log and
            // skip. A common cause is a file the OS held a lock on
            // (anti-virus, indexer), and the right behaviour is to
            // carry on with the rest of the notebox.
            Err(e) => {
                log::warn!("backup walker skipping entry: {e}");
                continue;
            }
        };

        if should_skip(&entry, extra_leaf_exclude) {
            continue;
        }

        let abs = entry.path();
        let rel = abs.strip_prefix(src).unwrap_or(abs);

        // Inside-zip path uses forward slashes regardless of host OS.
        let mut interior = String::with_capacity(prefix.len() + 1 + rel.as_os_str().len());
        interior.push_str(prefix);
        for component in rel.components() {
            interior.push('/');
            // Use OsStr lossy conversion; the archive metadata
            // is best-effort UTF-8 anyway, and the zip spec
            // doesn't carry per-component encoding intent.
            interior.push_str(&component.as_os_str().to_string_lossy());
        }

        if entry.file_type().is_dir() {
            // We only emit explicit directory entries for empty
            // folders; non-empty ones are implied by their files.
            if std::fs::read_dir(abs)
                .map(|mut it| it.next().is_none())
                .unwrap_or(false)
            {
                builder.add_directory(&interior)?;
            }
            continue;
        }

        if !entry.file_type().is_file() {
            // Skip sockets, fifos, character devices, etc. — they
            // can't meaningfully round-trip through a zip.
            continue;
        }

        // ZipBuilder polls `cancel` before the file and between chunks.
        let bytes = builder.add_file(&interior, abs, Some(cancel))?;
        summary.uncompressed_bytes += bytes;
        summary.file_count += 1;
    }

    Ok(())
}

/// Apply the exclusion rules. Walks the path components so a
/// `.git/` anywhere in the tree is caught, not just at the root.
fn should_skip(entry: &walkdir::DirEntry, extra_leaf_exclude: Option<&str>) -> bool {
    let components: Vec<String> = entry
        .path()
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();

    for s in &components {
        if DIRECTORY_EXCLUDES.iter().any(|x| s == *x) {
            return true;
        }
    }

    for window in components.windows(2) {
        if let [parent, child] = window {
            if DIRECTORY_PAIR_EXCLUDES
                .iter()
                .any(|(p, c)| parent == *p && child == *c)
            {
                return true;
            }
        }
    }

    let name = entry.file_name().to_string_lossy();
    if FILE_EXCLUDES.iter().any(|x| name == *x) {
        return true;
    }

    if let Some(extra) = extra_leaf_exclude {
        if name == extra {
            return true;
        }
    }

    false
}

/// List archive files in `dir` whose names match `pattern`, sorted by
/// modified time descending (newest first). Used by retention pruning.
pub fn list_matching_archives(dir: &Path, pattern: &str) -> Result<Vec<PathBuf>> {
    let mut out: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        // Missing destination folder is not a programmer error — it's
        // a normal pre-first-run state. Return an empty list and let
        // the runner create the folder if needed.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !super::filename::matches_pattern(pattern, &name) {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        out.push((mtime, entry.path()));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, p)| p).collect())
}
