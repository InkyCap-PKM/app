//! Read-side operations on existing backup archives:
//!
//!   - `list_archives` — enumerate archives in the destination folder.
//!   - `list_contents`  — open one archive and return its entries.
//!   - `extract_files`  — pull selected entries back onto the filesystem,
//!                        with deterministic conflict handling.
//!
//! Encryption-aware: when an archive is AES-encrypted, the caller passes
//! the password (typically fetched from the OS keychain) and we route
//! through `by_name_decrypt`. An empty / wrong password surfaces a
//! clear error rather than mangled bytes.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use zip::ZipArchive;

use crate::errors::{InkyCapError, Result};

/// One backup archive in the destination folder.
#[derive(Debug, Serialize)]
pub struct BackupEntry {
    /// Frontend-canonical (forward-slash) absolute path.
    pub path: String,
    /// Filename only, for the UI's list label.
    pub name: String,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Unix-epoch seconds of the archive's mtime.
    pub mtime_unix: i64,
}

/// One file or folder entry inside a backup archive.
#[derive(Debug, Serialize)]
pub struct BackupContentEntry {
    /// Forward-slash path inside the zip, e.g. `"notebox/subdir/note.typ"`.
    pub path_in_zip: String,
    /// True when this is a directory entry.
    pub is_dir: bool,
    /// Uncompressed size in bytes. `0` for directory entries.
    pub size_bytes: u64,
    /// True when this entry is AES-encrypted. All entries in a given
    /// archive share an encryption state in practice, but we surface
    /// it per-entry so the UI can adapt if a future archive happens
    /// to mix modes.
    pub encrypted: bool,
}

/// How `extract_files` resolves a destination path that already exists.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestoreConflictPolicy {
    /// Skip the file, leaving the existing one untouched. Safest
    /// default — the user's current copy is never destroyed without
    /// their explicit ask.
    Skip,
    /// Overwrite in place.
    Overwrite,
    /// Write the restored file next to the existing one with a
    /// `.restored-<timestamp>` suffix on the stem. The existing file
    /// is left untouched.
    Rename,
}

/// Per-file result of an extract pass.
#[derive(Debug, Serialize)]
pub struct RestoreResult {
    /// Frontend-canonical absolute path of the file that was created
    /// (or would have been overwritten). For a `skipped` outcome this
    /// is the path the file would have had.
    pub dest_path: String,
    /// One of: `"written"`, `"skipped"`, `"renamed"`.
    pub outcome: String,
}

/// Enumerate archives in `folder` that match `pattern`. Returns the
/// most-recent first, the same order the retention pruner uses. When
/// `folder` doesn't exist (user reconfigured but never ran a backup),
/// an empty list is returned rather than an error.
pub fn list_archives(folder: &Path, pattern: &str) -> Result<Vec<BackupEntry>> {
    let paths = super::archive::list_matching_archives(folder, pattern)?;
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("list_archives: stat failed for {}: {e}", path.display());
                continue;
            }
        };
        let mtime_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        out.push(BackupEntry {
            path: crate::storage::path::to_frontend_string(&path),
            name,
            size_bytes: meta.len(),
            mtime_unix,
        });
    }
    Ok(out)
}

/// Open `archive_path` and return its entry list. Doesn't decrypt
/// anything — entry metadata is in the central directory, which is
/// never encrypted. The `encrypted` flag on each `BackupContentEntry`
/// tells the UI whether the user will need to supply a password to
/// extract.
pub fn list_contents(archive_path: &Path) -> Result<Vec<BackupContentEntry>> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| InkyCapError::FileNotFound(format!("{}: {e}", archive_path.display())))?;
    let mut zip = ZipArchive::new(file)
        .map_err(|e| InkyCapError::BadRequest(format!("not a valid zip: {e}")))?;

    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        // The zip crate exposes per-entry metadata via `by_index_raw`,
        // which reads from the central directory and does not require
        // decryption. `by_index` would attempt to seek to the
        // compressed data and fail on encrypted entries without a
        // password — that's a worse user experience for what is just
        // a listing call.
        let entry = match zip.by_index_raw(i) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("list_contents: skipping entry {i}: {e}");
                continue;
            }
        };
        out.push(BackupContentEntry {
            path_in_zip: entry.name().to_string(),
            is_dir: entry.is_dir(),
            size_bytes: entry.size(),
            encrypted: entry.encrypted(),
        });
    }
    Ok(out)
}

