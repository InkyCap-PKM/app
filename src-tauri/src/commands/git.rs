//! IPC commands for notebox-level git collaboration.
//!
//! Phase 2 surface: [`git_fetch_review`] — fetch from the remote, then for each
//! incoming note compute a staged copy with the changes rendered as inline
//! `#suggestion`s (the one review surface). It never merges into the working
//! tree; the user reviews the staged copies and consolidates in Phase 3.
//!
//! The whole git interaction runs on a blocking task: [`git2`] is synchronous
//! and [`GitBackend`] is not `Sync`, so it is created, used, and dropped inside
//! one `spawn_blocking` closure rather than held in shared state.

use std::path::Path;

use serde::Serialize;
use tauri::{Emitter, State};

use crate::errors::{InkyCapError, Result};
use crate::git::backend::{ChangeStatus, CommitInfo, GitBackend};
use crate::git::{staging, suggest};
use crate::notebox_settings::NoteboxGitConfig;
use crate::state::AppState;
use crate::storage::to_frontend_string;

/// The remote name InkyCap uses for a notebox's collaboration remote. The URL
/// lives in [`NoteboxGitConfig::remote`]; the named remote is created/synced
/// from it on each fetch so the command works without a separate setup step.
const REMOTE_NAME: &str = "origin";

/// What kind of change an incoming note carries. `.typ` notes are rendered as
/// suggestions (`Modified`) or staged whole (`Added`); non-note files
/// (attachments, `.bib`, `.collection`) are `Binary` — handled by the
/// whole-file decision flow in Phase 3, never suggestion-ized.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Binary,
}

/// One incoming change in a review session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    /// Notebox-relative path of the working note (frontend string form).
    pub path: String,
    pub kind: ChangeKind,
    /// Staged copy to open for review (frontend string), when one was written
    /// (`Modified`/`Added` notes). `None` for deletes and binary files.
    pub staged_path: Option<String>,
    /// Suggestions rendered (`Modified` only).
    pub total: usize,
    /// Of those, how many are conflicts needing a hand decision.
    pub conflicts: usize,
    /// The note's diff could not be rendered as suggestions; the frontend
    /// should show the raw-diff view for it (the staged copy holds theirs).
    pub fallback: bool,
}

/// The result of a fetch-and-review.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub items: Vec<ReviewItem>,
    /// The incoming tip commit's author/message, for the review banner.
    pub incoming: Option<CommitInfo>,
    /// Local already matches the remote tip — nothing to review.
    pub up_to_date: bool,
}

