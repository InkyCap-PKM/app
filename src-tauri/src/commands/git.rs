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

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Emitter, State};

use crate::errors::{InkyCapError, Result};
use crate::git::auth::{self, GitIdentity};
use crate::git::backend::{
    ensure_collaboration_gitignore, ChangeStatus, CommitInfo, GitBackend, GitStatusSummary,
    PushResult,
};
use crate::git::{staging, suggest};
use crate::notebox_settings::NoteboxGitConfig;
use crate::state::AppState;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;

/// The remote name InkyCap uses for a notebox's collaboration remote. The URL
/// lives in [`NoteboxGitConfig::remote`]; the named remote is created/synced
/// from it on each fetch so the command works without a separate setup step.
pub(crate) const REMOTE_NAME: &str = "origin";

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

/// Normalize a path from the frontend (which may send an absolute path) to a
/// notebox-relative one for storage + git.
fn notebox_relative(root: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    p.strip_prefix(root).map(Path::to_path_buf).unwrap_or(p)
}

// ─────────────────────────── Phase 4: setup, status, sign-in ───────────────

/// Outcome of turning a notebox into a collaborative git repo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSetupResult {
    /// A fresh `git init` happened (the notebox was not a repo before). When
    /// false the existing repo was adopted.
    pub initialized: bool,
    /// Status summary right after setup (before any fetch — `behind` is 0).
    pub status: GitStatusSummary,
}

/// The git-side of setup, factored out of the Tauri command so it can be tested
/// against a temp dir without app state: initialize-or-adopt the repo, write the
/// collaboration `.gitignore`, point the `origin` remote at `remote`, and store
/// the optional HTTPS token / commit identity. Does **not** touch notebox
/// settings — the command persists those after this returns.
fn apply_setup(
    root: &Path,
    remote: &str,
    branch: &str,
    https_token: Option<&str>,
    identity: Option<GitIdentity>,
) -> Result<GitSetupResult> {
    let initialized = !GitBackend::is_repo(root);
    let backend = GitBackend::open_or_init(root)?;
    ensure_collaboration_gitignore(root)?;
    backend.set_remote(REMOTE_NAME, remote)?;
    // A freshly init'd repo defaults to `master`; make the first commit land on
    // the configured branch so the eventual push of `refs/heads/<branch>` has
    // something to send. No-op when an existing repo (with commits) is adopted.
    backend.ensure_initial_branch(branch)?;

    if let Some(token) = https_token {
        if !token.trim().is_empty() {
            auth::set_https_token(remote, token)?;
        }
    }
    if let Some(identity) = identity {
        if identity.is_complete() {
            auth::set_identity_for_remote(remote, identity)?;
        }
    }

    Ok(GitSetupResult {
        initialized,
        status: backend.status_summary()?,
    })
}

/// Turn the open notebox into a collaborative git repo and persist its
/// [`NoteboxGitConfig`]. Idempotent: re-running adopts the existing repo and
/// updates the remote/branch. The remote and branch travel in notebox settings;
/// the HTTPS token (keychain) and commit identity (per-installation store) do
/// not. The notebox must be open.
#[tauri::command]
pub async fn git_setup_collaboration(
    remote: String,
    branch: Option<String>,
    identity_name: Option<String>,
    identity_email: Option<String>,
    https_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitSetupResult> {
    let root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let remote = remote.trim().to_string();
    if remote.is_empty() {
        return Err(InkyCapError::BadRequest("remote URL is required".into()));
    }
    let branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "main".to_string());

    let identity = match (identity_name, identity_email) {
        (Some(name), Some(email)) => Some(GitIdentity { name, email }),
        _ => None,
    };

    // Git work (init, gitignore, set-remote, keychain/identity writes) is
    // synchronous; run it off the async runtime.
    let setup_root = root.clone();
    let setup_remote = remote.clone();
    let setup_branch = branch.clone();
    let result = tokio::task::spawn_blocking(move || {
        apply_setup(
            &setup_root,
            &setup_remote,
            &setup_branch,
            https_token.as_deref(),
            identity,
        )
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("setup task failed: {e}")))??;

    // Persist the config into notebox settings (it travels through git) and
    // mirror it into shared state so the fetch/consolidate commands see it
    // without a notebox reopen.
    let mut settings = state.notebox_settings.read().await.clone();
    settings.git = Some(NoteboxGitConfig { remote, branch });
    crate::notebox_settings::save_settings(&root, &settings)?;
    *state.notebox_settings.write().await = settings;

    Ok(result)
}

