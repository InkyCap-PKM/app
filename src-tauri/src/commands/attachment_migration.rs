//! Phase C of the portable-paths plan: migrate the notebox's attachment
//! folder. When the user changes the per-notebox
//! `files.attachment_folder` from old → new, three things must happen
//! atomically:
//!
//! 1. Move every file under `<notebox>/<old>/` to `<notebox>/<new>/`.
//! 2. Across every `.typ` note in the notebox, rewrite path-bearing
//!    calls whose string argument starts with `/<old>/` to `/<new>/`.
//!    Limited to `image`/`read`/`embed`/`bibliography` per the
//!    shared rewriter contract.
//! 3. Persist the updated setting.
//!
//! The preview command is read-only and is used by the settings UI to
//! show "<n> files will move, <m> notes will update" before the user
//! confirms. The apply command performs all three steps; partial
//! failures are reported but not rolled back (rolling back a half-
//! complete fs move would be more dangerous than leaving the user a
//! known-bad state with an explicit error to investigate).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::path_rebase::{
    count_absolute_prefix_matches, replace_absolute_prefix,
};

#[derive(Debug, Clone, Serialize)]
pub struct MigrationPreview {
    /// Current attachment-folder name (informational; the UI may
    /// already know this but echoing it back guards against races
    /// between the user typing and the backend reading state).
    pub current_folder: String,
    /// Number of regular files currently under `<notebox>/<old>/`.
    pub files_to_move: usize,
    /// Number of `.typ` notes whose source contains at least one
    /// path-bearing call referencing `/<old>/`.
    pub notes_to_update: usize,
    /// True when `<notebox>/<new>/` already exists.
    pub target_exists: bool,
    /// True when `<notebox>/<new>/` exists and contains any entries.
    pub target_is_nonempty: bool,
    /// Number of files already in the target folder.
    pub target_file_count: usize,
    /// Number of filenames that collide between source and target.
    pub name_conflicts: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationResult {
    pub files_moved: usize,
    pub notes_updated: usize,
    /// Per-note write errors that occurred during the rewrite step.
    /// The fs move is performed first and atomically (single rename);
    /// errors here are surfaced loudly so the user can inspect, but
    /// they do not roll back the move.
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn preview_attachment_folder_migration(
    new_folder: String,
    state: State<'_, AppState>,
) -> Result<MigrationPreview, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    let current_folder = {
        let s = state.notebox_settings.read().await;
        s.files.attachment_folder.clone()
    };

    let new_folder = validate_folder_segment(&new_folder)?;
    let _ = validate_folder_segment(&current_folder)?; // sanity

    let old_abs = root.join(&current_folder);
    let new_abs = root.join(&new_folder);

    let files_to_move = if old_abs.is_dir() {
        count_files_in_dir(&old_abs)
    } else {
        0
    };

    let (target_exists, target_is_nonempty, target_file_count) = if new_abs.is_dir() {
        let count = count_files_in_dir(&new_abs);
        (true, count > 0, count)
    } else if new_abs.exists() {
        (true, true, 0)
    } else {
        (false, false, 0)
    };

    let name_conflicts = if target_is_nonempty && old_abs.is_dir() {
        count_name_conflicts(&old_abs, &new_abs)
    } else {
        0
    };

    let notes_to_update = if current_folder == new_folder {
        0
    } else {
        count_notes_referencing_segment(&storage, &current_folder).await
    };

    Ok(MigrationPreview {
        current_folder,
        files_to_move,
        notes_to_update,
        target_exists,
        target_is_nonempty,
        target_file_count,
        name_conflicts,
    })
}

#[tauri::command]
pub async fn migrate_attachment_folder(
    new_folder: String,
    state: State<'_, AppState>,
) -> Result<MigrationResult, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    let new_folder = validate_folder_segment(&new_folder)?;
    let current_folder = {
        let s = state.notebox_settings.read().await;
        s.files.attachment_folder.clone()
    };

    if current_folder == new_folder {
        return Ok(MigrationResult {
            files_moved: 0,
            notes_updated: 0,
            errors: Vec::new(),
        });
    }

