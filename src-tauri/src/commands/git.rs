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

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::errors::{InkyCapError, Result};
use crate::git::auth::{self, GitIdentity};
use crate::git::backend::{
    ensure_collaboration_gitignore, ChangeStatus, ChangedPath, CommitInfo, FileVersion, GitBackend,
    GitStatusSummary, MergeOutcome,
};
use crate::git::json_merge::{self, KeyConflict};
use crate::git::{history, package, staging, suggest};
use crate::notebox_settings::NoteboxGitConfig;
use crate::state::{AppState, NoteboxSession};
use crate::storage::traits::NoteboxStorage;
use crate::storage::{canonicalize_root, to_frontend_string, validate_notebox_path};
use crate::typst_pipeline::package_vendor;

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
    window: tauri::WebviewWindow,
) -> Result<ReviewSession> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    let git = session
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
                            log::info!(
                                "git review: {} fell back to raw diff: {reason}",
                                rel.display()
                            );
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
    // Package-handoff setup passes an empty remote (no server): skip the remote
    // and the host-keyed HTTPS token. The notebox is still a git repo — version
    // history and package export/import all work without one.
    if !remote.trim().is_empty() {
        backend.set_remote(REMOTE_NAME, remote)?;
    }
    // A freshly init'd repo defaults to `master`; make the first commit land on
    // the configured branch so the eventual push of `refs/heads/<branch>` has
    // something to send. No-op when an existing repo (with commits) is adopted.
    backend.ensure_initial_branch(branch)?;

    if let Some(token) = https_token {
        if !token.trim().is_empty() && !remote.trim().is_empty() {
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
    window: tauri::WebviewWindow,
) -> Result<GitSetupResult> {
    let session = state.session(window.label()).await;
    let root = session
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
    let mut settings = session.notebox_settings.read().await.clone();
    settings.git = Some(NoteboxGitConfig { remote, branch });
    crate::notebox_settings::save_settings(&root, &settings)?;
    *session.notebox_settings.write().await = settings;

    Ok(result)
}

/// Reconnect collaboration for a notebox that is already a git repo with an
/// `origin` remote but carries no collaboration config (an external clone, or a
/// config that was dropped/never written). Reads the remote + current branch
/// from the repo itself and persists them as the notebox's [`NoteboxGitConfig`]
/// — no user input, no re-`init`. The counterpart to the `notebox:git-reconnectable`
/// offer surfaced on open.
#[tauri::command]
pub async fn git_reconnect_collaboration(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<GitSetupResult> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let probe_root = root.clone();
    let (remote, branch, status) =
        tokio::task::spawn_blocking(move || -> Result<(String, String, GitStatusSummary)> {
            if !GitBackend::is_repo(&probe_root) {
                return Err(InkyCapError::BadRequest(
                    "notebox is not a git repository".into(),
                ));
            }
            let backend = GitBackend::open(&probe_root)?;
            let remote = backend
                .remote_url(REMOTE_NAME)
                .filter(|r| !r.trim().is_empty())
                .ok_or_else(|| {
                    InkyCapError::BadRequest("notebox has no origin remote to reconnect".into())
                })?;
            let branch = backend
                .current_head()?
                .map(|(b, _)| b)
                .unwrap_or_else(|| "main".to_string());
            ensure_collaboration_gitignore(&probe_root)?;
            Ok((remote, branch, backend.status_summary()?))
        })
        .await
        .map_err(|e| InkyCapError::Git(format!("reconnect task failed: {e}")))??;

    // Persist the derived config (travels through git, like a fresh setup).
    let mut settings = session.notebox_settings.read().await.clone();
    settings.git = Some(NoteboxGitConfig { remote, branch });
    crate::notebox_settings::save_settings(&root, &settings)?;
    *session.notebox_settings.write().await = settings;

    Ok(GitSetupResult {
        initialized: false,
        status,
    })
}

/// The current git status summary for the open notebox, or `None` when it is
/// not collaborative or not yet a repo. Lets the panel/status-bar refresh after
/// a consolidate, publish, or push without waiting for the next notebox-open
/// event. Fills in `unpushed` (which needs the configured remote + branch).
#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<GitStatusSummary>> {
    let session = state.session(window.label()).await;
    let root = match session.notebox_root.read().await.clone() {
        Some(r) => r,
        None => return Ok(None),
    };
    let git = match session.notebox_settings.read().await.git.clone() {
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
        summary.unshared = has_unshared_changes(&backend, &root, &git, &summary)?;
        Ok(Some(summary))
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("status task failed: {e}")))?
}

/// Whether the notebox has local work collaborators haven't received yet — the
/// "Changes to share" signal. Server mode trusts the remote-tracking ref (dirty
/// or unpushed commits, which a push clears). Package mode has no server, so a
/// commit count never resets and is meaningless; instead compare HEAD against
/// the last-exported commit recorded in `local.json` (dirty, or HEAD moved past
/// it). The export records the new HEAD, so this flips back to "shared".
fn has_unshared_changes(
    backend: &GitBackend,
    root: &Path,
    git: &NoteboxGitConfig,
    summary: &GitStatusSummary,
) -> Result<bool> {
    if !git.is_package_mode() {
        return Ok(summary.dirty || summary.unpushed > 0);
    }
    if summary.dirty {
        return Ok(true);
    }
    let head = backend.current_head()?.map(|(_, oid)| oid);
    let last_shared = crate::notebox_settings::load_local_state(root)
        .last_shared_oid
        .and_then(|s| git2::Oid::from_str(&s).ok());
    // Unshared when there's a commit that doesn't match the last export (incl.
    // the never-exported case where `last_shared` is None but a commit exists).
    Ok(head.is_some() && head != last_shared)
}

/// Record the current HEAD as the package-handoff "last shared" baseline in the
/// gitignored `local.json`, so the status reads "shared" until the next edit.
fn record_shared_head(backend: &GitBackend, root: &Path) -> Result<()> {
    let head = backend.current_head()?.map(|(_, oid)| oid.to_string());
    let mut local = crate::notebox_settings::load_local_state(root);
    local.last_shared_oid = head;
    crate::notebox_settings::save_local_state(root, &local)
}

/// Store an HTTPS personal-access token for this notebox's remote host
/// (re-authentication without re-running full setup). The token lives only in
/// the OS keychain — never in settings or the repo.
#[tauri::command]
pub async fn git_sign_in(
    token: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let git = require_collaborative(&session).await?;
    auth::set_https_token(&git.remote, &token)
}

/// Stop collaborating on the open notebox: drop its [`NoteboxGitConfig`] and
/// clear any pending review staging. The `.git` directory and stored
/// credentials are left intact — disabling is reversible (re-run setup), and
/// credentials are keyed by host so other noteboxes may share them.
#[tauri::command]
pub async fn git_disable_collaboration(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let mut settings = session.notebox_settings.read().await.clone();
    settings.git = None;
    crate::notebox_settings::save_settings(&root, &settings)?;
    *session.notebox_settings.write().await = settings;

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
        return Err(InkyCapError::BadRequest(
            "destination folder is required".into(),
        ));
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

    let branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    let cloned = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        clone_into(&remote, branch.as_deref(), &dest)?;
        Ok(dest)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("clone task failed: {e}")))??;

    Ok(to_frontend_string(&cloned))
}

// ─────────────────────────── Phase 5: Sync model ───────────────────────────
//
// `git_sync` (pull + merge + push) and `git_check_updates` (pull + merge, no
// push) are the two user-facing gestures. They share one algorithm:
//
//   1. Commit my working edits, if any, → `M` (so the merge sees them).
//   2. Fetch → `T` (the remote tip).
//   3. Nothing incoming (`T` absent / `T == M` / `merge_base(M,T) == T`) ⇒
//      Sync pushes if ahead, Check is up to date.
//   4. Local hasn't diverged (`M` absent / `merge_base(M,T) == M`) ⇒
//      fast-forward the working tree to `T` (a pure pull, no merge commit).
//   5. Diverged ⇒ a real libgit2 3-way merge:
//      • clean ⇒ a two-parent merge commit (parents `[M, T]`) + checkout;
//        Sync pushes (the commit descends from `T`, so it fast-forwards).
//      • conflicts ⇒ auto-apply the clean files to the working tree, render the
//        conflicted notes as inline `#suggestion`s in `.inkycap/incoming/`, and
//        **pause** — returning the conflict list + the incoming digest. The user
//        resolves the staged copies, then `git_sync_finalize` builds the merged
//        tree, makes the merge commit, and pushes (for a Sync).
//
// A merge commit parented on `T` is what keeps the push a fast-forward — no
// rebase, and the commit is atomic, so there is no partial-merge data-loss trap.

/// One incoming change in the post-sync digest ("what landed from others").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestEntry {
    /// Notebox-relative path (frontend string form).
    pub path: String,
    /// `"added"` | `"modified"` | `"deleted"`.
    pub status: String,
}

fn digest_entry(cp: ChangedPath) -> DigestEntry {
    DigestEntry {
        path: to_frontend_string(&cp.path),
        status: match cp.status {
            ChangeStatus::Added => "added",
            ChangeStatus::Modified => "modified",
            ChangeStatus::Deleted => "deleted",
        }
        .to_string(),
    }
}

/// The result of a [`git_sync`] / [`git_check_updates`] / [`git_sync_finalize`].
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// Nothing incoming and nothing outgoing — already in sync.
    pub up_to_date: bool,
    /// Local working edits were committed as part of the sync.
    pub committed: bool,
    /// Incoming changes were folded into the local working tree (fast-forward
    /// or merge commit).
    pub pulled: bool,
    /// Local commits were pushed to the remote (Sync only).
    pub pushed: bool,
    /// The push was rejected (the remote moved since the fetch) — sync again.
    pub rejected: bool,
    /// The merge hit conflicts and is paused: resolve [`conflicts`] then call
    /// `git_sync_finalize`. The clean incoming changes are already applied.
    pub paused: bool,
    /// Conflicted notes/files needing a hand decision (rendered as suggestions
    /// where possible). Only populated when [`paused`].
    pub conflicts: Vec<ReviewItem>,
    /// The shared `settings.json` was edited on both sides and structurally
    /// merged; this lists any same-key clashes still needing a pick. `None`
    /// when settings didn't conflict or merged with no clashes. Only meaningful
    /// when [`paused`].
    pub settings_conflict: Option<SettingsConflict>,
    /// What collaborators changed since the merge base — the non-blocking
    /// "what landed" summary.
    pub digest: Vec<DigestEntry>,
    /// The incoming tip commit's author/message, for the digest banner.
    pub incoming: Option<CommitInfo>,
}