/// Fetch the collaborative notebox's remote and stage every incoming note as
/// inline suggestions for review. Does not touch the working tree.
#[tauri::command]
pub async fn git_fetch_review(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<ReviewSession> {
    let root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    let git = state
        .notebox_settings
        .read()
        .await
        .git
        .clone()
        .ok_or_else(|| InkyCapError::BadRequest("notebox is not collaborative".into()))?;

    let handle = app_handle.clone();
    tokio::task::spawn_blocking(move || review_session(&root, &git, &handle))
        .await
        .map_err(|e| InkyCapError::Git(format!("review task failed: {e}")))?
}

/// The blocking body: fetch, diff HEAD→theirs, render each note. Runs entirely
/// off the async runtime.
fn review_session(
    root: &Path,
    git: &NoteboxGitConfig,
    handle: &tauri::AppHandle,
) -> Result<ReviewSession> {
    let backend = GitBackend::open(root)?;
    // Keep the named remote in sync with the configured URL so a fetch works
    // without a separate setup command (idempotent).
    backend.set_remote(REMOTE_NAME, &git.remote)?;

    let _ = handle.emit("notebox:git-fetch-started", ());
    if let Err(err) = backend.fetch(REMOTE_NAME, &git.branch) {
        let _ = handle.emit("notebox:git-error", err.to_string());
        return Err(err);
    }
    let _ = handle.emit("notebox:git-fetch-completed", ());

    let session = compute_review_after_fetch(&backend, root, git)?;
    let _ = handle.emit(
        "notebox:git-review-pending",
        serde_json::json!({ "count": session.items.len() }),
    );
    Ok(session)
}

/// Everything after the fetch: diff HEAD→theirs and render each incoming note.
/// Split out from [`review_session`] so the full pipeline can be tested against
/// a local clone without an `AppHandle` or a network remote.
fn compute_review_after_fetch(
    backend: &GitBackend,
    root: &Path,
    git: &NoteboxGitConfig,
) -> Result<ReviewSession> {
    let theirs_oid = match backend.remote_tracking_oid(REMOTE_NAME, &git.branch)? {
        Some(oid) => oid,
        // Remote has no such branch yet (e.g. brand-new repo) — nothing to review.
        None => {
            return Ok(ReviewSession {
                items: Vec::new(),
                incoming: None,
                up_to_date: true,
            })
        }
    };

    let head_oid = backend.current_head()?.map(|(_, oid)| oid);
    if head_oid == Some(theirs_oid) {
        return Ok(ReviewSession {
            items: Vec::new(),
            incoming: None,
            up_to_date: true,
        });
    }

    let base_oid = match head_oid {
        Some(h) => backend.merge_base(h, theirs_oid)?,
        None => None,
    };
    let incoming = backend.commit_info(theirs_oid).ok();
    let (by, on) = incoming
        .as_ref()
        .map(|c| (Some(c.author_name.clone()), Some(format_date(c.timestamp))))
        .unwrap_or((None, None));

    // Fresh staging folder for this review session.
    staging::clear(root)?;

    let mut items = Vec::new();
    for cp in backend.changed_paths(head_oid, theirs_oid)? {
        let rel = &cp.path;
        // Defense in depth: never follow a path component that escapes the root.
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let is_note = rel.extension().and_then(|e| e.to_str()) == Some("typ");

        let item = if !is_note {
            // Attachments, .bib, .collection — whole-file decision in Phase 3.
            ReviewItem {
                path: to_frontend_string(rel),
                kind: ChangeKind::Binary,
                staged_path: None,
                total: 0,
                conflicts: 0,
                fallback: false,
            }
        } else {
            match cp.status {
                ChangeStatus::Deleted => ReviewItem {
                    path: to_frontend_string(rel),
                    kind: ChangeKind::Deleted,
                    staged_path: None,
                    total: 0,
                    conflicts: 0,
                    fallback: false,
                },
                ChangeStatus::Added => {
                    // A brand-new note: stage theirs verbatim for review.
                    let theirs = read_note_blob(&backend, theirs_oid, rel)?;
                    let staged = staging::write_staged(root, rel, &theirs)?;
                    ReviewItem {
                        path: to_frontend_string(rel),
                        kind: ChangeKind::Added,
                        staged_path: Some(to_frontend_string(&staged)),
                        total: 0,
                        conflicts: 0,
                        fallback: false,
                    }
                }
                ChangeStatus::Modified => {
                    let theirs = read_note_blob(&backend, theirs_oid, rel)?;
                    let mine = read_working_or_head(&backend, root, head_oid, rel)?;
                    let base = base_oid
                        .and_then(|b| backend.read_blob_at(b, rel).ok().flatten())
                        .and_then(|bytes| String::from_utf8(bytes).ok());

                    match suggest::render_incoming(
                        base.as_deref(),
                        &mine,
                        &theirs,
                        by.as_deref(),
                        on.as_deref(),
                    ) {
                        suggest::StagedRender::Suggestions(s) => {
                            let staged = staging::write_staged(root, rel, &s.source)?;
                            ReviewItem {
                                path: to_frontend_string(rel),
                                kind: ChangeKind::Modified,
                                staged_path: Some(to_frontend_string(&staged)),
                                total: s.total,
                                conflicts: s.conflicts.len(),
                                fallback: false,
                            }
                        }
                        suggest::StagedRender::Fallback { reason } => {
                            log::info!("git review: {} fell back to raw diff: {reason}", rel.display());
                            // Stage theirs so the raw-diff view has both sides.
                            let staged = staging::write_staged(root, rel, &theirs)?;
                            ReviewItem {
                                path: to_frontend_string(rel),
                                kind: ChangeKind::Modified,
                                staged_path: Some(to_frontend_string(&staged)),
                                total: 0,
                                conflicts: 0,
                                fallback: true,
                            }
                        }
                    }
                }
            }
        };
        items.push(item);
    }

    Ok(ReviewSession {
        items,
        incoming,
        up_to_date: false,
    })
}

/// Read a `.typ` note's bytes at a commit as a UTF-8 string. A note that is
/// missing or not valid UTF-8 yields an empty string (the diff then treats it
/// as added/cleared rather than corrupting content).
fn read_note_blob(backend: &GitBackend, commit: git2::Oid, rel: &Path) -> Result<String> {
    Ok(backend
        .read_blob_at(commit, rel)?
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default())
}

/// My current version of a note: the working-tree file if it exists (so
/// uncommitted edits participate in the 3-way), else the HEAD blob, else empty.
fn read_working_or_head(
    backend: &GitBackend,
    root: &Path,
    head: Option<git2::Oid>,
    rel: &Path,
) -> Result<String> {
    if let Ok(s) = std::fs::read_to_string(root.join(rel)) {
        return Ok(s);
    }
    if let Some(h) = head {
        return read_note_blob(backend, h, rel);
    }
    Ok(String::new())
}

/// Format a commit's Unix timestamp as `YYYY-MM-DD` for the `on:` attribution.
fn format_date(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typst_pipeline::suggestion::resolve_all_suggestions;
    use std::path::PathBuf;

    fn sig() -> git2::Signature<'static> {
        git2::Signature::now("Reviewer", "rev@example.com").unwrap()
    }

    /// End-to-end through a local clone (no network): a remote advances a note,
    /// we fetch and the incoming change is staged as a clean, round-tripping
    /// suggestion.
    #[test]
    fn fetch_review_stages_incoming_modification() {
        // "Remote" repo with a base commit.
        let rdir = tempfile::tempdir().unwrap();
        let r = GitBackend::open_or_init(rdir.path()).unwrap();
        std::fs::write(rdir.path().join("note.typ"), "line one\nline two\n").unwrap();
        r.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        r.commit("base", &sig()).unwrap();

        // Local clone of it (HEAD == base; origin/<branch> == base).
        let ldir = tempfile::tempdir().unwrap();
        let lpath = ldir.path().join("clone");
        git2::Repository::clone(rdir.path().to_str().unwrap(), &lpath).unwrap();

        // Remote advances the note.
        std::fs::write(rdir.path().join("note.typ"), "line one\nCHANGED two\n").unwrap();
        r.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        r.commit("theirs", &sig()).unwrap();

        // Local fetches and reviews. mine == base, so the change is clean.
        let lback = GitBackend::open(&lpath).unwrap();
        let branch = lback.current_head().unwrap().unwrap().0;
        let git = NoteboxGitConfig {
            remote: rdir.path().to_str().unwrap().to_string(),
            branch,
        };
        lback.set_remote(REMOTE_NAME, &git.remote).unwrap();
        lback.fetch(REMOTE_NAME, &git.branch).unwrap();

        let session = compute_review_after_fetch(&lback, &lpath, &git).unwrap();
        assert!(!session.up_to_date);
        assert_eq!(session.items.len(), 1);
        let item = &session.items[0];
        assert!(matches!(item.kind, ChangeKind::Modified));
        assert_eq!(item.conflicts, 0, "mine == base ⇒ clean incoming change");
        assert!(item.staged_path.is_some());
        assert!(session.incoming.is_some(), "incoming commit context present");

        // The staged copy round-trips: accepting all suggestions yields theirs.
        let staged =
            std::fs::read_to_string(staging::staged_path(&lpath, Path::new("note.typ"))).unwrap();
        assert_eq!(
            resolve_all_suggestions(&staged, true),
            "line one\nCHANGED two\n"
        );
        assert_eq!(resolve_all_suggestions(&staged, false), "line one\nline two\n");
    }

    /// When local has nothing new to pull, the session is `up_to_date`.
    #[test]
    fn fetch_review_up_to_date_when_no_incoming() {
        let rdir = tempfile::tempdir().unwrap();
        let r = GitBackend::open_or_init(rdir.path()).unwrap();
        std::fs::write(rdir.path().join("note.typ"), "stable\n").unwrap();
        r.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        r.commit("base", &sig()).unwrap();

        let ldir = tempfile::tempdir().unwrap();
        let lpath = ldir.path().join("clone");
        git2::Repository::clone(rdir.path().to_str().unwrap(), &lpath).unwrap();

        let lback = GitBackend::open(&lpath).unwrap();
        let branch = lback.current_head().unwrap().unwrap().0;
        let git = NoteboxGitConfig {
            remote: rdir.path().to_str().unwrap().to_string(),
            branch,
        };
        lback.set_remote(REMOTE_NAME, &git.remote).unwrap();
        lback.fetch(REMOTE_NAME, &git.branch).unwrap();

        let session = compute_review_after_fetch(&lback, &lpath, &git).unwrap();
        assert!(session.up_to_date);
        assert!(session.items.is_empty());
    }
}
