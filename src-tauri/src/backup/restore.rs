//! Reading existing backup archives:
//!
//!   - `list_archives`: archives in the destination folder.
//!   - `list_contents`: one archive's entries.
//!   - `extract_files`: restore chosen entries, with predictable conflict handling.
//!
//! For AES-encrypted archives the caller passes the password (usually from the
//! keychain) and `by_name_decrypt` is used; a missing or wrong password gives a
//! clear error rather than garbage.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::errors::{InkyCapError, Result};
use crate::storage::zip_archive;

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
    /// True when the entry is AES-encrypted. Archives don't mix modes in
    /// practice, but it is per entry in case one does.
    pub encrypted: bool,
}

/// How `extract_files` resolves a destination path that already exists.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestoreConflictPolicy {
    /// Keep the existing file and skip this one. The default, so a current file
    /// is never lost without the user asking.
    Skip,
    /// Overwrite in place.
    Overwrite,
    /// Write the restored file beside the existing one with a
    /// `.restored-<timestamp>` suffix; the existing file is kept.
    Rename,
}

/// Per-file result of an extract pass.
#[derive(Debug, Serialize)]
pub struct RestoreResult {
    /// Absolute path (frontend form) of the file created, or for `skipped` the
    /// path it would have had.
    pub dest_path: String,
    /// One of: `"written"`, `"skipped"`, `"renamed"`.
    pub outcome: String,
}

/// Archives in `folder` matching `pattern`, newest first (the pruner's order).
/// Empty if `folder` doesn't exist yet.
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

/// An archive's entries. Nothing is decrypted: the entry list isn't encrypted,
/// and each entry's `encrypted` flag says whether restoring needs a password.
pub fn list_contents(archive_path: &Path) -> Result<Vec<BackupContentEntry>> {
    // The shared lister reads from the central directory (no decryption),
    // so encrypted archives still enumerate without a password.
    let entries = zip_archive::list_entries(archive_path)?;
    Ok(entries
        .into_iter()
        .map(|e| BackupContentEntry {
            path_in_zip: e.name,
            is_dir: e.is_dir,
            size_bytes: e.size,
            encrypted: e.encrypted,
        })
        .collect())
}

/// Extract chosen entries into `target_root`, with the `notebox/` or
/// `user-config/` prefix removed, so restoring into the notebox puts files back
/// where they were. `password` is required for encrypted entries; `None` gives
/// a clear error.
pub fn extract_files(
    archive_path: &Path,
    target_root: &Path,
    entries: &[String],
    password: Option<&str>,
    conflict: RestoreConflictPolicy,
) -> Result<Vec<RestoreResult>> {
    // Refuse anything that would land outside the target (an archive with
    // `../../../etc/...` entries).
    let target_canon = std::fs::canonicalize(target_root).map_err(|e| {
        InkyCapError::InvalidPath(format!(
            "restore target {} not accessible: {e}",
            target_root.display()
        ))
    })?;

    let mut zip = zip_archive::open(archive_path)?;
    let mut budget = zip_archive::ExtractBudget::for_archive(archive_path)?;

    let mut results = Vec::with_capacity(entries.len());

    for interior in entries {
        if interior.ends_with('/') {
            // Skip folder entries; folders are created as files need them.
            continue;
        }

        // Remove the grouping prefix so files return to their relative paths.
        // Either prefix is accepted, since notebox and config files may be
        // restored to different places.
        let rel = interior
            .strip_prefix("notebox/")
            .or_else(|| interior.strip_prefix("user-config/"))
            .unwrap_or(interior.as_str());

        // Defence-in-depth: reject any component that's `..` or
        // absolute. The archive entry IS attacker-controlled.
        let rel_path = PathBuf::from(rel);
        if rel_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        }) {
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
                RestoreConflictPolicy::Rename => rename_target(&dest),
            }
        } else {
            dest.clone()
        };

        // Check the canonical parent is still inside the target, against
        // symlinks swapped in after create_dir_all.
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

        // Extract, streaming the (optionally AES-decrypted) entry to disk.
        {
            let mut out_file = std::fs::File::create(&final_dest)?;
            zip_archive::read_entry_to_writer(
                &mut zip,
                interior,
                password,
                &mut budget,
                &mut out_file,
            )?;
        }

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

/// `<stem>.restored-<unix>.<ext>` beside the original, or
/// `<name>.restored-<unix>` without an extension.
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