/// A structurally-merged `settings.json` with the same-key clashes left to
/// decide. The merged document (non-conflicting keys already unioned, clashes
/// defaulting to mine) is written to the working tree; [`git_resolve_settings`]
/// rewrites it as the user flips individual keys.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsConflict {
    /// Notebox-relative path of the settings file (frontend string form).
    pub path: String,
    /// The keys both sides changed differently — each needs a Mine/Theirs pick.
    pub conflicts: Vec<KeyConflict>,
}

/// Commit message for the implicit commit of a user's uncommitted working edits
/// at the start of a sync.
const LOCAL_EDITS_MESSAGE: &str = "Update notes";

/// Pull (and optionally push) the collaborative notebox, merging incoming
/// changes. `push` distinguishes Sync (`true`) from a no-push reconcile
/// (`false`) — the latter is offline **package import**, which fetches from a
/// transient local-path remote (the extracted package) and has no server to
/// push to. Pure + blocking-safe (no async, no `AppHandle`) so it can be
/// unit-tested against a bare remote and two clones — and, for package mode,
/// against a local-path remote.
///
/// The remote is taken from `git.remote`, which is a server URL for a Sync and
/// the extracted-package path for an import. An empty `remote` (a package-mode
/// notebox at rest, e.g. when finalizing) skips the `set_remote` — the
/// remote-tracking ref fetched at pause time already lives in `.git`.
///
/// `review` is the per-notebox "review incoming changes before merging"
/// preference: when set and there are incoming changes against a local commit,
/// the sync pauses and stages *every* incoming note as suggestions (clean ones
/// rendered as mine→merged so local edits are never dropped) instead of
/// auto-merging clean changes. Finalizing is the same path as a conflict.
fn run_sync(root: &Path, git: &NoteboxGitConfig, push: bool, review: bool) -> Result<SyncOutcome> {
    let backend = GitBackend::open(root)?;
    if !git.remote.trim().is_empty() {
        backend.set_remote(REMOTE_NAME, &git.remote)?;
    }

    let mut out = SyncOutcome::default();

    // 0. When bundling is on, vendor the notebox's Typst packages (and their
    //    transitive deps) into `.inkycap/packages/` so they travel with the
    //    push. Gated on a dirty tree: new package imports always arrive as
    //    dirty note edits, so a no-op sync skips the scan entirely. Best-effort
    //    — a copy failure logs but must not block syncing notes.
    if backend.status_summary()?.dirty
        && crate::notebox_settings::load_local_state(root).bundle_packages
    {
        if let Err(err) = package_vendor::vendor_notebox_packages(root) {
            log::warn!("package bundling during sync failed: {err}");
        }
    }

    // 1. Commit local working edits, if any → M (so the merge includes them).
    //    Picks up any files the vendoring step above just added.
    let m: Option<git2::Oid> = if backend.status_summary()?.dirty {
        let sig = backend.author_signature(&git.remote)?;
        backend.stage_all()?;
        let oid = backend.commit(LOCAL_EDITS_MESSAGE, &sig)?;
        out.committed = true;
        Some(oid)
    } else {
        backend.current_head()?.map(|(_, oid)| oid)
    };

    // 2. Fetch → T (the remote tip).
    backend.fetch(REMOTE_NAME, &git.branch)?;
    let t = backend.remote_tracking_oid(REMOTE_NAME, &git.branch)?;

    // 3. Nothing incoming?
    let incoming_exists = match (m, t) {
        (_, None) => false,
        (Some(m), Some(t)) if m == t => false,
        (Some(m), Some(t)) => backend.merge_base(m, t)? != Some(t),
        (None, Some(_)) => true,
    };
    if !incoming_exists {
        if push && backend.unpushed_count(REMOTE_NAME, &git.branch)? > 0 {
            push_into(&backend, git, &mut out)?;
        }
        out.up_to_date = !out.committed && !out.pushed && !out.rejected;
        return Ok(out);
    }
    let t = t.expect("incoming implies a remote tip");

    // Shared context for steps 4–5.
    let base = match m {
        Some(m) => backend.merge_base(m, t)?,
        None => None,
    };
    out.incoming = backend.commit_info(t).ok();
    out.digest = backend
        .changed_paths(base, t)?
        .into_iter()
        .map(digest_entry)
        .collect();

    // Review mode: pause and stage every incoming change for review instead of
    // auto-merging. Only meaningful with a local commit to diff against (an
    // unborn/first pull has nothing to review — fall through to fast-forward).
    if review {
        if let Some(m) = m {
            run_review(&backend, root, m, t, base, &mut out)?;
            return Ok(out);
        }
    }

    // 4. Fast-forward (local hasn't diverged: unborn, or M is an ancestor of T).
    let is_ff = match m {
        None => true,
        Some(m) => backend.merge_base(m, t)? == Some(m),
    };
    if is_ff {
        backend.fast_forward_checkout(t)?;
        out.pulled = true;
        return Ok(out);
    }

    // 5. Diverged → a real 3-way merge.
    let m = m.expect("divergence implies a local tip");
    match backend.merge_commits_to_tree(m, t)? {
        MergeOutcome::Clean(tree) => {
            let sig = backend.author_signature(&git.remote)?;
            backend.commit_tree(&merge_message(&out.incoming), &sig, tree, &[m, t])?;
            backend.checkout_head_force()?;
            out.pulled = true;
            if push {
                push_into(&backend, git, &mut out)?;
            }
            Ok(out)
        }
        MergeOutcome::Conflicts(_) => {
            // Land the clean files now; render the conflicts for review + pause.
            let application = backend.apply_clean_merge(m, t)?;
            staging::clear(root)?;

            // settings.json gets a structured key-level merge so distinct config
            // edits on both sides both survive; everything else goes through the
            // note/binary path.
            let settings_path = settings_rel();
            let mut note_conflicts = Vec::new();
            for rel in &application.conflicts {
                if *rel == settings_path {
                    out.settings_conflict = auto_merge_settings(&backend, root, m, t, base)?;
                } else {
                    note_conflicts.push(rel.clone());
                }
            }

            let (by, on) = out
                .incoming
                .as_ref()
                .map(|c| (Some(c.author_name.clone()), Some(format_date(c.timestamp))))
                .unwrap_or((None, None));
            out.conflicts = render_conflict_items(
                &backend,
                root,
                m,
                t,
                base,
                &note_conflicts,
                by.as_deref(),
                on.as_deref(),
            )?;

            // If the structural settings merge resolved everything and nothing
            // else clashed, the merge is effectively clean — commit the merged
            // working tree and push, rather than pausing with nothing to decide.
            if out.conflicts.is_empty() && out.settings_conflict.is_none() {
                let sig = backend.author_signature(&git.remote)?;
                backend.stage_all()?;
                let tree = backend.write_index_tree()?;
                backend.commit_tree(&merge_message(&out.incoming), &sig, tree, &[m, t])?;
                backend.checkout_head_force()?;
                out.pulled = true;
                if push {
                    push_into(&backend, git, &mut out)?;
                }
                return Ok(out);
            }

            out.pulled = !application.applied.is_empty();
            out.paused = true;
            Ok(out)
        }
    }
}

/// Render each conflicted path as a review item: `.typ` notes become inline
/// `#suggestion` staged copies (mine with theirs overlaid); non-note files are
/// surfaced read-only (no suggestion rendering for binaries — a hand decision).
#[allow(clippy::too_many_arguments)]
fn render_conflict_items(
    backend: &GitBackend,
    root: &Path,
    mine_oid: git2::Oid,
    theirs_oid: git2::Oid,
    base_oid: Option<git2::Oid>,
    conflicts: &[PathBuf],
    by: Option<&str>,
    on: Option<&str>,
) -> Result<Vec<ReviewItem>> {
    let mut items = Vec::new();
    for rel in conflicts {
        // Defense in depth: never follow a path component that escapes the root.
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        if rel.extension().and_then(|e| e.to_str()) != Some("typ") {
            items.push(binary_review_item(rel));
            continue;
        }

        let mine = read_note_blob(backend, mine_oid, rel)?;
        let theirs = read_note_blob(backend, theirs_oid, rel)?;
        let base = base_oid
            .and_then(|b| backend.read_blob_at(b, rel).ok().flatten())
            .and_then(|bytes| String::from_utf8(bytes).ok());
        items.push(stage_suggestion_item(
            root,
            rel,
            base.as_deref(),
            &mine,
            &theirs,
            by,
            on,
        )?);
    }
    Ok(items)
}

/// A read-only review row for a non-note (binary/attachment) change — no
/// suggestion rendering; the user decides by hand.
fn binary_review_item(rel: &Path) -> ReviewItem {
    ReviewItem {
        path: to_frontend_string(rel),
        kind: ChangeKind::Binary,
        staged_path: None,
        total: 0,
        conflicts: 0,
        fallback: false,
    }
}

/// Render one note's `base→mine→theirs` triple as inline `#suggestion`s and
/// write the staged copy, returning its review item. Shared by conflict review
/// (base = merge base, theirs = the remote blob) and review-incoming mode (for
/// a clean note, base = mine and theirs = the merged result, so the suggestions
/// show only what others added and accepting never drops local edits).
fn stage_suggestion_item(
    root: &Path,
    rel: &Path,
    base: Option<&str>,
    mine: &str,
    theirs: &str,
    by: Option<&str>,
    on: Option<&str>,
) -> Result<ReviewItem> {
    match suggest::render_incoming(base, mine, theirs, by, on) {
        suggest::StagedRender::Suggestions(s) => {
            let staged = staging::write_staged(root, rel, &s.source)?;
            Ok(ReviewItem {
                path: to_frontend_string(rel),
                kind: ChangeKind::Modified,
                staged_path: Some(to_frontend_string(&staged)),
                total: s.total,
                conflicts: s.conflicts.len(),
                fallback: false,
            })
        }
        suggest::StagedRender::Fallback { reason } => {
            log::info!(
                "git sync: {} fell back to raw diff: {reason}",
                rel.display()
            );
            let staged = staging::write_staged(root, rel, theirs)?;
            Ok(ReviewItem {
                path: to_frontend_string(rel),
                kind: ChangeKind::Modified,
                staged_path: Some(to_frontend_string(&staged)),
                total: 0,
                conflicts: 0,
                fallback: true,
            })
        }
    }
}