/// The current git status summary for the open notebox, or `None` when it is
/// not collaborative or not yet a repo. Lets the panel/status-bar refresh after
/// a consolidate, publish, or push without waiting for the next notebox-open
/// event. Fills in `unpushed` (which needs the configured remote + branch).
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<Option<GitStatusSummary>> {
    let root = match state.notebox_root.read().await.clone() {
        Some(r) => r,
        None => return Ok(None),
    };
    let git = match state.notebox_settings.read().await.git.clone() {
        Some(g) => g,
        None => return Ok(None),
    };
    tokio::task::spawn_blocking(move || -> Result<Option<GitStatusSummary>> {
        if !GitBackend::is_repo(&root) {
            return Ok(None);
        }
        let backend = GitBackend::open(&root)?;
        let mut summary = backend.status_summary()?;
        summary.unpushed = backend.unpushed_count(REMOTE_NAME, &git.branch)?;
        Ok(Some(summary))
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("status task failed: {e}")))?
}

/// Store an HTTPS personal-access token for this notebox's remote host
/// (re-authentication without re-running full setup). The token lives only in
/// the OS keychain — never in settings or the repo.
#[tauri::command]
pub async fn git_sign_in(token: String, state: State<'_, AppState>) -> Result<()> {
    let git = require_collaborative(&state).await?;
    auth::set_https_token(&git.remote, &token)
}

/// Stop collaborating on the open notebox: drop its [`NoteboxGitConfig`] and
/// clear any pending review staging. The `.git` directory and stored
/// credentials are left intact — disabling is reversible (re-run setup), and
/// credentials are keyed by host so other noteboxes may share them.
#[tauri::command]
pub async fn git_disable_collaboration(state: State<'_, AppState>) -> Result<()> {
    let root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let mut settings = state.notebox_settings.read().await.clone();
    settings.git = None;
    crate::notebox_settings::save_settings(&root, &settings)?;
    *state.notebox_settings.write().await = settings;

    let _ = staging::clear(&root);
    Ok(())
}

/// The git-side of cloning, factored out for testing without app state: clone
/// `remote` (optionally a specific `branch`) into `dest` with the standard auth
/// callbacks. `dest` must not already exist as a non-empty directory.
fn clone_into(remote: &str, branch: Option<&str>, dest: &Path) -> Result<()> {
    let mut fo = git2::FetchOptions::new();
    fo.remote_callbacks(auth::remote_callbacks(remote));
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fo);
    if let Some(b) = branch {
        builder.branch(b);
    }
    builder.clone(remote, dest)?;
    Ok(())
}

/// Clone a collaborative notebox from a git remote into `dest`, so a
/// collaborator can join entirely in-app (no command-line git). The cloned tree
/// already carries the notebox's settings — remote + branch travel in the
/// committed `.inkycap/settings.json` — so the result opens as a collaborative
/// notebox. Returns the cloned notebox path (frontend form) for the caller to
/// register and open. Stores the optional HTTPS token first so the clone can
/// authenticate. Does not touch the currently-open notebox.
#[tauri::command]
pub async fn git_clone_notebox(
    remote: String,
    branch: Option<String>,
    dest: String,
    https_token: Option<String>,
) -> Result<String> {
    let remote = remote.trim().to_string();
    if remote.is_empty() {
        return Err(InkyCapError::BadRequest("remote URL is required".into()));
    }
    let dest = PathBuf::from(dest.trim());
    if dest.as_os_str().is_empty() {
        return Err(InkyCapError::BadRequest("destination folder is required".into()));
    }
    if dest.exists()
        && std::fs::read_dir(&dest)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Err(InkyCapError::BadRequest(
            "destination folder already exists and is not empty".into(),
        ));
    }

    if let Some(token) = https_token {
        if !token.trim().is_empty() {
            auth::set_https_token(&remote, &token)?;
        }
    }

    let branch = branch.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    let cloned = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        clone_into(&remote, branch.as_deref(), &dest)?;
        Ok(dest)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("clone task failed: {e}")))??;

    Ok(to_frontend_string(&cloned))
}