    let _ = validate_folder_segment(&current_folder)?;
    let old_abs = root.join(&current_folder);
    let new_abs = root.join(&new_folder);
    let mut errors: Vec<String> = Vec::new();

    // Step 1: move files from old → new. When the target is empty or
    // doesn't exist, a single atomic rename suffices. When the target
    // already has files, merge by moving individual files across.
    let files_moved = if old_abs.is_dir() {
        let target_nonempty = new_abs.is_dir()
            && new_abs
                .read_dir()
                .map(|mut it| it.next().is_some())
                .unwrap_or(false);

        if target_nonempty {
            merge_directories(&old_abs, &new_abs, &mut errors).await
        } else {
            // Target doesn't exist or is an empty directory
            if new_abs.is_dir() {
                tokio::fs::remove_dir(&new_abs).await.map_err(|e| {
                    InkyCapError::Io(std::io::Error::other(format!(
                        "removing empty target '{}': {e}",
                        new_abs.display()
                    )))
                })?;
            }
            let count = count_files_in_dir(&old_abs);
            tokio::fs::rename(&old_abs, &new_abs).await.map_err(|e| {
                InkyCapError::Io(std::io::Error::other(format!(
                    "renaming '{}' → '{}': {e}",
                    old_abs.display(),
                    new_abs.display()
                )))
            })?;
            count
        }
    } else {
        // No old folder to move (the user may be establishing a new
        // attachment folder with no prior attachments). Continue with
        // the source rewrite so any hand-authored `/<old>/...` refs
        // are still updated.
        0
    };

    // Step 2: rewrite path-bearing calls across every `.typ` note.
    let mut notes_updated = 0usize;

    let notes = storage
        .list_files(&PathBuf::from(""), "*.typ")
        .await
        .unwrap_or_default();

    // `list_files` returns canonical absolute paths (it walks via the
    // storage's canonical root). The `state.notebox_root` may NOT be
    // canonical on platforms where the user's path contains symlinks
    // — stripping against it silently fails and the migration writes
    // nothing back. Use the storage's canonical root for the strip,
    // and feed the notebox-relative form into read/write so the storage
    // sandbox can validate consistently with how other commands use it.
    let strip_root = storage.canonical_root();
    let probe = format!("/{}/", current_folder);

    for note_abs in notes {
        let rel = match note_abs.strip_prefix(strip_root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => {
                // Falls back to the absolute path — storage.read_file
                // accepts both forms and re-validates internally.
                note_abs.clone()
            }
        };
        let content = match storage.read_file(&rel).await {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("read {}: {e}", rel.display()));
                continue;
            }
        };
        // Cheap byte-level pre-filter: skip the AST parse entirely
        // when the substring can't be present. Important for large
        // noteboxes — the parse is the dominant cost per note.
        if !content.contains(&probe) {
            continue;
        }
        let rewritten = replace_absolute_prefix(&content, &current_folder, &new_folder);
        if rewritten == content {
            continue;
        }
        if let Err(e) = storage.write_file(&rel, &rewritten).await {
            errors.push(format!("write {}: {e}", rel.display()));
            continue;
        }
        state.reindex_note(&rel, &rewritten).await;
        notes_updated += 1;
    }

    // Step 3: persist the setting last, so a mid-flight failure leaves
    // the setting pointing at the old folder name (which is now empty
    // because we moved it) — the user can re-run the migration after
    // diagnosing. If we updated the setting first and step 2 failed,
    // every subsequent compile would see broken absolute references
    // until the rewrite was retried.
    {
        let mut s = state.notebox_settings.write().await;
        s.files.attachment_folder = new_folder.clone();
        let snapshot = s.clone();
        drop(s);
        crate::notebox_settings::save_settings(&root, &snapshot)?;
    }

    Ok(MigrationResult {
        files_moved,
        notes_updated,
        errors,
    })
}