/// Review-incoming mode: materialize the merged working tree, then stage *every*
/// incoming added/modified note for review (not just conflicts), and pause.
/// A note that merged cleanly is rendered mine→merged (its merged content is now
/// in the working file) so accepting keeps local edits and takes theirs; a note
/// that genuinely conflicted is rendered base→mine→theirs. Deleted notes and
/// clean binary changes are applied (they appear in the digest); only binaries
/// that conflicted surface as read-only rows. Finalizing uses the same
/// `run_finalize` path as a conflict.
fn run_review(
    backend: &GitBackend,
    root: &Path,
    m: git2::Oid,
    t: git2::Oid,
    base: Option<git2::Oid>,
    out: &mut SyncOutcome,
) -> Result<()> {
    let application = backend.apply_clean_merge(m, t)?;
    let conflicted: std::collections::HashSet<PathBuf> =
        application.conflicts.iter().cloned().collect();
    staging::clear(root)?;

    let (by, on) = out
        .incoming
        .as_ref()
        .map(|c| (Some(c.author_name.clone()), Some(format_date(c.timestamp))))
        .unwrap_or((None, None));
    let (by, on) = (by.as_deref(), on.as_deref());

    let mut items = Vec::new();
    for cp in backend.changed_paths(base, t)? {
        let rel = cp.path;
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        // Deletions are applied (clean) and shown in the digest, not reviewed.
        if matches!(cp.status, ChangeStatus::Deleted) {
            continue;
        }
        if rel.extension().and_then(|e| e.to_str()) != Some("typ") {
            // Only a binary that genuinely conflicted needs a hand decision;
            // a clean binary change is applied and listed in the digest.
            if conflicted.contains(&rel) {
                items.push(binary_review_item(&rel));
            }
            continue;
        }

        if conflicted.contains(&rel) {
            // Genuine conflict: review the full 3-way (base→mine→theirs).
            let mine = read_note_blob(backend, m, &rel)?;
            let theirs = read_note_blob(backend, t, &rel)?;
            let base_s = base
                .and_then(|b| backend.read_blob_at(b, &rel).ok().flatten())
                .and_then(|bytes| String::from_utf8(bytes).ok());
            items.push(stage_suggestion_item(
                root,
                &rel,
                base_s.as_deref(),
                &mine,
                &theirs,
                by,
                on,
            )?);
        } else {
            // Clean incoming change: the merged content is now in the working
            // file. Render mine→merged so the suggestions are exactly what
            // others added and accepting never discards a local edit.
            let mine = read_note_blob(backend, m, &rel)?;
            let merged = std::fs::read_to_string(root.join(&rel)).unwrap_or_default();
            items.push(stage_suggestion_item(
                root,
                &rel,
                Some(&mine),
                &mine,
                &merged,
                by,
                on,
            )?);
        }
    }

    out.conflicts = items;
    out.pulled = !application.applied.is_empty();
    out.paused = true;
    Ok(())
}

/// Push the local branch, recording the outcome into `out` (a rejection is a
/// normal "remote moved" result, not an error).
fn push_into(backend: &GitBackend, git: &NoteboxGitConfig, out: &mut SyncOutcome) -> Result<()> {
    let pr = backend.push(REMOTE_NAME, &git.branch)?;
    if pr.rejected {
        out.rejected = true;
    } else {
        out.pushed = true;
    }
    Ok(())
}

/// Commit message for a merge commit, naming the incoming author when known.
fn merge_message(incoming: &Option<CommitInfo>) -> String {
    match incoming {
        Some(c) if !c.author_name.is_empty() => {
            format!("Merge changes from {}", c.author_name)
        }
        _ => "Merge remote changes".to_string(),
    }
}

/// Finish a paused (conflict) sync: the resolved staged copies are written over
/// the working tree (the clean files already landed), then a two-parent merge
/// commit captures the whole resolved tree and — for a Sync — is pushed. `push`
/// must match the gesture that paused (Sync vs Check). Pure + blocking-safe.
fn run_finalize(root: &Path, git: &NoteboxGitConfig, push: bool) -> Result<SyncOutcome> {
    let backend = GitBackend::open(root)?;
    // Package mode (empty remote) keeps the transient import remote from the
    // paused sync; a server Sync re-points `origin` at its URL. Either way the
    // remote-tracking ref to finalize against is already in `.git`.
    if !git.remote.trim().is_empty() {
        backend.set_remote(REMOTE_NAME, &git.remote)?;
    }

    let mut out = SyncOutcome::default();

    let m = backend
        .current_head()?
        .map(|(_, oid)| oid)
        .ok_or_else(|| InkyCapError::BadRequest("no local commit to finalize a merge".into()))?;
    let t = backend
        .remote_tracking_oid(REMOTE_NAME, &git.branch)?
        .ok_or_else(|| {
            InkyCapError::BadRequest("no fetched remote tip to finalize against".into())
        })?;

    // Write each resolved staged copy over its working note (the clean files
    // were applied at pause; conflicted notes are still at mine until now).
    for rel in staging::list_staged(root) {
        if let Some(content) = staging::read_staged(root, &rel)? {
            let dest = root.join(&rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, content)?;
        }
    }

    // The working tree is now the full merged result. Capture it as a two-parent
    // merge commit so the push fast-forwards the remote.
    let sig = backend.author_signature(&git.remote)?;
    backend.stage_all()?;
    let tree = backend.write_index_tree()?;
    out.incoming = backend.commit_info(t).ok();
    backend.commit_tree(&merge_message(&out.incoming), &sig, tree, &[m, t])?;
    backend.checkout_head_force()?;
    staging::clear(root)?;
    out.pulled = true;

    let base = backend.merge_base(m, t)?;
    out.digest = backend
        .changed_paths(base, t)?
        .into_iter()
        .map(digest_entry)
        .collect();

    if push {
        push_into(&backend, git, &mut out)?;
    }
    Ok(out)
}

/// Sync the collaborative notebox: pull + merge incoming changes, then push.
/// On a conflict it pauses (see [`SyncOutcome::paused`]) — resolve the staged
/// copies and call [`git_sync_finalize`].
#[tauri::command]
pub async fn git_sync(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<SyncOutcome> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    let _ = app_handle.emit("notebox:git-fetch-started", ());
    let result = tokio::task::spawn_blocking(move || {
        let review = crate::notebox_settings::load_local_state(&root).review_incoming;
        run_sync(&root, &git, true, review)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("sync task failed: {e}")))?;
    emit_sync_events(&app_handle, &result);
    result
}

/// A **read-only** check for incoming changes: fetch the remote and report
/// whether (and how much) the local branch is behind — **without** merging,
/// committing, or touching the working tree. Lets a writer see "there are
/// updates, Sync to get them" without pulling files into the notebox. (`fetch`
/// downloads git objects into `.git`, but the notebox's files are untouched.)
#[tauri::command]
pub async fn git_check_updates(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<CheckResult> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    let _ = app_handle.emit("notebox:git-fetch-started", ());
    let result = tokio::task::spawn_blocking(move || run_check(&root, &git))
        .await
        .map_err(|e| InkyCapError::Git(format!("check task failed: {e}")))?;
    match &result {
        Ok(_) => {
            let _ = app_handle.emit("notebox:git-fetch-completed", ());
        }
        Err(err) => {
            let _ = app_handle.emit("notebox:git-error", err.to_string());
        }
    }
    result
}

/// The result of a read-only [`git_check_updates`].
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// Local already has everything on the remote — nothing to pull.
    pub up_to_date: bool,
    /// Commits the remote has that local lacks (what a Sync would bring in).
    pub behind: usize,
    /// The incoming tip commit's author/message, for the "updates from …" note.
    pub incoming: Option<CommitInfo>,
}

/// Fetch and report incoming state without merging. Pure + blocking-safe.
fn run_check(root: &Path, git: &NoteboxGitConfig) -> Result<CheckResult> {
    let backend = GitBackend::open(root)?;
    if !git.remote.trim().is_empty() {
        backend.set_remote(REMOTE_NAME, &git.remote)?;
    }
    backend.fetch(REMOTE_NAME, &git.branch)?;

    let m = backend.current_head()?.map(|(_, oid)| oid);
    let t = backend.remote_tracking_oid(REMOTE_NAME, &git.branch)?;

    let mut out = CheckResult::default();
    match (m, t) {
        // No remote branch yet, or local already contains the remote tip.
        (_, None) => out.up_to_date = true,
        (Some(m), Some(t)) if m == t || backend.merge_base(m, t)? == Some(t) => {
            out.up_to_date = true;
        }
        (Some(m), Some(t)) => {
            out.behind = backend.count_incoming(m, t)?;
            out.up_to_date = out.behind == 0;
            out.incoming = backend.commit_info(t).ok();
        }
        // Unborn local branch — everything on the remote is incoming.
        (None, Some(t)) => {
            out.behind = backend.count_reachable(t)?;
            out.incoming = backend.commit_info(t).ok();
        }
    }
    Ok(out)
}

/// Finish a paused sync after the conflicts have been resolved in their staged
/// copies. `push` matches the gesture that paused (`true` for Sync).
#[tauri::command]
pub async fn git_sync_finalize(
    push: bool,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<SyncOutcome> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    let _ = app_handle.emit("notebox:git-push-started", ());
    let result = tokio::task::spawn_blocking(move || run_finalize(&root, &git, push))
        .await
        .map_err(|e| InkyCapError::Git(format!("finalize task failed: {e}")))?;
    emit_sync_events(&app_handle, &result);
    result
}

/// Translate a sync result into the `notebox:git-*` event vocabulary the store
/// listens on (completion + a friendly error on rejection/failure).
fn emit_sync_events(app_handle: &tauri::AppHandle, result: &Result<SyncOutcome>) {
    match result {
        Ok(r) if r.rejected => {
            let _ = app_handle.emit(
                "notebox:git-error",
                "the remote moved while syncing — sync again",
            );
        }
        Ok(_) => {
            let _ = app_handle.emit("notebox:git-fetch-completed", ());
            let _ = app_handle.emit("notebox:git-push-completed", ());
        }
        Err(err) => {
            let _ = app_handle.emit("notebox:git-error", err.to_string());
        }
    }
}

// ──────────────────── Phase 3b: binary conflict resolution ─────────────────

/// How the user chose to resolve a conflicted binary (non-`.typ`) file. `.typ`
/// notes resolve through inline `#suggestion`s; binaries are whole-file because
/// there's no meaningful line diff to fold in.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BinaryDecision {
    /// Keep the local version (re-assert mine over the working tree).
    KeepMine,
    /// Replace the working file with the incoming version.
    TakeTheirs,
    /// Keep mine at its path and drop the incoming version beside it under a
    /// free " (incoming)" name, so neither side is lost.
    KeepBoth,
}

