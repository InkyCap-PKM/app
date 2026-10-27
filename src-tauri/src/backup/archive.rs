//! Build a zip archive of a notebox (and optionally the user config folder),
//! using AES-256 when a password is given.
//!
//! - Entries use forward slashes (the zip convention), so archives work across
//!   OSes; callers pass native `PathBuf`s.
//! - Symlinks are followed and stored as content, since Windows can't generally
//!   recreate them.
//! - `.git/`, `.DS_Store`, `Thumbs.db` and `desktop.ini` are skipped: `.git/`
//!   is large and recoverable from the remote, the others are machine-local.
//! - `.inkycap/git/` (git mirror worktrees, recoverable by fetching) is
//!   skipped; the rest of `.inkycap/` (templates, scaffolds, settings) is
//!   included.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use walkdir::WalkDir;

use crate::errors::{InkyCapError, Result};
use crate::storage::zip_archive::ZipBuilder;

/// Inputs for one archive build.
pub struct ArchiveJob<'a> {
    /// The notebox root. Its files (minus exclusions) go under `notebox/`. The
    /// notebox's own name isn't in the path; the archive's file name carries
    /// it.
    pub notebox_root: &'a Path,
    /// Path the archive will be written to. Caller is responsible for
    /// pre-creating the destination folder.
    pub destination: &'a Path,
    /// The user config folder (usually `~/.config/inkycap/`), added under
    /// `user-config/`, without `backup_state.json`.
    pub user_config_root: Option<&'a Path>,
    /// AES-256 password. `None` produces an unencrypted archive.
    pub password: Option<&'a str>,
    /// Cancel flag, checked before each file and between 64KiB chunks, so a
    /// large file doesn't delay cancelling.
    pub cancel: Arc<AtomicBool>,
}

/// One entry added to the archive. `write` returns the count and total size for
/// Settings' "Last backup" line.
#[derive(Debug, Default)]
pub struct ArchiveSummary {
    pub file_count: u64,
    pub uncompressed_bytes: u64,
}

/// Path components never included, anywhere in a path (so nested `.git` folders
/// too).
const DIRECTORY_EXCLUDES: &[&str] = &[".git"];

/// Adjacent `(parent, child)` components that exclude a subtree, where one name
/// alone would be too broad: `.inkycap/git/` without the rest of `.inkycap/`.
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

    // Refuse to write the archive inside the folder being archived.
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
        // Leave `backup_state.json` out of the config snapshot, so the archive
        // doesn't contain its own "last success" record.
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

/// Add one folder's files under `prefix/`, with entries only for empty folders
/// (others are implied by their files). The per-entry work (AES, chunked
/// streaming, cancelling) is in [`ZipBuilder`]; this does the walk, exclusions
/// and entry paths.
fn add_tree(
    builder: &mut ZipBuilder,
    src: &Path,
    prefix: &str,
    extra_leaf_exclude: Option<&str>,
    summary: &mut ArchiveSummary,
    cancel: &Arc<AtomicBool>,
) -> Result<()> {
    // Store symlinks' target contents, so the archive restores on Windows.
    let walker = WalkDir::new(src).follow_links(true).into_iter();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            // Log and skip a file that can't be read (often locked by antivirus
            // or an indexer) rather than failing the whole archive.
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
            // Lossy conversion; zip names are UTF-8 at best.
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
        // A missing folder is normal before the first backup: return nothing.
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
    out.sort_by_key(|b| std::cmp::Reverse(b.0));
    Ok(out.into_iter().map(|(_, p)| p).collect())
}