/// Extract selected entries from `archive_path` into `target_root`.
/// Interior paths in the archive are joined onto `target_root` with
/// the leading `notebox/` or `user-config/` prefix stripped — so a
/// restore into the notebox root puts files back at their original
/// locations.
///
/// `password` is required when any selected entry is AES-encrypted.
/// Passing `None` for an encrypted archive surfaces a clear error.
pub fn extract_files(
    archive_path: &Path,
    target_root: &Path,
    entries: &[String],
    password: Option<&str>,
    conflict: RestoreConflictPolicy,
) -> Result<Vec<RestoreResult>> {
    // Refuse to restore outside the target root (defence-in-depth
    // against a maliciously-crafted archive with `../../../etc/...`
    // entries). All interior paths must, after the prefix strip and
    // join, still live under target_root canonical.
    let target_canon = std::fs::canonicalize(target_root).map_err(|e| {
        InkyCapError::InvalidPath(format!(
            "restore target {} not accessible: {e}",
            target_root.display()
        ))
    })?;

    let file = std::fs::File::open(archive_path)
        .map_err(|e| InkyCapError::FileNotFound(format!("{}: {e}", archive_path.display())))?;
    let mut zip = ZipArchive::new(file)
        .map_err(|e| InkyCapError::BadRequest(format!("not a valid zip: {e}")))?;

    let mut results = Vec::with_capacity(entries.len());

    for interior in entries {
        if interior.ends_with('/') {
            // Skip directory entries — we'll mkdir as needed for files
            // below. Restoring an empty folder is technically possible
            // but isn't a meaningful recovery action.
            continue;
        }

        // Strip the archive's grouping prefix so files land back at
        // their original notebox-relative path. We accept either
        // prefix because the user might restore a notebox-only file
        // OR a user-config file into different targets.
        let rel = interior
            .strip_prefix("notebox/")
            .or_else(|| interior.strip_prefix("user-config/"))
            .unwrap_or(interior.as_str());

        // Defence-in-depth: reject any component that's `..` or
        // absolute. The archive entry IS attacker-controlled.
        let rel_path = PathBuf::from(rel);
        if rel_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir))
        {
            return Err(InkyCapError::InvalidPath(format!(
                "archive entry has unsafe path: {interior}"
            )));
        }

        let dest = target_canon.join(&rel_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Conflict handling
        let final_dest = if dest.exists() {
            match conflict {
                RestoreConflictPolicy::Skip => {
                    results.push(RestoreResult {
                        dest_path: crate::storage::path::to_frontend_string(&dest),
                        outcome: "skipped".to_string(),
                    });
                    continue;
                }
                RestoreConflictPolicy::Overwrite => dest.clone(),
                RestoreConflictPolicy::Rename => {
                    rename_target(&dest)
                }
            }
        } else {
            dest.clone()
        };

        // Re-resolve the canonical parent and verify it still lives
        // under target_canon — protects against symlinks that race
        // between create_dir_all and the write below.
        if let Some(parent) = final_dest.parent() {
            if let Ok(parent_canon) = std::fs::canonicalize(parent) {
                if !parent_canon.starts_with(&target_canon) {
                    return Err(InkyCapError::InvalidPath(format!(
                        "restore target escapes root: {}",
                        final_dest.display()
                    )));
                }
            }
        }

        // Extract. With a password, `by_name_decrypt` returns a
        // reader; without one we go through `by_name`. Either way we
        // stream the contents to disk.
        let bytes_read = {
            let entry_result = match password {
                Some(pw) => zip
                    .by_name_decrypt(interior, pw.as_bytes())
                    .map_err(|e| InkyCapError::ExportFailed(format!("decrypt {interior}: {e}"))),
                None => zip
                    .by_name(interior)
                    .map_err(|e| InkyCapError::ExportFailed(format!("read {interior}: {e}"))),
            };
            let mut entry = entry_result?;
            let mut out_file = std::fs::File::create(&final_dest)?;
            std::io::copy(&mut entry, &mut out_file)?
        };
        let _ = bytes_read;

        let outcome = if dest == final_dest {
            "written"
        } else {
            "renamed"
        };
        results.push(RestoreResult {
            dest_path: crate::storage::path::to_frontend_string(&final_dest),
            outcome: outcome.to_string(),
        });
    }

    Ok(results)
}

/// Build a `<stem>.restored-<unix>.<ext>` sibling path for a Rename
/// conflict resolution. Falls back to `<full-name>.restored-<unix>`
/// when the original has no extension.
fn rename_target(original: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let parent = original.parent().unwrap_or_else(|| Path::new(""));
    let stem = original
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = original.extension().and_then(|s| s.to_str());
    let new_name = match ext {
        Some(e) => format!("{stem}.restored-{stamp}.{e}"),
        None => format!("{stem}.restored-{stamp}"),
    };
    parent.join(new_name)
}