/// The outcome of resolving one binary conflict, for the frontend to reflect.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryResolution {
    /// The notebox-relative path that now holds the resolved file (always the
    /// original path — that's where mine/theirs land).
    pub path: String,
    /// For [`BinaryDecision::KeepBoth`]: the sibling path the incoming copy was
    /// written to. `None` otherwise.
    pub added_path: Option<String>,
}

/// Write `bytes` to a working-tree path, creating parent dirs as needed.
fn write_working(dest: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dest, bytes)?;
    Ok(())
}

/// Remove a working-tree path; absent is success (the decision wanted it gone).
fn remove_working(dest: &Path) -> Result<()> {
    match std::fs::remove_file(dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Find a free `name (incoming).ext` sibling for `rel` inside the notebox so a
/// "Keep both" never clobbers an existing file. Bumps a counter on collision.
fn free_incoming_name(canonical_root: &Path, rel: &Path) -> Result<PathBuf> {
    let parent = rel.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = rel.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = rel.extension().and_then(|s| s.to_str());
    for n in 0..1000 {
        let suffix = if n == 0 {
            " (incoming)".to_string()
        } else {
            format!(" (incoming {})", n + 1)
        };
        let name = match ext {
            Some(e) => format!("{stem}{suffix}.{e}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = parent.join(&name);
        if !canonical_root.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err(InkyCapError::Git(
        "could not find a free incoming filename".into(),
    ))
}

/// Apply a whole-file decision to one conflicted binary, mutating the working
/// tree immediately (mirrors how `apply_clean_merge` materializes clean files
/// at pause). Finalize's `stage_all` + merge commit then captures the result.
/// Reads mine from HEAD and theirs from the already-fetched remote tip — no
/// network. Pure + blocking-safe.
fn resolve_binary(
    root: &Path,
    git: &NoteboxGitConfig,
    path: &str,
    decision: BinaryDecision,
) -> Result<BinaryResolution> {
    let canonical_root = canonicalize_root(root)?;
    // git tree lookups want the repo-relative path; the working write wants the
    // validated absolute path (both rejected if they escape the notebox).
    let rel = notebox_relative(root, path);
    let dest = validate_notebox_path(&canonical_root, &rel)?;

    let backend = GitBackend::open(root)?;
    let m = backend.current_head()?.map(|(_, oid)| oid);
    let t = backend
        .remote_tracking_oid(REMOTE_NAME, &git.branch)?
        .ok_or_else(|| {
            InkyCapError::BadRequest("no fetched remote tip to resolve against".into())
        })?;

    let mut out = BinaryResolution {
        path: to_frontend_string(&rel),
        added_path: None,
    };

    match decision {
        BinaryDecision::KeepMine => {
            let mine = match m {
                Some(m) => backend.read_blob_at(m, &rel)?,
                None => None,
            };
            match mine {
                Some(bytes) => write_working(&dest, &bytes)?,
                None => remove_working(&dest)?,
            }
        }
        BinaryDecision::TakeTheirs => match backend.read_blob_at(t, &rel)? {
            Some(bytes) => write_working(&dest, &bytes)?,
            None => remove_working(&dest)?,
        },
        BinaryDecision::KeepBoth => {
            // Re-assert mine at its path (in case a prior Take-theirs replaced it).
            if let Some(m) = m {
                if let Some(bytes) = backend.read_blob_at(m, &rel)? {
                    write_working(&dest, &bytes)?;
                }
            }
            // Drop the incoming copy beside it under a free name.
            if let Some(theirs) = backend.read_blob_at(t, &rel)? {
                let sibling = free_incoming_name(&canonical_root, &rel)?;
                write_working(&canonical_root.join(&sibling), &theirs)?;
                out.added_path = Some(to_frontend_string(&sibling));
            }
        }
    }
    Ok(out)
}

/// Resolve one conflicted binary file by a whole-file decision, before
/// [`git_sync_finalize`] commits the merged tree. Re-callable: the user can
/// switch their choice for a file until they finalize.
#[tauri::command]
pub async fn git_resolve_binary_conflict(
    path: String,
    decision: BinaryDecision,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<BinaryResolution> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    tokio::task::spawn_blocking(move || resolve_binary(&root, &git, &path, decision))
        .await
        .map_err(|e| InkyCapError::Git(format!("resolve task failed: {e}")))?
}

// ──────────────── Phase 3b: structured settings.json merge ──────────────────

/// The notebox-relative path of the shared settings file — the unit for
/// structured (key-level) settings reconciliation.
fn settings_rel() -> PathBuf {
    Path::new(".inkycap").join("settings.json")
}

/// Read a commit's `settings.json` as JSON, or `Null` when it's absent,
/// unreadable, or not valid JSON (so a malformed side merges as "empty").
fn read_settings_json(
    backend: &GitBackend,
    oid: Option<git2::Oid>,
    rel: &Path,
) -> serde_json::Value {
    oid.and_then(|o| backend.read_blob_at(o, rel).ok().flatten())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// Write a merged settings document over the working `settings.json` (pretty,
/// matching `save_settings`' `to_string_pretty`).
fn write_merged_settings(root: &Path, merged: &serde_json::Value) -> Result<()> {
    let dest = crate::notebox_settings::settings_path(root);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&dest, serde_json::to_string_pretty(merged)?)?;
    Ok(())
}

/// Structurally merge a conflicted `settings.json` and write the result over the
/// working file. Returns the same-key clashes still needing a pick, or `None`
/// when the merge was fully automatic (distinct / one-sided key edits). The
/// merged document defaults each clash to mine.
fn auto_merge_settings(
    backend: &GitBackend,
    root: &Path,
    m: git2::Oid,
    t: git2::Oid,
    base: Option<git2::Oid>,
) -> Result<Option<SettingsConflict>> {
    let rel = settings_rel();
    let mine = read_settings_json(backend, Some(m), &rel);
    let theirs = read_settings_json(backend, Some(t), &rel);
    let base_v = read_settings_json(backend, base, &rel);

    let merge = json_merge::three_way(&base_v, &mine, &theirs);
    write_merged_settings(root, &merge.merged)?;

    if merge.conflicts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(SettingsConflict {
            path: to_frontend_string(&rel),
            conflicts: merge.conflicts,
        }))
    }
}

/// Apply per-key decisions to the structurally-merged settings: recompute the
/// 3-way merge (clashes default to mine), flip each key the user marked
/// "theirs", and write the result over the working file. Re-callable until
/// finalize — the user can change choices freely.
fn resolve_settings(
    root: &Path,
    git: &NoteboxGitConfig,
    decisions: &HashMap<String, String>,
) -> Result<()> {
    let backend = GitBackend::open(root)?;
    let m = backend.current_head()?.map(|(_, oid)| oid).ok_or_else(|| {
        InkyCapError::BadRequest("no local commit to resolve settings against".into())
    })?;
    let t = backend
        .remote_tracking_oid(REMOTE_NAME, &git.branch)?
        .ok_or_else(|| {
            InkyCapError::BadRequest("no fetched remote tip to resolve against".into())
        })?;
    let base = backend.merge_base(m, t)?;
    let rel = settings_rel();
    let mine = read_settings_json(&backend, Some(m), &rel);
    let theirs = read_settings_json(&backend, Some(t), &rel);
    let base_v = read_settings_json(&backend, base, &rel);

    let merge = json_merge::three_way(&base_v, &mine, &theirs);
    let mut merged = merge.merged;
    for c in &merge.conflicts {
        if decisions
            .get(&c.path)
            .map(|d| d == "theirs")
            .unwrap_or(false)
        {
            json_merge::set_at_path(&mut merged, &c.path, c.theirs.clone());
        }
    }
    write_merged_settings(root, &merged)
}

/// Resolve the structurally-merged `settings.json` by choosing a side for each
/// clashing key. `decisions` maps a dotted key path to `"mine"` or `"theirs"`
/// (absent / `"mine"` keeps the local value — the default). Re-callable until
/// [`git_sync_finalize`] commits the working tree.
#[tauri::command]
pub async fn git_resolve_settings(
    decisions: HashMap<String, String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    tokio::task::spawn_blocking(move || resolve_settings(&root, &git, &decisions))
        .await
        .map_err(|e| InkyCapError::Git(format!("resolve task failed: {e}")))?
}

// ─────────────────────────── Phase 6: version history ──────────────────────

/// Normalize a path from the frontend (which may send an absolute path) to a
/// notebox-relative one for git + storage.
fn notebox_relative(root: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    p.strip_prefix(root).map(Path::to_path_buf).unwrap_or(p)
}

/// Parse a commit hash from the frontend, mapping a bad value to a 400.
fn parse_commit(commit: &str) -> Result<git2::Oid> {
    git2::Oid::from_str(commit)
        .map_err(|e| InkyCapError::BadRequest(format!("invalid version id: {e}")))
}

/// A note's past versions, newest first (commit author/date/message only). Empty
/// when the note has no committed history yet.
#[tauri::command]
pub async fn git_note_history(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<FileVersion>> {
    let session = state.session(window.label()).await;
    let (root, _git) = require_collaborative_with_root(&session).await?;
    let rel = notebox_relative(&root, &path);
    tokio::task::spawn_blocking(move || -> Result<Vec<FileVersion>> {
        if !GitBackend::is_repo(&root) {
            return Ok(Vec::new());
        }
        GitBackend::open(&root)?.file_history(&rel, 200)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("history task failed: {e}")))?
}

/// Write a past version of a note to a disposable scratch file (gitignored,
/// watcher-ignored) and return its path, to open as a read-only view tab.
/// `commit` is a full hash from [`git_note_history`].
#[tauri::command]
pub async fn git_open_note_version(
    path: String,
    commit: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String> {
    let session = state.session(window.label()).await;
    let (root, _git) = require_collaborative_with_root(&session).await?;
    let rel = notebox_relative(&root, &path);
    let scratch = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        let backend = GitBackend::open(&root)?;
        let content = read_version_text(&backend, parse_commit(&commit)?, &rel)?;
        let short: String = commit.chars().take(7).collect();
        history::write_view(&root, &short, &rel, &content)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("open-version task failed: {e}")))??;
    Ok(to_frontend_string(&scratch))
}

/// Restore a past version: write its content back to the working note (through
/// [`NoteboxStorage`]) as a new edit. Non-destructive — history is untouched and
/// the restore becomes an ordinary change the user then Syncs.
#[tauri::command]
pub async fn git_restore_note_version(
    path: String,
    commit: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let (root, _git) = require_collaborative_with_root(&session).await?;
    let storage = session
        .storage
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    let rel = notebox_relative(&root, &path);

    let read_rel = rel.clone();
    let content = tokio::task::spawn_blocking(move || -> Result<String> {
        let backend = GitBackend::open(&root)?;
        read_version_text(&backend, parse_commit(&commit)?, &read_rel)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("restore task failed: {e}")))??;

    // The one working-tree write goes through the storage interface.
    storage.write_file(&rel, &content).await?;
    Ok(())
}

/// Read a note's UTF-8 content at a specific commit, erroring if absent/binary.
fn read_version_text(backend: &GitBackend, commit: git2::Oid, rel: &Path) -> Result<String> {
    backend
        .read_blob_at(commit, rel)?
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| {
            InkyCapError::BadRequest("that version of the note could not be read".into())
        })
}

// ─────────────────────────── Identity & review session ─────────────────────

/// Set the commit identity for *this* notebox's remote. Stored per-installation
/// keyed by the remote URL (see [`crate::git::auth`]); never enters the repo.
#[tauri::command]
pub async fn git_set_identity(
    name: String,
    email: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let git = require_collaborative(&session).await?;
    auth::set_identity_for_remote(&git.remote, GitIdentity { name, email })
}

/// The commit identity configured for this notebox's remote, if any (for the
/// setup UI to display / seed).
#[tauri::command]
pub async fn git_get_identity(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<GitIdentity>> {
    let session = state.session(window.label()).await;
    let git = require_collaborative(&session).await?;
    Ok(auth::identity_for_remote(&git.remote))
}

/// The commit identity InkyCap **would** stamp on this notebox's commits, for
/// pre-filling the identity fields so the author is never a mystery: the
/// per-notebox identity chosen for this remote if set, otherwise the git-config
/// identity (`user.name`/`user.email`) it falls back to. `None` when neither
/// exists (the user must then enter one). Works before collaboration is set up
/// (reads the global git config), so the setup form can pre-fill too.
#[tauri::command]
pub async fn git_default_commit_identity(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<GitIdentity>> {
    let session = state.session(window.label()).await;
    let root = session.notebox_root.read().await.clone();
    let remote = session
        .notebox_settings
        .read()
        .await
        .git
        .as_ref()
        .map(|g| g.remote.clone());

    tokio::task::spawn_blocking(move || -> Result<Option<GitIdentity>> {
        // 1. The identity already chosen for this remote, if complete.
        if let Some(remote) = &remote {
            if let Some(id) = auth::identity_for_remote(remote) {
                if id.is_complete() {
                    return Ok(Some(id));
                }
            }
        }
        // 2. The git-config identity InkyCap falls back to — from the repo's
        //    config (local + global) when it's a repo, else the global config.
        let from_repo = root
            .as_ref()
            .filter(|r| GitBackend::is_repo(r))
            .and_then(|r| GitBackend::open(r).ok())
            .and_then(|b| b.config_identity());
        if let Some((name, email)) = from_repo {
            return Ok(Some(GitIdentity { name, email }));
        }
        if let Ok(cfg) = git2::Config::open_default() {
            let name = cfg
                .get_string("user.name")
                .ok()
                .filter(|s| !s.trim().is_empty());
            let email = cfg
                .get_string("user.email")
                .ok()
                .filter(|s| !s.trim().is_empty());
            if let (Some(name), Some(email)) = (name, email) {
                return Ok(Some(GitIdentity { name, email }));
            }
        }
        Ok(None)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("identity task failed: {e}")))?
}

/// Abort a paused merge: clear the staging folder **and restore the working
/// tree to HEAD**. A conflicted Sync auto-applies the clean (non-conflicting)
/// incoming files to the working tree before pausing; without this restore they
/// would linger as uncommitted changes and be swept into the *next* Sync's
/// commit (observed: an abandoned merge against the wrong remote polluting the
/// notebox). HEAD is the pre-merge commit — Sync commits local edits *before*
/// merging — so committed work is preserved; the abandoned merge can simply be
/// re-run later (its incoming changes are still on the remote).
#[tauri::command]
pub async fn git_discard_review(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    staging::clear(&root)?;
    tokio::task::spawn_blocking(move || -> Result<()> {
        if GitBackend::is_repo(&root) {
            let backend = GitBackend::open(&root)?;
            // Only meaningful once a commit exists; a forced checkout of an
            // unborn HEAD has nothing to restore to.
            if backend.current_head()?.is_some() {
                backend.checkout_head_force()?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("discard task failed: {e}")))?
}

// ───────────────────── Phase 7: offline package handoff ────────────────────
//
// Collaborate with no hosted git server. `git_export_package` zips the open
// notebox's whole `.git` (its full history) to a single file; the recipient
// either imports it as a brand-new notebox (`git_import_package_as_notebox`) or,
// if they already have the notebox, reconciles it into theirs
// (`git_import_package`). Reconciliation rides the Phase 5 engine unchanged: the
// package is extracted to a temp staging repo, a transient local-path remote is
// pointed at it, and `run_sync(..., push = false)` does the same 3-way merge as
// a server Sync — conflicts pause and finalize via `git_sync_finalize(false)`.
// A package-handoff notebox is marked by an empty `NoteboxGitConfig::remote`
// (see `is_package_mode`); `git_setup_package_handoff` creates one.

/// Outcome of [`git_export_package`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageExportResult {
    /// Where the package was written (frontend string form).
    pub path: String,
    /// Files written from `.git` (objects, refs, etc.).
    pub file_count: u64,
    /// Uncompressed bytes of `.git` packaged.
    pub bytes: u64,
    /// When `include_packages` was set: canonical specs (`@ns/name:ver`) of the
    /// Typst packages vendored into the notebox so they travel with the export.
    pub vendored_packages: Vec<String>,
    /// Package specs the notebox imports but that couldn't be located locally
    /// (e.g. a never-installed `@local` package) and so were NOT bundled. The
    /// recipient may be unable to compile notes that need them.
    pub unresolved_packages: Vec<String>,
}

/// Export the open notebox — with its full git history — to a single
/// (optionally AES-256-encrypted) package file. Commits any pending working
/// edits first so the package carries the latest. Works for any collaborative
/// notebox (server-backed or package-mode).
#[tauri::command]
pub async fn git_export_package(
    dest: String,
    password: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<PackageExportResult> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    let dest_path = PathBuf::from(dest.trim());
    if dest_path.as_os_str().is_empty() {
        return Err(InkyCapError::BadRequest(
            "destination file is required".into(),
        ));
    }
    let password = password.filter(|p| !p.is_empty());

    let (path, summary, vendor) = tokio::task::spawn_blocking(
        move || -> Result<(PathBuf, package::PackageSummary, package_vendor::VendorReport)> {
            // When the notebox is set to bundle packages, vendor them into
            // `.inkycap/packages/` first so the commit below captures them and
            // they travel inside the exported history. Done before the dirty
            // check so any newly-copied files are part of the package.
            let vendor = if crate::notebox_settings::load_local_state(&root).bundle_packages {
                package_vendor::vendor_notebox_packages(&root)?
            } else {
                package_vendor::VendorReport::default()
            };

            // Commit my working edits, if any, so the package is current.
            let backend = GitBackend::open(&root)?;
            if backend.status_summary()?.dirty {
                let sig = backend.author_signature(&git.remote)?;
                backend.stage_all()?;
                backend.commit(LOCAL_EDITS_MESSAGE, &sig)?;
            }
            let summary = package::export(&root, &dest_path, password.as_deref())?;
            // Record the shared baseline so the status reads "shared" until the
            // next edit (package mode has no remote ref to track this).
            record_shared_head(&backend, &root)?;
            Ok((dest_path, summary, vendor))
        },
    )
    .await
    .map_err(|e| InkyCapError::Git(format!("export task failed: {e}")))??;

    Ok(PackageExportResult {
        path: to_frontend_string(&path),
        file_count: summary.file_count,
        bytes: summary.uncompressed_bytes,
        vendored_packages: vendor.vendored,
        unresolved_packages: vendor.unresolved,
    })
}

/// Import a received package into the **currently open** notebox, reconciling
/// its history with ours through the same merge as Sync (no push — there is no
/// server). Returns a [`SyncOutcome`]: on a conflict it pauses exactly like a
/// Sync, and the frontend finalizes with `git_sync_finalize(push = false)`.
/// Use this when you already have the notebox; a first-time recipient uses
/// [`git_import_package_as_notebox`].
#[tauri::command]
pub async fn git_import_package(
    archive: String,
    password: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<SyncOutcome> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    let archive_path = PathBuf::from(archive.trim());
    if archive_path.as_os_str().is_empty() {
        return Err(InkyCapError::BadRequest("package file is required".into()));
    }
    let password = password.filter(|p| !p.is_empty());
    let _ = app_handle.emit("notebox:git-fetch-started", ());

    let result = tokio::task::spawn_blocking(move || -> Result<SyncOutcome> {
        let staging = package::extract_to_temp(&archive_path, password.as_deref())?;
        // Point a transient remote at the extracted repo (a local path). The
        // fetch copies its objects + the `origin/<branch>` ref into our `.git`,
        // so once this returns the staging dir is no longer needed — a paused
        // merge finalizes against that persisted ref.
        // path-stringification-ok: consumed by libgit2 as a local-path remote,
        // not compared on the frontend.
        let staging_remote = staging.path().to_string_lossy().into_owned();
        let tmp_git = NoteboxGitConfig {
            remote: staging_remote,
            branch: git.branch.clone(),
        };
        let review = crate::notebox_settings::load_local_state(&root).review_incoming;
        let outcome = run_sync(&root, &tmp_git, false, review)?;
        drop(staging);
        Ok(outcome)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("import task failed: {e}")))?;
    emit_sync_events(&app_handle, &result);
    result
}

/// Import a received package as a **new** notebox at `dest` — for a first-time
/// recipient who does not already have this notebox. Extracts the package,
/// clones it into `dest` (materializing the working tree), and drops the
/// transient `origin` remote (it pointed at the temp staging dir), so a
/// package-handoff notebox carries no dangling remote. Returns the new notebox
/// path (frontend form) for the caller to register and open. Sibling of
/// [`git_clone_notebox`]; does not touch the currently-open notebox.
#[tauri::command]
pub async fn git_import_package_as_notebox(
    archive: String,
    password: Option<String>,
    dest: String,
) -> Result<String> {
    let archive_path = PathBuf::from(archive.trim());
    if archive_path.as_os_str().is_empty() {
        return Err(InkyCapError::BadRequest("package file is required".into()));
    }
    let dest = PathBuf::from(dest.trim());
    if dest.as_os_str().is_empty() {
        return Err(InkyCapError::BadRequest(
            "destination folder is required".into(),
        ));
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
    let password = password.filter(|p| !p.is_empty());

    let cloned = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        let staging = package::extract_to_temp(&archive_path, password.as_deref())?;
        // path-stringification-ok: consumed by libgit2 as a local clone source.
        let staging_path = staging.path().to_string_lossy().into_owned();
        clone_into(&staging_path, None, &dest)?;
        // The clone's `origin` points at the temp staging dir; drop it. A
        // server-backed package re-adds `origin` on its first Sync (its URL
        // travels in the committed `.inkycap/settings.json`); a package-mode one
        // never needs it.
        let backend = GitBackend::open(&dest)?;
        backend.remove_remote(REMOTE_NAME)?;
        // A first-time recipient has exactly what was shared with them — nothing
        // new to share yet, so seed the shared baseline at the imported HEAD.
        record_shared_head(&backend, &dest)?;
        drop(staging);
        Ok(dest)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("import task failed: {e}")))??;

    Ok(to_frontend_string(&cloned))
}

/// Set up the open notebox for **server-less** collaboration (offline package
/// handoff): init/adopt the git repo with no remote, so the notebox is
/// collaborative — version history and package export/import all work — without
/// a hosted git server. The counterpart to [`git_setup_collaboration`];
/// persists a [`NoteboxGitConfig`] with an empty `remote` (package mode).
#[tauri::command]
pub async fn git_setup_package_handoff(
    branch: Option<String>,
    identity_name: Option<String>,
    identity_email: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<GitSetupResult> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "main".to_string());
    let identity = match (identity_name, identity_email) {
        (Some(name), Some(email)) => Some(GitIdentity { name, email }),
        _ => None,
    };

    let setup_root = root.clone();
    let setup_branch = branch.clone();
    let result = tokio::task::spawn_blocking(move || {
        apply_setup(&setup_root, "", &setup_branch, None, identity)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("setup task failed: {e}")))??;

    let mut settings = session.notebox_settings.read().await.clone();
    settings.git = Some(NoteboxGitConfig {
        remote: String::new(),
        branch,
    });
    crate::notebox_settings::save_settings(&root, &settings)?;
    *session.notebox_settings.write().await = settings;

    Ok(result)
}

// ───────── Review-incoming preference (per-notebox, per-machine) ────────────

/// Whether the open notebox is set to review incoming changes before merging
/// (the per-machine `NoteboxLocalState::review_incoming`). Off by default.
#[tauri::command]
pub async fn git_get_review_incoming(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<bool> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    Ok(crate::notebox_settings::load_local_state(&root).review_incoming)
}

/// Set whether the open notebox reviews incoming changes before merging. Stored
/// per-machine (gitignored `local.json`), so it never travels to collaborators.
#[tauri::command]
pub async fn git_set_review_incoming(
    enabled: bool,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut local = crate::notebox_settings::load_local_state(&root);
        local.review_incoming = enabled;
        crate::notebox_settings::save_local_state(&root, &local)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("review-incoming task failed: {e}")))?
}

/// Result of [`git_set_bundle_packages`] when enabling: what the immediate
/// vendor pass copied in, so the UI can confirm or warn.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundlePackagesResult {
    /// Canonical specs (`@ns/name:ver`) newly vendored into the notebox.
    pub vendored: Vec<String>,
    /// Imported specs that couldn't be located locally (e.g. a never-installed
    /// `@local` package) and so were NOT bundled.
    pub unresolved: Vec<String>,
}