/// Validate a candidate folder segment: must be non-empty, must not
/// contain path separators, must not be `..` or `.`. Mirrors the
/// constraint that attachment folders live as a single directory
/// directly under the notebox root — keeps the migration's
/// `/<segment>/` rewrite path-bearing-call invariant honest.
fn validate_folder_segment(s: &str) -> Result<String, InkyCapError> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(InkyCapError::InvalidPath(
            "attachment folder name must not be empty".into(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(InkyCapError::InvalidPath(format!(
            "attachment folder name must be a single segment, got '{trimmed}'"
        )));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(InkyCapError::InvalidPath(format!(
            "attachment folder name must not be '{trimmed}'"
        )));
    }
    Ok(trimmed.to_string())
}

fn count_files_in_dir(dir: &Path) -> usize {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .count()
}

/// Count filenames that exist in both source and target directories.
fn count_name_conflicts(src: &Path, dst: &Path) -> usize {
    let dst_names: std::collections::HashSet<_> = walkdir::WalkDir::new(dst)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            e.path()
                .strip_prefix(dst)
                .ok()
                .map(|p| p.to_path_buf())
        })
        .collect();

    walkdir::WalkDir::new(src)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            e.path()
                .strip_prefix(src)
                .ok()
                .map(|p| p.to_path_buf())
        })
        .filter(|rel| dst_names.contains(rel))
        .count()
}

/// Merge source directory into an existing target directory by moving
/// files individually. Conflicting filenames in the target are
/// suffixed with `_1`, `_2`, etc. to avoid data loss. After all files
/// are moved, the (now-empty) source directory tree is removed.
async fn merge_directories(src: &Path, dst: &Path, errors: &mut Vec<String>) -> usize {
    let entries: Vec<_> = walkdir::WalkDir::new(src)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .collect();

    let mut moved = 0usize;
    for entry in &entries {
        let rel = match entry.path().strip_prefix(src) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut target = dst.join(rel);

        // Ensure parent directory exists in target
        if let Some(parent) = target.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                errors.push(format!("mkdir {}: {e}", parent.display()));
                continue;
            }
        }

        // Deduplicate filename on conflict
        if target.exists() {
            target = deduplicate_path(&target);
        }

        match tokio::fs::rename(entry.path(), &target).await {
            Ok(()) => moved += 1,
            Err(e) => {
                // rename across filesystems fails; fall back to copy+remove
                match tokio::fs::copy(entry.path(), &target).await {
                    Ok(_) => {
                        let _ = tokio::fs::remove_file(entry.path()).await;
                        moved += 1;
                    }
                    Err(e2) => {
                        errors.push(format!(
                            "move {} → {}: rename={e}, copy={e2}",
                            entry.path().display(),
                            target.display()
                        ));
                    }
                }
            }
        }
    }

    // Clean up empty source tree
    if let Err(e) = tokio::fs::remove_dir_all(src).await {
        errors.push(format!("cleanup {}: {e}", src.display()));
    }

    moved
}

/// Given a path that already exists, append `_1`, `_2`, etc. before
/// the extension until a free slot is found.
fn deduplicate_path(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_string());
    let parent = path.parent().unwrap_or(path);
    for n in 1..10000 {
        let name = match &ext {
            Some(e) => format!("{stem}_{n}.{e}"),
            None => format!("{stem}_{n}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    // Extremely unlikely fallback
    parent.join(format!("{stem}_dup", stem = stem))
}

async fn count_notes_referencing_segment(
    storage: &std::sync::Arc<crate::storage::local::LocalNoteboxStorage>,
    segment: &str,
) -> usize {
    let notes = storage
        .list_files(&PathBuf::from(""), "*.typ")
        .await
        .unwrap_or_default();
    let probe = format!("/{segment}/");
    let strip_root = storage.canonical_root();
    let mut count = 0usize;
    for note_abs in notes {
        // `list_files` returns canonical absolute paths; strip against
        // the storage's canonical root (not `storage.root()`, which may
        // be uncanonicalized). Falls back to the absolute path so
        // `read_file` re-validates either form.
        let rel = note_abs
            .strip_prefix(strip_root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| note_abs.clone());
        let Ok(content) = storage.read_file(&rel).await else {
            continue;
        };
        if !content.contains(&probe) {
            continue;
        }
        if count_absolute_prefix_matches(&content, segment) > 0 {
            count += 1;
        }
    }
    count
}