/// Outcome of [`git_publish`] — the outgoing-authoring counterpart to the
/// incoming review loop. Reports what happened so the frontend can message it.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    /// Working-tree changes were committed (the first publish, or local edits).
    pub committed: bool,
    /// Commits were pushed to the remote.
    pub pushed: bool,
    /// The push was rejected (the remote moved) — fetch & review, then publish
    /// again. Never resolved by force-pushing.
    pub rejected: bool,
    /// Nothing to commit and nothing to push — already in sync.
    pub nothing_to_do: bool,
    /// The commit that was created, when one was.
    pub commit: Option<CommitInfo>,
}

/// Publish locally-authored work: commit the working tree (if anything
/// changed) and push it. This is the outgoing half of the loop — it lands the
/// first commit when a notebox is freshly set up *and* shares subsequent edits.
/// Never force-pushes; a non-fast-forward comes back as `rejected` so the
/// caller fetch-and-reviews before trying again.
#[tauri::command]
pub async fn git_publish(
    message: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<PublishResult> {
    let (root, git) = require_collaborative_with_root(&state).await?;

    let _ = app_handle.emit("notebox:git-push-started", ());
    let result = tokio::task::spawn_blocking(move || -> Result<PublishResult> {
        let backend = GitBackend::open(&root)?;
        backend.set_remote(REMOTE_NAME, &git.remote)?;

        let mut result = PublishResult::default();

        // 1. Commit the working tree if it has changes (new notes, edits,
        //    deletions). Honours .gitignore via stage_all.
        if backend.status_summary()?.dirty {
            let sig = backend.author_signature(&git.remote)?;
            backend.stage_all()?;
            let msg = message.unwrap_or_else(|| "Update notes".to_string());
            let oid = backend.commit(&msg, &sig)?;
            result.committed = true;
            result.commit = backend.commit_info(oid).ok();
        }

        // 2. Push if there is anything the remote doesn't have.
        if backend.unpushed_count(REMOTE_NAME, &git.branch)? > 0 {
            let pr = backend.push(REMOTE_NAME, &git.branch)?;
            if pr.rejected {
                result.rejected = true;
            } else {
                result.pushed = true;
            }
        }

        result.nothing_to_do = !result.committed && !result.pushed && !result.rejected;
        Ok(result)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("publish task failed: {e}")))?;

    match &result {
        Ok(r) if r.rejected => {
            let _ = app_handle.emit(
                "notebox:git-error",
                "remote has moved; fetch and review before publishing again",
            );
        }
        Ok(_) => {
            let _ = app_handle.emit("notebox:git-push-completed", ());
        }
        Err(err) => {
            let _ = app_handle.emit("notebox:git-error", err.to_string());
        }
    }
    result
}

// ─────────────────────────── Phase 3: consolidate & push ───────────────────

/// Set the commit identity for *this* notebox's remote. Stored per-installation
/// keyed by the remote URL (see [`crate::git::auth`]); never enters the repo.
#[tauri::command]
pub async fn git_set_identity(
    name: String,
    email: String,
    state: State<'_, AppState>,
) -> Result<()> {
    let git = require_collaborative(&state).await?;
    auth::set_identity_for_remote(&git.remote, GitIdentity { name, email })
}

/// The commit identity configured for this notebox's remote, if any (for the
/// setup UI to display / seed).
#[tauri::command]
pub async fn git_get_identity(state: State<'_, AppState>) -> Result<Option<GitIdentity>> {
    let git = require_collaborative(&state).await?;
    Ok(auth::identity_for_remote(&git.remote))
}

/// Consolidate one reviewed note: write its resolved staged copy to the working
/// path (through [`NoteboxStorage`]), stage, and commit. The staged copy is the
/// user's resolved version — consolidating *is* the merge. Returns the commit.
#[tauri::command]
pub async fn git_consolidate_note(
    path: String,
    message: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<CommitInfo> {
    let (root, git) = require_collaborative_with_root(&state).await?;
    let storage = state
        .storage
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let rel = notebox_relative(&root, &path);
    let staged = staging::read_staged(&root, &rel)?
        .ok_or_else(|| InkyCapError::BadRequest(format!("no staged copy to consolidate: {path}")))?;

    // The one working-tree write goes through the storage interface.
    storage.write_file(&rel, &staged).await?;

    let msg = message.unwrap_or_else(|| format!("Consolidate {}", rel.display()));
    let info = commit_staged(root.clone(), git, vec![rel.clone()], msg).await?;

    let _ = staging::remove_staged(&root, &rel);
    let _ = app_handle.emit(
        "notebox:git-consolidated",
        serde_json::json!({ "path": to_frontend_string(&rel) }),
    );
    Ok(info)
}

/// Consolidate every staged note in one commit (the batched option). Writes
/// each resolved staged copy to its working path, then a single commit.
#[tauri::command]
pub async fn git_consolidate_all(
    message: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<CommitInfo> {
    let (root, git) = require_collaborative_with_root(&state).await?;
    let storage = state
        .storage
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let rels = staging::list_staged(&root);
    if rels.is_empty() {
        return Err(InkyCapError::BadRequest("nothing staged to consolidate".into()));
    }

    for rel in &rels {
        if let Some(content) = staging::read_staged(&root, rel)? {
            storage.write_file(rel, &content).await?;
        }
    }

    let msg = message.unwrap_or_else(|| format!("Consolidate {} notes", rels.len()));
    let info = commit_staged(root.clone(), git, rels, msg).await?;

    staging::clear(&root)?;
    let _ = app_handle.emit("notebox:git-consolidated", serde_json::json!({ "all": true }));
    Ok(info)
}

/// Push consolidated commits to the remote. Never force-pushes; a rejection
/// (the remote moved) comes back as `PushResult { rejected: true }` so the
/// caller can fetch-and-review rather than force.
#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<PushResult> {
    let (root, git) = require_collaborative_with_root(&state).await?;
    let _ = app_handle.emit("notebox:git-push-started", ());

    let result = tokio::task::spawn_blocking(move || -> Result<PushResult> {
        let backend = GitBackend::open(&root)?;
        backend.set_remote(REMOTE_NAME, &git.remote)?;
        backend.push(REMOTE_NAME, &git.branch)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("push task failed: {e}")))?;

    match &result {
        Ok(r) if r.rejected => {
            let _ = app_handle.emit(
                "notebox:git-error",
                "remote has moved; fetch and review before pushing again",
            );
        }
        Ok(_) => {
            let _ = app_handle.emit("notebox:git-push-completed", ());
        }
        Err(err) => {
            let _ = app_handle.emit("notebox:git-error", err.to_string());
        }
    }
    result
}

/// Abandon the current review session: clear the staging folder. The working
/// tree is untouched (it never changed during review).
#[tauri::command]
pub async fn git_discard_review(state: State<'_, AppState>) -> Result<()> {
    let root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    staging::clear(&root)
}

/// Adopt the fetched remote tip, stage the given notebox-relative paths, and
/// commit them as the remote's author. Adopting theirs first makes the commit a
/// fast-forward over the remote so it pushes without a rebase. Runs the
/// blocking git work off the async runtime.
async fn commit_staged(
    root: PathBuf,
    git: NoteboxGitConfig,
    rels: Vec<PathBuf>,
    message: String,
) -> Result<CommitInfo> {
    tokio::task::spawn_blocking(move || -> Result<CommitInfo> {
        let backend = GitBackend::open(&root)?;
        // Lay the resolutions on top of theirs (the fetched tip) so the
        // consolidate commit fast-forwards the remote rather than diverging.
        if let Some(theirs) = backend.remote_tracking_oid(REMOTE_NAME, &git.branch)? {
            backend.fast_forward_to(theirs)?;
        }
        let sig = backend.author_signature(&git.remote)?;
        backend.stage_paths(&rels)?;
        let oid = backend.commit(&message, &sig)?;
        backend.commit_info(oid)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("commit task failed: {e}")))?
}

/// The open notebox's git config, erroring if it is not collaborative.
async fn require_collaborative(state: &State<'_, AppState>) -> Result<NoteboxGitConfig> {
    state
        .notebox_settings
        .read()
        .await
        .git
        .clone()
        .ok_or_else(|| InkyCapError::BadRequest("notebox is not collaborative".into()))
}

/// The open notebox's root + git config, erroring if not open / not collaborative.
async fn require_collaborative_with_root(
    state: &State<'_, AppState>,
) -> Result<(PathBuf, NoteboxGitConfig)> {
    let root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    Ok((root, require_collaborative(state).await?))
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

    /// Give a repo a git identity so `author_signature`'s git-config fallback
    /// works without touching the global identity store.
    fn set_git_identity(repo_path: &Path) {
        let r = git2::Repository::open(repo_path).unwrap();
        let mut c = r.config().unwrap();
        c.set_str("user.name", "Tester").unwrap();
        c.set_str("user.email", "tester@example.com").unwrap();
    }

    /// Full spine through a bare remote and two clones: fetch → review →
    /// resolve → consolidate (adopting theirs) → push, and a third clone sees
    /// the consolidated result. The consolidate must fast-forward the remote
    /// (parented on theirs), not be rejected.
    #[test]
    fn consolidate_adopts_theirs_and_push_fast_forwards() {
        let bare = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(bare.path()).unwrap();
        let url = bare.path().to_str().unwrap();

        // A: clone, base commit, push.
        let adir = tempfile::tempdir().unwrap();
        let apath = adir.path().join("a");
        git2::Repository::clone(url, &apath).unwrap();
        set_git_identity(&apath);
        let a = GitBackend::open(&apath).unwrap();
        std::fs::write(apath.join("note.typ"), "line one\nline two\n").unwrap();
        a.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        let asig = a.author_signature(url).unwrap();
        a.commit("base", &asig).unwrap();
        let branch = a.current_head().unwrap().unwrap().0;
        assert!(!a.push("origin", &branch).unwrap().rejected);

        // B: clone at base.
        let bdir = tempfile::tempdir().unwrap();
        let bpath = bdir.path().join("b");
        git2::Repository::clone(url, &bpath).unwrap();
        set_git_identity(&bpath);

        // A advances the note and pushes.
        std::fs::write(apath.join("note.typ"), "line one\nCHANGED two\n").unwrap();
        a.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        a.commit("change", &asig).unwrap();
        assert!(!a.push("origin", &branch).unwrap().rejected);

        // B fetches and reviews — the change is clean (B == base).
        let b = GitBackend::open(&bpath).unwrap();
        let git = NoteboxGitConfig {
            remote: url.to_string(),
            branch: branch.clone(),
        };
        b.set_remote(REMOTE_NAME, url).unwrap();
        b.fetch(REMOTE_NAME, &branch).unwrap();
        let session = compute_review_after_fetch(&b, &bpath, &git).unwrap();
        assert_eq!(session.items.len(), 1);
        assert_eq!(session.items[0].conflicts, 0);

        // B resolves (accept theirs) and consolidates: write resolved working,
        // adopt theirs, stage, commit — mirroring commit_staged's body.
        let staged = staging::read_staged(&bpath, Path::new("note.typ")).unwrap().unwrap();
        let resolved = resolve_all_suggestions(&staged, true);
        std::fs::write(bpath.join("note.typ"), &resolved).unwrap();
        let theirs = b.remote_tracking_oid(REMOTE_NAME, &branch).unwrap().unwrap();
        assert!(b.fast_forward_to(theirs).unwrap(), "B should adopt theirs");
        b.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        let bsig = b.author_signature(url).unwrap();
        b.commit("Consolidate note.typ", &bsig).unwrap();
        assert!(
            !b.push("origin", &branch).unwrap().rejected,
            "consolidate parented on theirs ⇒ fast-forward push, not rejected"
        );

        // C: a fresh clone sees the consolidated content.
        let cdir = tempfile::tempdir().unwrap();
        let cpath = cdir.path().join("c");
        git2::Repository::clone(url, &cpath).unwrap();
        assert_eq!(
            std::fs::read_to_string(cpath.join("note.typ")).unwrap(),
            "line one\nCHANGED two\n"
        );
    }

    /// A push that diverged from the remote is reported as rejected (not an
    /// error), so the caller fetch-and-reviews instead of forcing.
    #[test]
    fn diverged_push_is_rejected_not_errored() {
        let bare = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(bare.path()).unwrap();
        let url = bare.path().to_str().unwrap();

        let adir = tempfile::tempdir().unwrap();
        let apath = adir.path().join("a");
        git2::Repository::clone(url, &apath).unwrap();
        set_git_identity(&apath);
        let a = GitBackend::open(&apath).unwrap();
        std::fs::write(apath.join("n.typ"), "base\n").unwrap();
        a.stage_paths(&[PathBuf::from("n.typ")]).unwrap();
        let asig = a.author_signature(url).unwrap();
        a.commit("base", &asig).unwrap();
        let branch = a.current_head().unwrap().unwrap().0;
        a.push("origin", &branch).unwrap();

        // Two clones diverge: both commit on top of base, B pushes first.
        let mk = |name: &str, content: &str| {
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join(name);
            git2::Repository::clone(url, &p).unwrap();
            set_git_identity(&p);
            let g = GitBackend::open(&p).unwrap();
            std::fs::write(p.join("n.typ"), content).unwrap();
            g.stage_paths(&[PathBuf::from("n.typ")]).unwrap();
            let s = g.author_signature(url).unwrap();
            g.commit("edit", &s).unwrap();
            (d, p, g)
        };
        let (_bd, _bp, bgit) = mk("b", "from B\n");
        let (_cd, _cp, cgit) = mk("c", "from C\n");

        assert!(!bgit.push("origin", &branch).unwrap().rejected, "first push wins");
        let res = cgit.push("origin", &branch).unwrap();
        assert!(res.rejected, "second, diverged push is rejected");
        assert!(res.message.is_some());
    }

    /// Setup initializes a fresh repo, writes the collaboration `.gitignore`,
    /// and points `origin` at the remote. Token/identity are left `None` so the
    /// test never touches the real keychain or per-installation identity store.
    #[test]
    fn setup_initializes_repo_gitignore_and_remote() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(!GitBackend::is_repo(root));

        let url = "https://example.com/owner/repo.git";
        let result = apply_setup(root, url, "main", None, None).unwrap();
        assert!(result.initialized, "a non-repo should be git-init'd");

        // It is now a repo, has the managed .gitignore, and origin points at url.
        assert!(GitBackend::is_repo(root));
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.contains(".inkycap/incoming/"), "staging ignored");
        let backend = GitBackend::open(root).unwrap();
        assert_eq!(backend.remote_url(REMOTE_NAME).as_deref(), Some(url));

        // Re-running adopts the existing repo (no second init) and is idempotent.
        let again = apply_setup(root, url, "main", None, None).unwrap();
        assert!(!again.initialized, "an existing repo is adopted, not re-init'd");
    }

    /// Mirrors the *app's* setup path (a plain folder `init`'d, not a clone): a
    /// freshly initialized repo must put its first commit on the *configured*
    /// branch, not libgit2's default `master`, or the push of
    /// `refs/heads/<branch>` fails with "src refspec ... does not match any
    /// existing object". Regression test for that bug.
    #[test]
    fn setup_then_publish_lands_on_configured_branch() {
        let bare = tempfile::tempdir().unwrap();
        let bare_repo = git2::Repository::init_bare(bare.path()).unwrap();
        // Mirror `git init --bare -b main`: point the remote's HEAD at main so a
        // later clone checks out the branch we push (libgit2 defaults to master).
        bare_repo.set_head("refs/heads/main").unwrap();
        let url = bare.path().to_str().unwrap();

        // A plain notebox folder — set up adopts/inits it (no clone).
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        apply_setup(root, url, "main", None, None).unwrap();
        set_git_identity(root);
        let backend = GitBackend::open(root).unwrap();

        std::fs::write(root.join("note.typ"), "hello\n").unwrap();
        backend.stage_all().unwrap();
        let sig = backend.author_signature(url).unwrap();
        backend.commit("init", &sig).unwrap();

        // The first commit is on `main`, not `master`.
        assert_eq!(backend.current_head().unwrap().unwrap().0, "main");
        // …so the push succeeds and a fresh clone sees the content.
        assert!(!backend.push(REMOTE_NAME, "main").unwrap().rejected);
        let cdir = tempfile::tempdir().unwrap();
        let cpath = cdir.path().join("c");
        git2::Repository::clone(url, &cpath).unwrap();
        assert_eq!(
            std::fs::read_to_string(cpath.join("note.typ")).unwrap(),
            "hello\n"
        );
    }

    /// The outgoing half: a freshly set-up notebox commits its working tree and
    /// pushes the initial content (mirrors `git_publish`'s body). After the push
    /// the local remote-tracking ref is updated, so `unpushed_count` reads 0, and
    /// a second clone sees the content.
    #[test]
    fn publish_commits_working_tree_and_pushes_initial() {
        let bare = tempfile::tempdir().unwrap();
        git2::Repository::init_bare(bare.path()).unwrap();
        let url = bare.path().to_str().unwrap();

        // A: clone the empty remote, set up (adopt), author a note in the
        // working tree — no commit yet.
        let adir = tempfile::tempdir().unwrap();
        let apath = adir.path().join("a");
        git2::Repository::clone(url, &apath).unwrap();
        set_git_identity(&apath);
        let a = GitBackend::open(&apath).unwrap();
        std::fs::write(apath.join("note.typ"), "first\n").unwrap();

        // Publish step 1: working tree is dirty → stage all + commit.
        assert!(a.status_summary().unwrap().dirty);
        a.stage_all().unwrap();
        let sig = a.author_signature(url).unwrap();
        a.commit("Update notes", &sig).unwrap();
        assert!(!a.status_summary().unwrap().dirty, "clean after commit");

        // The commit is unpushed (no tracking ref on a fresh clone of an empty
        // remote), then push and the tracking ref is refreshed to HEAD.
        let branch = a.current_head().unwrap().unwrap().0;
        assert_eq!(a.unpushed_count(REMOTE_NAME, &branch).unwrap(), 1);
        assert!(!a.push(REMOTE_NAME, &branch).unwrap().rejected);
        assert_eq!(
            a.unpushed_count(REMOTE_NAME, &branch).unwrap(),
            0,
            "tracking ref updated on push ⇒ nothing left to publish"
        );

        // C: a fresh clone sees the published content.
        let cdir = tempfile::tempdir().unwrap();
        let cpath = cdir.path().join("c");
        git2::Repository::clone(url, &cpath).unwrap();
        assert_eq!(
            std::fs::read_to_string(cpath.join("note.typ")).unwrap(),
            "first\n"
        );
    }

    /// In-app clone onboarding: cloning a remote brings the notebox content
    /// into a fresh folder as a git repo (the collaborator-join path).
    #[test]
    fn clone_into_fetches_notebox_content() {
        let src = tempfile::tempdir().unwrap();
        let s = GitBackend::open_or_init(src.path()).unwrap();
        std::fs::write(src.path().join("note.typ"), "shared\n").unwrap();
        s.stage_all().unwrap();
        s.commit("base", &sig()).unwrap();

        let destdir = tempfile::tempdir().unwrap();
        let dest = destdir.path().join("clone");
        clone_into(src.path().to_str().unwrap(), None, &dest).unwrap();

        assert!(GitBackend::is_repo(&dest));
        assert_eq!(
            std::fs::read_to_string(dest.join("note.typ")).unwrap(),
            "shared\n"
        );
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