/// Whether the open notebox bundles its Typst packages on share
/// (`NoteboxLocalState::bundle_packages`, per-machine). Off by default.
#[tauri::command]
pub async fn git_get_bundle_packages(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<bool> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    Ok(crate::notebox_settings::load_local_state(&root).bundle_packages)
}

/// Set whether the open notebox bundles its Typst packages when sharing (Sync
/// push or package export). Stored per-machine. Enabling vendors the notebox's
/// current packages immediately so the toggle takes visible effect now rather
/// than only on the next share; the returned report says what was bundled.
#[tauri::command]
pub async fn git_set_bundle_packages(
    enabled: bool,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<BundlePackagesResult> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    tokio::task::spawn_blocking(move || -> Result<BundlePackagesResult> {
        let mut local = crate::notebox_settings::load_local_state(&root);
        local.bundle_packages = enabled;
        crate::notebox_settings::save_local_state(&root, &local)?;
        if enabled {
            let report = package_vendor::vendor_notebox_packages(&root)?;
            Ok(BundlePackagesResult {
                vendored: report.vendored,
                unresolved: report.unresolved,
            })
        } else {
            Ok(BundlePackagesResult::default())
        }
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("bundle-packages task failed: {e}")))?
}

/// Reconstruct an in-progress review from the on-disk staging folder, so a
/// paused Sync/import survives an app restart (the `SyncOutcome` lives only in
/// memory, but the staged copies are on disk in `.inkycap/incoming/`). Returns a
/// paused [`SyncOutcome`] listing the staged notes when a review is pending, or
/// a non-paused default when nothing is staged. The per-note conflict counts and
/// incoming author are not recovered (the staged copies still carry the
/// suggestion markup to review), so the items read as plain incoming changes.
#[tauri::command]
pub async fn git_pending_review(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<SyncOutcome> {
    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let mut out = SyncOutcome::default();
    let staged = staging::list_staged(&root);
    if staged.is_empty() {
        return Ok(out);
    }
    out.paused = true;
    out.pulled = true;
    out.conflicts = staged
        .into_iter()
        .map(|rel| {
            let staged_path = staging::staged_path(&root, &rel);
            ReviewItem {
                path: to_frontend_string(&rel),
                kind: ChangeKind::Modified,
                staged_path: Some(to_frontend_string(&staged_path)),
                total: 0,
                conflicts: 0,
                fallback: false,
            }
        })
        .collect();
    Ok(out)
}

/// The open notebox's git config, erroring if it is not collaborative.
async fn require_collaborative(session: &NoteboxSession) -> Result<NoteboxGitConfig> {
    session
        .notebox_settings
        .read()
        .await
        .git
        .clone()
        .ok_or_else(|| InkyCapError::BadRequest("notebox is not collaborative".into()))
}

/// The open notebox's root + git config, erroring if not open / not collaborative.
async fn require_collaborative_with_root(
    session: &NoteboxSession,
) -> Result<(PathBuf, NoteboxGitConfig)> {
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    Ok((root, require_collaborative(session).await?))
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
        assert!(
            session.incoming.is_some(),
            "incoming commit context present"
        );

        // The staged copy round-trips: accepting all suggestions yields theirs.
        let staged =
            std::fs::read_to_string(staging::staged_path(&lpath, Path::new("note.typ"))).unwrap();
        assert_eq!(
            resolve_all_suggestions(&staged, true),
            "line one\nCHANGED two\n"
        );
        assert_eq!(
            resolve_all_suggestions(&staged, false),
            "line one\nline two\n"
        );
    }

    /// Give a repo a git identity so `author_signature`'s git-config fallback
    /// works without touching the global identity store.
    fn set_git_identity(repo_path: &Path) {
        let r = git2::Repository::open(repo_path).unwrap();
        let mut c = r.config().unwrap();
        c.set_str("user.name", "Tester").unwrap();
        c.set_str("user.email", "tester@example.com").unwrap();
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

        assert!(
            !bgit.push("origin", &branch).unwrap().rejected,
            "first push wins"
        );
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
        assert!(
            !again.initialized,
            "an existing repo is adopted, not re-init'd"
        );
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

    /// The outgoing primitives a first Sync relies on: a freshly set-up notebox
    /// commits its working tree and pushes the initial content. After the push
    /// the local remote-tracking ref is updated, so `unpushed_count` reads 0, and
    /// a second clone sees the content.
    #[test]
    fn first_sync_commits_working_tree_and_pushes_initial() {
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

    // ── Phase 5: Sync model (run_sync / run_finalize) ─────────────────────────

    /// A bare remote whose HEAD points at `main` (libgit2 inits on `master`).
    fn bare_remote() -> (tempfile::TempDir, String) {
        let bare = tempfile::tempdir().unwrap();
        let r = git2::Repository::init_bare(bare.path()).unwrap();
        r.set_head("refs/heads/main").unwrap();
        let url = bare.path().to_str().unwrap().to_string();
        (bare, url)
    }

    /// Clone `url` into a fresh temp dir under `name`, with a git commit identity.
    fn clone_at(url: &str, name: &str) -> (tempfile::TempDir, PathBuf, GitBackend) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join(name);
        git2::Repository::clone(url, &p).unwrap();
        set_git_identity(&p);
        let g = GitBackend::open(&p).unwrap();
        (d, p, g)
    }

    fn main_cfg(url: &str) -> NoteboxGitConfig {
        NoteboxGitConfig {
            remote: url.to_string(),
            branch: "main".into(),
        }
    }

    /// Seed the remote with `files` from clone A and push them on `main`.
    fn seed(a: &GitBackend, apath: &Path, url: &str, files: &[(&str, &str)]) {
        a.ensure_initial_branch("main").unwrap();
        for (name, content) in files {
            std::fs::write(apath.join(name), content).unwrap();
        }
        a.stage_all().unwrap();
        a.commit("base", &a.author_signature(url).unwrap()).unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
    }

    fn commit_push(a: &GitBackend, apath: &Path, url: &str, file: &str, content: &str) {
        std::fs::write(apath.join(file), content).unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &a.author_signature(url).unwrap())
            .unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
    }

    /// Divergent edits to *different* files merge cleanly, commit, and push.
    #[test]
    fn sync_merges_clean_divergent_edits_and_pushes() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(
            &a,
            &ap,
            &url,
            &[("x.typ", "x base\n"), ("y.typ", "y base\n")],
        );
        let (_bd, bp, _b) = clone_at(&url, "b");

        commit_push(&a, &ap, &url, "x.typ", "x THEIRS\n");

        // B edits a *different* file (uncommitted) and syncs.
        std::fs::write(bp.join("y.typ"), "y MINE\n").unwrap();
        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(out.committed && out.pulled && out.pushed && !out.paused);
        assert!(out.conflicts.is_empty());
        assert_eq!(
            std::fs::read_to_string(bp.join("x.typ")).unwrap(),
            "x THEIRS\n"
        );
        assert_eq!(
            std::fs::read_to_string(bp.join("y.typ")).unwrap(),
            "y MINE\n"
        );
        assert_eq!(out.digest.len(), 1, "only x landed from A");
        assert_eq!(out.digest[0].status, "modified");

        // A third clone sees both edits.
        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(
            std::fs::read_to_string(cp.join("x.typ")).unwrap(),
            "x THEIRS\n"
        );
        assert_eq!(
            std::fs::read_to_string(cp.join("y.typ")).unwrap(),
            "y MINE\n"
        );
    }

    /// Same-region edits conflict: sync pauses with the note staged as
    /// suggestions; finalizing the resolution commits the merge and pushes.
    #[test]
    fn sync_conflict_pauses_then_finalizes_and_pushes() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("note.typ", "line one\nline two\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        commit_push(&a, &ap, &url, "note.typ", "AAA one\nline two\n");

        // B rewrites the same line (uncommitted) and syncs → conflict, pause.
        std::fs::write(bp.join("note.typ"), "BBB one\nline two\n").unwrap();
        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(out.paused && !out.pushed);
        assert_eq!(out.conflicts.len(), 1);
        let item = &out.conflicts[0];
        assert!(matches!(item.kind, ChangeKind::Modified));
        assert!(item.conflicts >= 1, "both edited the same line");
        assert!(item.staged_path.is_some());

        // Resolve: accept theirs in the staged copy (what the pills do).
        let rel = Path::new("note.typ");
        let staged = staging::read_staged(&bp, rel).unwrap().unwrap();
        let resolved = resolve_all_suggestions(&staged, true);
        std::fs::write(staging::staged_path(&bp, rel), &resolved).unwrap();

        let fin = run_finalize(&bp, &git, true).unwrap();
        assert!(fin.pulled && fin.pushed && !fin.paused);
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "AAA one\nline two\n"
        );

        // A third clone sees the resolved result.
        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(
            std::fs::read_to_string(cp.join("note.typ")).unwrap(),
            "AAA one\nline two\n"
        );
    }

    /// Both sides change the same binary → sync pauses with a binary conflict
    /// (no staged copy). `resolve_binary` applies each whole-file decision to the
    /// working tree, and finalize commits + pushes the result.
    #[test]
    fn binary_conflict_resolves_mine_theirs_and_both() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("note.typ", "n\n"), ("img.bin", "BASE")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        // A changes the binary and pushes; B changes it differently (uncommitted).
        commit_push(&a, &ap, &url, "img.bin", "THEIRS");
        std::fs::write(bp.join("img.bin"), "MINE").unwrap();

        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(out.paused && !out.pushed);
        let item = out
            .conflicts
            .iter()
            .find(|i| i.path.ends_with("img.bin"))
            .expect("the binary is a conflict item");
        assert!(matches!(item.kind, ChangeKind::Binary));
        assert!(item.staged_path.is_none(), "binaries have no staged copy");
        // At pause the working tree keeps mine.
        assert_eq!(std::fs::read(bp.join("img.bin")).unwrap(), b"MINE");

        // Take theirs → working file is theirs.
        resolve_binary(&bp, &git, "img.bin", BinaryDecision::TakeTheirs).unwrap();
        assert_eq!(std::fs::read(bp.join("img.bin")).unwrap(), b"THEIRS");

        // Switch back to mine (re-callable until finalize).
        resolve_binary(&bp, &git, "img.bin", BinaryDecision::KeepMine).unwrap();
        assert_eq!(std::fs::read(bp.join("img.bin")).unwrap(), b"MINE");

        // Keep both: mine stays, theirs lands under a free sibling name.
        let res = resolve_binary(&bp, &git, "img.bin", BinaryDecision::KeepBoth).unwrap();
        assert_eq!(std::fs::read(bp.join("img.bin")).unwrap(), b"MINE");
        assert_eq!(res.added_path.as_deref(), Some("img (incoming).bin"));
        assert_eq!(
            std::fs::read(bp.join("img (incoming).bin")).unwrap(),
            b"THEIRS"
        );

        // Finalize commits the working tree (mine + the incoming sibling) and pushes.
        let fin = run_finalize(&bp, &git, true).unwrap();
        assert!(fin.pulled && fin.pushed && !fin.paused);

        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(std::fs::read(cp.join("img.bin")).unwrap(), b"MINE");
        assert_eq!(
            std::fs::read(cp.join("img (incoming).bin")).unwrap(),
            b"THEIRS"
        );
    }

    /// Seed a single-line `settings.json` (so a both-sides edit forces a git
    /// conflict on the one line, exercising the structured merge) plus a note.
    fn seed_settings(a: &GitBackend, apath: &Path, url: &str, json: &str) {
        std::fs::create_dir_all(apath.join(".inkycap")).unwrap();
        std::fs::write(apath.join(".inkycap/settings.json"), json).unwrap();
        std::fs::write(apath.join("n.typ"), "n\n").unwrap();
        a.ensure_initial_branch("main").unwrap();
        a.stage_all().unwrap();
        a.commit("base", &a.author_signature(url).unwrap()).unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
    }

    fn read_settings(p: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(p.join(".inkycap/settings.json")).unwrap()).unwrap()
    }

    /// Both sides edit *different* keys of settings.json → the structured merge
    /// keeps both edits automatically, with no pause (an effectively-clean merge).
    #[test]
    fn settings_conflict_auto_merges_distinct_keys() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed_settings(&a, &ap, &url, r#"{"a":1,"b":2}"#);
        let (_bd, bp, _b) = clone_at(&url, "b");

        // A changes key b and pushes; B changes key a (uncommitted).
        std::fs::write(ap.join(".inkycap/settings.json"), r#"{"a":1,"b":9}"#).unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &a.author_signature(&url).unwrap())
            .unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
        std::fs::write(bp.join(".inkycap/settings.json"), r#"{"a":5,"b":2}"#).unwrap();

        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(
            !out.paused,
            "distinct-key settings edits merge automatically"
        );
        assert!(out.settings_conflict.is_none());
        assert!(out.pulled && out.pushed);
        assert_eq!(read_settings(&bp), serde_json::json!({ "a": 5, "b": 9 }));

        // A third clone sees both edits.
        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(read_settings(&cp), serde_json::json!({ "a": 5, "b": 9 }));
    }

    /// Both sides set the *same* key differently → sync pauses with a settings
    /// clash; `resolve_settings` picks theirs, and finalize commits + pushes.
    #[test]
    fn settings_same_key_clash_pauses_then_resolves() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed_settings(&a, &ap, &url, r#"{"view":"source"}"#);
        let (_bd, bp, _b) = clone_at(&url, "b");

        std::fs::write(ap.join(".inkycap/settings.json"), r#"{"view":"live"}"#).unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &a.author_signature(&url).unwrap())
            .unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
        std::fs::write(bp.join(".inkycap/settings.json"), r#"{"view":"reading"}"#).unwrap();

        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(out.paused, "a same-key clash needs a decision");
        let sc = out
            .settings_conflict
            .expect("the settings clash is surfaced");
        assert_eq!(sc.conflicts.len(), 1);
        assert_eq!(sc.conflicts[0].path, "view");
        // The merged working file defaults the clash to mine.
        assert_eq!(read_settings(&bp), serde_json::json!({ "view": "reading" }));

        // Pick theirs for `view`, then finalize.
        let mut decisions = HashMap::new();
        decisions.insert("view".to_string(), "theirs".to_string());
        resolve_settings(&bp, &git, &decisions).unwrap();
        assert_eq!(read_settings(&bp), serde_json::json!({ "view": "live" }));

        let fin = run_finalize(&bp, &git, true).unwrap();
        assert!(fin.pulled && fin.pushed && !fin.paused);

        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(read_settings(&cp), serde_json::json!({ "view": "live" }));
    }

    /// Package mode (no remote): "unshared" is true while there are commits past
    /// the last-exported HEAD, and resets once that HEAD is recorded — so the
    /// status reads "Changes to share" → shared → "Changes to share" across an
    /// export-then-edit cycle, instead of an ever-growing commit count.
    #[test]
    fn package_unshared_tracks_last_exported_head() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        git2::Repository::init(root).unwrap();
        set_git_identity(root);
        let backend = GitBackend::open(root).unwrap();
        let git = NoteboxGitConfig {
            remote: String::new(),
            branch: "main".into(),
        };
        let sig = backend.author_signature("").unwrap();

        std::fs::write(root.join("n.typ"), "one\n").unwrap();
        backend.stage_all().unwrap();
        backend.commit("c1", &sig).unwrap();

        // A commit exists but was never exported → unshared.
        let summary = backend.status_summary().unwrap();
        assert!(has_unshared_changes(&backend, root, &git, &summary).unwrap());

        // Record the export → shared.
        record_shared_head(&backend, root).unwrap();
        assert!(!has_unshared_changes(&backend, root, &git, &summary).unwrap());

        // A new commit moves HEAD past the shared baseline → unshared again.
        std::fs::write(root.join("n.typ"), "two\n").unwrap();
        backend.stage_all().unwrap();
        backend.commit("c2", &sig).unwrap();
        let summary2 = backend.status_summary().unwrap();
        assert!(has_unshared_changes(&backend, root, &git, &summary2).unwrap());

        // A dirty working tree is unshared even at the shared HEAD.
        record_shared_head(&backend, root).unwrap();
        std::fs::write(root.join("n.typ"), "three\n").unwrap();
        let summary3 = backend.status_summary().unwrap();
        assert!(summary3.dirty);
        assert!(has_unshared_changes(&backend, root, &git, &summary3).unwrap());
    }

    /// Sync with no local changes fast-forwards to the remote (a pure pull —
    /// nothing to push back).
    #[test]
    fn sync_fast_forwards_on_pure_pull() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("n.typ", "before\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        commit_push(&a, &ap, &url, "n.typ", "after\n");

        // B is clean; pull via fast-forward (nothing to push back).
        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(out.pulled && !out.pushed && !out.committed && !out.paused);
        assert_eq!(
            std::fs::read_to_string(bp.join("n.typ")).unwrap(),
            "after\n"
        );
    }

    /// Nothing on either side ⇒ up to date.
    #[test]
    fn sync_reports_up_to_date_when_nothing_changed() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("n.typ", "stable\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(out.up_to_date && !out.pulled && !out.pushed && !out.committed);
    }

    /// Local edits with nothing incoming ⇒ commit + push (no merge).
    #[test]
    fn sync_pushes_local_edits_when_nothing_incoming() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("n.typ", "base\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        std::fs::write(bp.join("n.typ"), "B edit\n").unwrap();
        let out = run_sync(&bp, &git, true, false).unwrap();
        assert!(out.committed && out.pushed && !out.pulled && !out.up_to_date);

        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(
            std::fs::read_to_string(cp.join("n.typ")).unwrap(),
            "B edit\n"
        );
    }

    /// Check for updates reports how far behind the remote is **without** pulling
    /// — the working tree must be untouched (no files downloaded into the notebox).
    #[test]
    fn check_updates_reports_behind_without_touching_working_tree() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("n.typ", "v1\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        commit_push(&a, &ap, &url, "n.typ", "v2\n");

        let res = run_check(&bp, &git).unwrap();
        assert!(
            !res.up_to_date && res.behind == 1,
            "one incoming commit reported"
        );
        assert!(res.incoming.is_some(), "incoming commit context present");
        assert_eq!(
            std::fs::read_to_string(bp.join("n.typ")).unwrap(),
            "v1\n",
            "check must not pull — B's working file is unchanged"
        );
    }

    /// Nothing incoming ⇒ up to date, zero behind.
    #[test]
    fn check_updates_up_to_date_when_current() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("n.typ", "v1\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        let res = run_check(&bp, &git).unwrap();
        assert!(res.up_to_date && res.behind == 0);
    }

    // ── Phase 7: offline package handoff (server-less, local-path remote) ──────

    /// A package-mode notebox seeded with `files`, no remote. Returns its dir
    /// (kept alive by the caller) and an opened backend.
    fn package_notebox(files: &[(&str, &str)]) -> (tempfile::TempDir, GitBackend) {
        let d = tempfile::tempdir().unwrap();
        let g = GitBackend::open_or_init(d.path()).unwrap();
        set_git_identity(d.path());
        g.ensure_initial_branch("main").unwrap();
        for (name, content) in files {
            std::fs::write(d.path().join(name), content).unwrap();
        }
        g.stage_all().unwrap();
        g.commit("base", &sig()).unwrap();
        (d, g)
    }

    /// Receive a package as a brand-new package-mode notebox (the
    /// `git_import_package_as_notebox` body): extract → clone → drop origin.
    fn receive_as_notebox(archive: &Path, into: &Path) {
        let staging = package::extract_to_temp(archive, None).unwrap();
        clone_into(&staging.path().to_string_lossy(), None, into).unwrap();
        GitBackend::open(into)
            .unwrap()
            .remove_remote(REMOTE_NAME)
            .unwrap();
        set_git_identity(into);
    }

    /// Reconcile a package into an existing notebox (the `git_import_package`
    /// body): extract → transient local-path remote → `run_sync(push = false)`.
    fn reconcile_package(archive: &Path, into: &Path) -> SyncOutcome {
        reconcile_package_review(archive, into, false)
    }

    /// As [`reconcile_package`], with the review-incoming preference.
    fn reconcile_package_review(archive: &Path, into: &Path, review: bool) -> SyncOutcome {
        let staging = package::extract_to_temp(archive, None).unwrap();
        let tmp = NoteboxGitConfig {
            remote: staging.path().to_string_lossy().into_owned(),
            branch: "main".into(),
        };
        run_sync(into, &tmp, false, review).unwrap()
    }

    /// Two package-mode noteboxes sharing history reconcile divergent edits to
    /// *different* files with a clean merge and **no push** — the Sync engine
    /// driven by the extracted package as a local-path remote.
    #[test]
    fn package_handoff_merges_clean_divergent_edits() {
        let (adir, a) = package_notebox(&[("x.typ", "x base\n"), ("y.typ", "y base\n")]);

        // B receives A as a new notebox.
        let pkg0 = tempfile::tempdir().unwrap();
        let base_pkg = pkg0.path().join("base.inkypkg");
        package::export(adir.path(), &base_pkg, None).unwrap();
        let bdir = tempfile::tempdir().unwrap();
        let bp = bdir.path().join("b");
        receive_as_notebox(&base_pkg, &bp);
        assert_eq!(
            std::fs::read_to_string(bp.join("x.typ")).unwrap(),
            "x base\n"
        );

        // A edits x, commits, exports an update package.
        std::fs::write(adir.path().join("x.typ"), "x THEIRS\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        let update_pkg = pkg0.path().join("update.inkypkg");
        package::export(adir.path(), &update_pkg, None).unwrap();

        // B edits a *different* file (uncommitted) and imports A's update.
        std::fs::write(bp.join("y.typ"), "y MINE\n").unwrap();
        let out = reconcile_package(&update_pkg, &bp);
        assert!(out.committed && out.pulled && !out.pushed && !out.paused);
        assert_eq!(
            std::fs::read_to_string(bp.join("x.typ")).unwrap(),
            "x THEIRS\n"
        );
        assert_eq!(
            std::fs::read_to_string(bp.join("y.typ")).unwrap(),
            "y MINE\n"
        );
        assert_eq!(out.digest.len(), 1, "only x landed from the package");
    }

    /// A same-line conflict in a package import pauses with the note staged as
    /// suggestions; finalizing with `push = false` commits the merge locally
    /// (no server) using the package-mode (empty-remote) config.
    #[test]
    fn package_handoff_conflict_pauses_then_finalizes_without_push() {
        let (adir, a) = package_notebox(&[("note.typ", "line one\nline two\n")]);

        let pkg0 = tempfile::tempdir().unwrap();
        let base_pkg = pkg0.path().join("base.inkypkg");
        package::export(adir.path(), &base_pkg, None).unwrap();
        let bdir = tempfile::tempdir().unwrap();
        let bp = bdir.path().join("b");
        receive_as_notebox(&base_pkg, &bp);

        // A and B rewrite the same line; A packages, B imports → conflict.
        std::fs::write(adir.path().join("note.typ"), "AAA one\nline two\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        let update_pkg = pkg0.path().join("update.inkypkg");
        package::export(adir.path(), &update_pkg, None).unwrap();

        std::fs::write(bp.join("note.typ"), "BBB one\nline two\n").unwrap();
        let out = reconcile_package(&update_pkg, &bp);
        assert!(out.paused && !out.pushed);
        assert_eq!(out.conflicts.len(), 1);
        assert!(out.conflicts[0].staged_path.is_some());

        // Resolve: accept theirs in the staged copy, then finalize (no push).
        let rel = Path::new("note.typ");
        let staged = staging::read_staged(&bp, rel).unwrap().unwrap();
        let resolved = resolve_all_suggestions(&staged, true);
        std::fs::write(staging::staged_path(&bp, rel), &resolved).unwrap();

        let package_git = NoteboxGitConfig {
            remote: String::new(),
            branch: "main".into(),
        };
        let fin = run_finalize(&bp, &package_git, false).unwrap();
        assert!(fin.pulled && !fin.pushed && !fin.paused);
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "AAA one\nline two\n"
        );
    }

    // ── Review-incoming mode (pause + stage every incoming change) ────────────

    /// With review on, a *clean* incoming change (no conflict) still pauses and
    /// is staged as a suggestion to review — not auto-merged silently.
    #[test]
    fn review_mode_pauses_on_clean_incoming_change() {
        let (adir, a) = package_notebox(&[("note.typ", "alpha\nbeta\n")]);

        let pkg = tempfile::tempdir().unwrap();
        let base_pkg = pkg.path().join("base.zip");
        package::export(adir.path(), &base_pkg, None).unwrap();
        let bdir = tempfile::tempdir().unwrap();
        let bp = bdir.path().join("b");
        receive_as_notebox(&base_pkg, &bp);

        // A edits the note (B has no local edit → a clean, fast-forwardable pull).
        std::fs::write(adir.path().join("note.typ"), "ALPHA\nbeta\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        let update_pkg = pkg.path().join("update.zip");
        package::export(adir.path(), &update_pkg, None).unwrap();

        // Import with review on → pause + a staged suggestion (would auto-merge
        // without review).
        let out = reconcile_package_review(&update_pkg, &bp, true);
        assert!(out.paused, "review pauses even on a clean change");
        assert_eq!(out.conflicts.len(), 1);
        assert!(out.conflicts[0].staged_path.is_some());

        // Accept the suggestion and finalize → the incoming edit lands.
        let rel = Path::new("note.typ");
        let staged = staging::read_staged(&bp, rel).unwrap().unwrap();
        std::fs::write(
            staging::staged_path(&bp, rel),
            resolve_all_suggestions(&staged, true),
        )
        .unwrap();
        let package_git = NoteboxGitConfig {
            remote: String::new(),
            branch: "main".into(),
        };
        run_finalize(&bp, &package_git, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "ALPHA\nbeta\n"
        );
    }

    /// The load-bearing guarantee: in review mode, accepting an incoming change
    /// to a note the importer *also* edited (a different region — clean merge)
    /// keeps the local edit. The suggestion is rendered mine→merged, so accept
    /// takes theirs without discarding mine.
    #[test]
    fn review_mode_accept_preserves_local_edit_on_clean_merge() {
        let (adir, a) = package_notebox(&[("note.typ", "line1\nline2\nline3\n")]);

        let pkg = tempfile::tempdir().unwrap();
        let base_pkg = pkg.path().join("base.zip");
        package::export(adir.path(), &base_pkg, None).unwrap();
        let bdir = tempfile::tempdir().unwrap();
        let bp = bdir.path().join("b");
        receive_as_notebox(&base_pkg, &bp);

        // A changes the first line; B changes the last line (different regions →
        // a clean 3-way merge).
        std::fs::write(adir.path().join("note.typ"), "AAA\nline2\nline3\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        let update_pkg = pkg.path().join("update.zip");
        package::export(adir.path(), &update_pkg, None).unwrap();

        std::fs::write(bp.join("note.typ"), "line1\nline2\nBBB\n").unwrap();
        let out = reconcile_package_review(&update_pkg, &bp, true);
        assert!(out.paused);
        assert_eq!(out.conflicts.len(), 1);

        // Accept-all → takes A's first-line change AND keeps B's last-line edit.
        let rel = Path::new("note.typ");
        let staged = staging::read_staged(&bp, rel).unwrap().unwrap();
        std::fs::write(
            staging::staged_path(&bp, rel),
            resolve_all_suggestions(&staged, true),
        )
        .unwrap();
        let package_git = NoteboxGitConfig {
            remote: String::new(),
            branch: "main".into(),
        };
        run_finalize(&bp, &package_git, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "AAA\nline2\nBBB\n",
            "review-mode accept must not drop the local edit"
        );
    }
}
