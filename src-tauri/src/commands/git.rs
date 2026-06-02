//! IPC commands for notebox-level git collaboration.
//!
//! The collaboration model is **merge-first** (see [`run_sync`]): a Sync /
//! package import always folds incoming changes into the working tree (taking
//! *theirs* on an overlap) and never pauses for review. The user reviews and
//! reverts afterwards from the Changes pane — see [`git_changes_since_sync`],
//! [`git_note_sync_diff`], and the revert commands, backed by
//! [`crate::git::sync_review`].
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
    ensure_collaboration_gitignore, ChangeStatus, ChangedPath, CommitInfo, FileVersion, GitBackend,
    GitStatusSummary, MergeOutcome,
};
use crate::git::json_merge;
use crate::git::package;
use crate::notebox_settings::NoteboxGitConfig;
use crate::state::{AppState, NoteboxSession};
use crate::storage::traits::NoteboxStorage;
use crate::storage::to_frontend_string;
use crate::typst_pipeline::package_vendor;

/// The remote name InkyCap uses for a notebox's collaboration remote. The URL
/// lives in [`NoteboxGitConfig::remote`]; the named remote is created/synced
/// from it on each fetch so the command works without a separate setup step.
pub(crate) const REMOTE_NAME: &str = "origin";

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
/// the optional sign-in username + password and commit identity. Does **not**
/// touch notebox settings — the command persists those after this returns.
fn apply_setup(
    root: &Path,
    remote: &str,
    branch: &str,
    username: Option<&str>,
    password: Option<&str>,
    identity: Option<GitIdentity>,
) -> Result<GitSetupResult> {
    let initialized = !GitBackend::is_repo(root);
    let backend = GitBackend::open_or_init(root)?;
    ensure_collaboration_gitignore(root)?;
    // Package-handoff setup passes an empty remote (no server): skip the remote
    // and the sign-in credentials. The notebox is still a git repo — version
    // history and package export/import all work without one.
    if !remote.trim().is_empty() {
        backend.set_remote(REMOTE_NAME, remote)?;
    }
    // A freshly init'd repo defaults to `master`; make the first commit land on
    // the configured branch so the eventual push of `refs/heads/<branch>` has
    // something to send. No-op when an existing repo (with commits) is adopted.
    backend.ensure_initial_branch(branch)?;

    if !remote.trim().is_empty() {
        // Username + password are per-repository sign-in details (HTTPS). Only
        // write a non-empty value, so re-running setup to change the branch
        // doesn't wipe a previously-entered password the user left blank.
        if let Some(username) = username.filter(|u| !u.trim().is_empty()) {
            auth::set_username_for_remote(remote, username.trim())?;
        }
        if let Some(password) = password.filter(|p| !p.trim().is_empty()) {
            auth::set_remote_password(remote, password)?;
        }
    }
    // Commit identity is per-notebox (this machine), stored in local.json — not
    // keyed by remote — so two clones of one repo can commit as different people.
    if let Some(identity) = identity.filter(|i| i.is_complete()) {
        let mut local = crate::notebox_settings::load_local_state(root);
        local.git_identity = Some(identity);
        crate::notebox_settings::save_local_state(root, &local)?;
    }

    Ok(GitSetupResult {
        initialized,
        status: backend.status_summary()?,
    })
}

/// Turn the open notebox into a collaborative git repo and persist its
/// [`NoteboxGitConfig`]. Idempotent: re-running adopts the existing repo and
/// updates the remote/branch. Everything here is per-machine and stays out of
/// the shared, committed settings: the remote + branch live in the gitignored
/// `local.json`, the username in a per-installation store, the password in the
/// OS keychain, and the commit identity in its own per-installation store. The
/// notebox must be open.
#[tauri::command]
pub async fn git_setup_collaboration(
    remote: String,
    branch: Option<String>,
    identity_name: Option<String>,
    identity_email: Option<String>,
    username: Option<String>,
    password: Option<String>,
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
            username.as_deref(),
            password.as_deref(),
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
    // Package mode: "to share" = the working tree differs in *content* from the
    // last point we shared or received. Comparing commit oids would mislead — an
    // import writes a two-parent merge commit whose oid differs from the received
    // tip even when its content is identical, so an oid compare reports "changes
    // to share" forever and the same file ping-pongs between collaborators. The
    // export and the import both record their baseline (the shared / received
    // tip), and `changed_since` diffs the working tree against that baseline's
    // tree — so a pure receive with no local edits reports clean.
    let last_shared = crate::notebox_settings::load_local_state(root)
        .last_shared_oid
        .and_then(|s| git2::Oid::from_str(&s).ok());
    Ok(!backend.changed_since(last_shared)?.is_empty())
}

/// List the files an export/sync would carry to collaborators — the working
/// tree changed since the last share. Drives the "Changes to share" preview in
/// the collaboration panel. Empty when the notebox isn't a git repo or nothing
/// has changed since the last share.
#[tauri::command]
pub async fn git_changes_to_share(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<DigestEntry>> {
    let session = state.session(window.label()).await;
    let root = match session.notebox_root.read().await.clone() {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let git = match session.notebox_settings.read().await.git.clone() {
        Some(g) => g,
        None => return Ok(vec![]),
    };
    tokio::task::spawn_blocking(move || -> Result<Vec<DigestEntry>> {
        if !GitBackend::is_repo(&root) {
            return Ok(vec![]);
        }
        let backend = GitBackend::open(&root)?;
        // Baseline the diff against the last point collaborators received: the
        // last-exported HEAD (package mode, recorded in local.json) or the
        // upstream tip (server mode). `None` falls back to an empty tree, so a
        // never-shared notebox lists every file as an add.
        let base = if git.is_package_mode() {
            crate::notebox_settings::load_local_state(&root)
                .last_shared_oid
                .and_then(|s| git2::Oid::from_str(&s).ok())
        } else {
            backend.remote_tracking_oid(REMOTE_NAME, &git.branch)?
        };
        let mut out: Vec<DigestEntry> = backend
            .changed_since(base)?
            .into_iter()
            .map(digest_entry)
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("changes-to-share task failed: {e}")))?
}

/// One note that still carries unresolved `#suggestion(...)` tracked changes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedEntry {
    /// Absolute path (frontend string form) — lets the panel dedupe against an
    /// already-open tab when it opens the note for resolution.
    pub path: String,
    /// Notebox-relative path (frontend string form) — drives the displayed
    /// basename / title.
    pub rel_path: String,
    /// How many open suggestions the note still has.
    pub count: u32,
}

/// List the notes that still have unresolved `#suggestion(...)` tracked changes
/// awaiting **this user's** decision — the notebox-wide "changes to resolve"
/// signal. The metadata cache gives the candidate notes (those with any open
/// suggestion); each candidate's working source is then re-counted excluding
/// suggestions the local user authored themselves (their `by:` matches this
/// notebox's commit identity) — those are the user's to *send*, not to resolve.
/// Empty when the notebox isn't collaborative or nothing is outstanding.
#[tauri::command]
pub async fn git_unresolved_changes(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<UnresolvedEntry>> {
    let session = state.session(window.label()).await;
    let root = match session.notebox_root.read().await.clone() {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    // Only meaningful for a collaborative notebox — a solo notebox never has
    // incoming tracked changes to resolve.
    let remote = match session.notebox_settings.read().await.git.clone() {
        Some(g) => g.remote,
        None => return Ok(vec![]),
    };
    let cache = match state.metadata_cache.read().await.clone() {
        Some(c) => c,
        None => return Ok(vec![]),
    };
    let storage = match session.storage.read().await.clone() {
        Some(s) => s,
        None => return Ok(vec![]),
    };

    // The candidate notes (any open suggestion) + the local commit-author name,
    // both resolved off the async runtime.
    let cache_root = root.clone();
    let author_root = root.clone();
    let (candidates, me) = tokio::task::spawn_blocking(
        move || -> Result<(Vec<PathBuf>, String)> {
            let files = cache.load_notebox(&cache_root)?;
            let mut candidates: Vec<PathBuf> = files
                .into_values()
                .filter(|f| f.unresolved_suggestions > 0)
                .map(|f| f.path)
                .collect();
            candidates.sort();
            Ok((candidates, local_commit_author_name(&author_root, &remote)))
        },
    )
    .await
    .map_err(|e| InkyCapError::Git(format!("unresolved-changes task failed: {e}")))??;

    // Re-count each candidate's *own* suggestions from its working source,
    // dropping the ones the local user authored. Reads go through storage.
    let mut out = Vec::new();
    for rel in candidates {
        let source = storage.read_file(&rel).await.unwrap_or_default();
        let count = crate::typst_pipeline::suggestion::count_suggestions_by_others(&source, &me);
        if count > 0 {
            out.push(UnresolvedEntry {
                path: to_frontend_string(&root.join(&rel)),
                rel_path: to_frontend_string(&rel),
                count: count as u32,
            });
        }
    }
    Ok(out)
}

/// The notebox's chosen commit identity on this machine: the per-notebox value
/// in `local.json` if complete, else the legacy per-remote store (for noteboxes
/// set up before the identity moved per-notebox). `None` ⇒ fall back to git
/// config. Per-notebox so two clones of one repo can commit as different people.
fn resolved_local_identity(root: &Path, remote: &str) -> Option<GitIdentity> {
    if let Some(id) = crate::notebox_settings::load_local_state(root).git_identity {
        if id.is_complete() {
            return Some(id);
        }
    }
    if !remote.trim().is_empty() {
        if let Some(id) = auth::identity_for_remote(remote) {
            if id.is_complete() {
                return Some(id);
            }
        }
    }
    None
}

/// The commit-author name InkyCap stamps on this notebox's changes: the resolved
/// per-notebox identity if set, else the git-config `user.name` (repo, then
/// global). Mirrors [`git_default_commit_identity`] and the `by:` the frontend
/// writes onto a suggestion, so the two compare equal. Empty when unset.
fn local_commit_author_name(root: &Path, remote: &str) -> String {
    if let Some(id) = resolved_local_identity(root, remote) {
        return id.name;
    }
    GitBackend::open(root)
        .ok()
        .and_then(|b| b.config_identity())
        .map(|(name, _)| name)
        .unwrap_or_default()
}

/// Record the merge-first "Changes since last sync" baseline in the gitignored
/// `local.json`: `baseline` is the local HEAD as it stood *before* this sync
/// folded in incoming changes (the point a revert restores to), and
/// `conflicted` is the set of paths the sync resolved by taking *theirs* (so the
/// Changes pane can flag them for priority review). Called once per sync that
/// pulled, after the merge resolved.
fn record_sync_baseline(
    root: &Path,
    baseline: Option<git2::Oid>,
    conflicted: &[String],
) -> Result<()> {
    let mut local = crate::notebox_settings::load_local_state(root);
    local.last_sync_oid = baseline.map(|o| o.to_string());
    local.last_sync_conflicted = conflicted.to_vec();
    crate::notebox_settings::save_local_state(root, &local)
}

/// Record the current HEAD as the package-handoff "last shared" baseline in the
/// gitignored `local.json`, so the status reads "shared" until the next edit.
fn record_shared_head(backend: &GitBackend, root: &Path) -> Result<()> {
    let head = backend.current_head()?.map(|(_, oid)| oid.to_string());
    let mut local = crate::notebox_settings::load_local_state(root);
    local.last_shared_oid = head;
    crate::notebox_settings::save_local_state(root, &local)
}

/// Save the username + password for this notebox's repository (re-authenticate
/// without re-running full setup). The password lives only in the OS keychain
/// and the username in a per-installation store — never in settings or the repo.
#[tauri::command]
pub async fn git_sign_in(
    username: String,
    password: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<()> {
    let session = state.session(window.label()).await;
    let git = require_collaborative(&session).await?;
    if !username.trim().is_empty() {
        auth::set_username_for_remote(&git.remote, username.trim())?;
    }
    auth::set_remote_password(&git.remote, &password)
}

/// The saved sign-in username for a remote, for pre-filling the connect form.
/// Empty/absent when none was saved (a fresh setup, or an SSH-only notebox).
#[tauri::command]
pub async fn git_saved_username(remote: String) -> Result<Option<String>> {
    Ok(auth::username_for_remote(remote.trim()))
}

/// Stop collaborating on the open notebox: drop its [`NoteboxGitConfig`] and
/// clear any pending review staging. The `.git` directory and stored
/// credentials are left intact — disabling is reversible (re-run setup), and
/// the credentials are keyed by the remote, so reconnecting later finds them.
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
/// collaborator can join entirely in-app (no command-line git). Returns the
/// cloned notebox path (frontend form) for the caller to register and open.
/// Saves the optional sign-in username + password first so the clone can
/// authenticate; the cloned notebox opens non-collaborative until the user
/// confirms the reconnect offer (collaboration config is per-machine and does
/// not travel in the repo). Does not touch the currently-open notebox.
#[tauri::command]
pub async fn git_clone_notebox(
    remote: String,
    branch: Option<String>,
    dest: String,
    username: Option<String>,
    password: Option<String>,
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

    if let Some(username) = username.as_deref().filter(|u| !u.trim().is_empty()) {
        auth::set_username_for_remote(&remote, username.trim())?;
    }
    if let Some(password) = password.as_deref().filter(|p| !p.trim().is_empty()) {
        auth::set_remote_password(&remote, password)?;
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

/// Frontend status string for a changed path. `"renamed"` carries both paths
/// (the entry's `path` is the new location; `old_path` the previous one).
fn change_status_str(status: ChangeStatus) -> &'static str {
    match status {
        ChangeStatus::Added => "added",
        ChangeStatus::Modified => "modified",
        ChangeStatus::Deleted => "deleted",
        ChangeStatus::Renamed => "renamed",
    }
}

/// One incoming change in the post-sync digest ("what landed from others").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestEntry {
    /// Notebox-relative path (frontend string form); the *new* path for a rename.
    pub path: String,
    /// `"added"` | `"modified"` | `"deleted"` | `"renamed"`.
    pub status: String,
    /// For `"renamed"`, the previous path (frontend string form). `None` otherwise.
    pub old_path: Option<String>,
}

fn digest_entry(cp: ChangedPath) -> DigestEntry {
    DigestEntry {
        path: to_frontend_string(&cp.path),
        status: change_status_str(cp.status).to_string(),
        old_path: cp.old_path.as_deref().map(to_frontend_string),
    }
}

/// The result of a [`git_sync`] / [`git_check_updates`].
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
    /// What collaborators changed since the merge base — the non-blocking
    /// "what landed" summary.
    pub digest: Vec<DigestEntry>,
    /// Notebox-relative paths (frontend form) where the merge took *theirs* over
    /// an overlapping local edit. The merge-first model never pauses, so these
    /// are surfaced for after-the-fact review (the user can revert any of them
    /// from the Changes pane). Empty for a clean merge / fast-forward.
    pub conflicted: Vec<String>,
    /// The incoming tip commit's author/message, for the digest banner.
    pub incoming: Option<CommitInfo>,
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
/// remote-tracking ref already lives in `.git`.
///
/// Merge-first: this never pauses. Incoming changes always land (clean hunks
/// merge; overlapping edits take *theirs*), and the user reverts anything they
/// disagree with afterwards from the Changes pane — git history makes that
/// lossless.
fn run_sync(root: &Path, git: &NoteboxGitConfig, push: bool) -> Result<SyncOutcome> {
    let backend = GitBackend::open(root)?;
    // The per-notebox commit identity (local.json), resolved once for every
    // commit this sync makes.
    let identity = resolved_local_identity(root, &git.remote);
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
        let sig = backend.author_signature(identity.as_ref())?;
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

    // Record the pre-merge local tip as the "Changes since last sync" baseline
    // *before* the working tree changes, so the user can review and revert what
    // this sync brings in. The conflict branch overwrites the conflicted list
    // once it knows which paths took theirs; FF / clean merges leave it empty.
    record_sync_baseline(root, m, &[])?;

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
            let sig = backend.author_signature(identity.as_ref())?;
            backend.commit_tree(&merge_message(&out.incoming), &sig, tree, &[m, t])?;
            backend.checkout_head_force()?;
            out.pulled = true;
            if push {
                push_into(&backend, git, &mut out)?;
            }
            Ok(out)
        }
        MergeOutcome::Conflicts(_) => {
            // Merge-first: land the cleanly-merged files, then resolve every
            // remaining conflict in favour of *theirs* and commit — no pause.
            // `apply_clean_merge` writes the merged blob for non-conflicting
            // paths (hunk-level merges survive); conflicting notes are left at
            // *ours*, so we overwrite each with *theirs* below.
            let application = backend.apply_clean_merge(m, t)?;

            // settings.json keeps its structured key-level merge so distinct
            // config edits on both sides both survive; a same-key clash takes
            // theirs (consistent with the note path) rather than pausing.
            let settings_path = settings_rel();
            for rel in &application.conflicts {
                if *rel == settings_path {
                    merge_settings_favoring_theirs(&backend, root, m, t, base)?;
                } else {
                    // Take theirs for this conflicted note. The user reverts it
                    // from the Changes pane if they'd rather keep their version
                    // (recoverable: ours is preserved in history).
                    take_theirs_into_working(&backend, root, t, rel)?;
                    out.conflicted.push(to_frontend_string(rel));
                }
            }
            // Flag the take-theirs paths for priority review in the Changes pane.
            record_sync_baseline(root, Some(m), &out.conflicted)?;

            // The working tree is now the full merged result — commit it as a
            // two-parent merge commit so the push fast-forwards the remote.
            let sig = backend.author_signature(identity.as_ref())?;
            backend.stage_all()?;
            let tree = backend.write_index_tree()?;
            backend.commit_tree(&merge_message(&out.incoming), &sig, tree, &[m, t])?;
            backend.checkout_head_force()?;
            out.pulled = true;
            if push {
                push_into(&backend, git, &mut out)?;
            }
            Ok(out)
        }
    }
}

/// Overwrite a conflicted note in the working tree with *theirs* (the incoming
/// blob), or delete it when theirs removed it. The merge-first path uses this to
/// resolve a conflict without pausing — the incoming content wins, and the user
/// reverts from the Changes pane if they disagree. A git-level working-tree
/// write (like [`GitBackend::apply_clean_merge`]), so it bypasses
/// `NoteboxStorage` deliberately.
fn take_theirs_into_working(
    backend: &GitBackend,
    root: &Path,
    theirs: git2::Oid,
    rel: &Path,
) -> Result<()> {
    // Defense in depth: never write through a path that escapes the root.
    if rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Ok(());
    }
    let dest = root.join(rel);
    match backend.read_blob_at(theirs, rel)? {
        Some(bytes) => {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, bytes)?;
        }
        None => {
            // Theirs deleted it — a delete/modify conflict resolves to the
            // deletion under the take-theirs rule.
            if dest.exists() {
                std::fs::remove_file(&dest)?;
            }
        }
    }
    Ok(())
}

/// Structurally merge a conflicted `settings.json`, taking *theirs* for any
/// same-key clash (distinct-key edits on both sides still both survive), and
/// write the result over the working file. The merge-first counterpart of
/// [`auto_merge_settings`], which instead held clashes back for a hand pick.
fn merge_settings_favoring_theirs(
    backend: &GitBackend,
    root: &Path,
    m: git2::Oid,
    t: git2::Oid,
    base: Option<git2::Oid>,
) -> Result<()> {
    let rel = settings_rel();
    let mine = read_settings_json(backend, Some(m), &rel);
    let theirs = read_settings_json(backend, Some(t), &rel);
    let base_v = read_settings_json(backend, base, &rel);

    let merge = json_merge::three_way(&base_v, &mine, &theirs);
    let mut merged = merge.merged;
    for c in &merge.conflicts {
        json_merge::set_at_path(&mut merged, &c.path, c.theirs.clone());
    }
    write_merged_settings(root, &merged)?;
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

/// Sync the collaborative notebox: pull + merge incoming changes, then push.
/// Merge-first — never pauses; overlapping edits take *theirs* and the user
/// reverts afterwards from the Changes pane.
#[tauri::command]
pub async fn git_sync(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<SyncOutcome> {
    let session = state.session(window.label()).await;
    let (root, git) = require_collaborative_with_root(&session).await?;
    emit_git(&app_handle, window.label(), "notebox:git-fetch-started", ());
    let result = tokio::task::spawn_blocking(move || run_sync(&root, &git, true))
        .await
        .map_err(|e| InkyCapError::Git(format!("sync task failed: {e}")))?;
    emit_sync_events(&app_handle, window.label(), &result);
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
    emit_git(&app_handle, window.label(), "notebox:git-fetch-started", ());
    let result = tokio::task::spawn_blocking(move || run_check(&root, &git))
        .await
        .map_err(|e| InkyCapError::Git(format!("check task failed: {e}")))?;
    match &result {
        Ok(_) => {
            emit_git(&app_handle, window.label(), "notebox:git-fetch-completed", ());
        }
        Err(err) => {
            emit_git(&app_handle, window.label(), "notebox:git-error", err.to_string());
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

/// Translate a sync result into the `notebox:git-*` event vocabulary the store
/// listens on (completion + a friendly error on rejection/failure). Scoped to
/// the `window` that ran the gesture — these events carry no notebox path, so
/// other windows can't self-scope them; broadcasting would make a sync in one
/// window light up every other window's status. See [`emit_git`].
fn emit_sync_events(app_handle: &tauri::AppHandle, window: &str, result: &Result<SyncOutcome>) {
    match result {
        Ok(r) if r.rejected => {
            emit_git(
                app_handle,
                window,
                "notebox:git-error",
                "the remote moved while syncing — sync again",
            );
        }
        Ok(_) => {
            emit_git(app_handle, window, "notebox:git-fetch-completed", ());
            emit_git(app_handle, window, "notebox:git-push-completed", ());
        }
        Err(err) => {
            emit_git(app_handle, window, "notebox:git-error", err.to_string());
        }
    }
}

/// Emit a `notebox:git-*` event to a single window's webview. Git status/spinner
/// events are per-notebox and carry no path the frontend could filter on, so
/// they must target the owning window rather than broadcast to all of them
/// (otherwise syncing in one open notebox visibly drives every other one).
fn emit_git<S: serde::Serialize + Clone>(
    app_handle: &tauri::AppHandle,
    window: &str,
    event: &str,
    payload: S,
) {
    let _ = app_handle.emit_to(window, event, payload);
}

// ──────────────── Structured settings.json merge (used by run_sync) ─────────

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
    let rel_frontend = to_frontend_string(&rel);
    tokio::task::spawn_blocking(move || -> Result<Vec<FileVersion>> {
        if !GitBackend::is_repo(&root) {
            return Ok(Vec::new());
        }
        let mut versions = GitBackend::open(&root)?.file_history(&rel, 200)?;
        // If the last sync resolved this note by taking *theirs* over the user's
        // overlapping edit, flag the user's pre-sync version (the `last_sync_oid`
        // commit) so the History view can mark "this is what the merge replaced —
        // click to compare with the current note". `last_sync_oid` is the local
        // tip recorded just before the merge, so its blob is the user's version.
        let local = crate::notebox_settings::load_local_state(&root);
        let took_theirs = local.last_sync_conflicted.iter().any(|p| *p == rel_frontend);
        if took_theirs {
            if let Some(baseline) = local.last_sync_oid {
                for v in &mut versions {
                    if v.commit == baseline {
                        v.took_theirs_baseline = true;
                        break;
                    }
                }
            }
        }
        Ok(versions)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("history task failed: {e}")))?
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

/// A note's UTF-8 content at a specific past commit, for the read-only
/// version-compare (diff) view. `commit` is a full hash from
/// [`git_note_history`]. Errors if the version is absent or not valid UTF-8.
#[tauri::command]
pub async fn git_note_version_text(
    path: String,
    commit: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String> {
    let session = state.session(window.label()).await;
    let (root, _git) = require_collaborative_with_root(&session).await?;
    let rel = notebox_relative(&root, &path);
    tokio::task::spawn_blocking(move || -> Result<String> {
        let backend = GitBackend::open(&root)?;
        read_version_text(&backend, parse_commit(&commit)?, &rel)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("version-text task failed: {e}")))?
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

// ──────────────────── Merge-first: Changes since last sync ──────────────────
//
// The merge-first model never pauses: a Sync / import always lands incoming
// changes (taking *theirs* on an overlap) and the user reviews and reverts
// afterwards. These commands back that "revert later" surface. They diff each
// note against the baseline recorded in `local.json` (`last_sync_oid` — the
// local HEAD before the last sync) and let the user restore the baseline form
// of a whole note or a single hunk. History stays intact: a revert is an
// ordinary edit the user then re-syncs.

/// The recorded "Changes since last sync" baseline commit, or `None` when no
/// incoming merge has happened on this machine yet.
fn sync_baseline_oid(root: &Path) -> Option<git2::Oid> {
    crate::notebox_settings::load_local_state(root)
        .last_sync_oid
        .and_then(|s| git2::Oid::from_str(&s).ok())
}

/// One note that changed in the last sync — the notebox-wide "review what
/// landed" list and indicator.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SinceSyncEntry {
    /// Absolute path (frontend string form) — lets the panel dedupe against an
    /// already-open tab when it opens the note for review.
    pub path: String,
    /// Notebox-relative path (frontend string form) — drives the displayed title.
    /// The *new* path for a rename.
    pub rel_path: String,
    /// `"added"` | `"modified"` | `"deleted"` | `"renamed"`.
    pub status: String,
    /// For `"renamed"`, the previous notebox-relative path (frontend form).
    pub old_rel_path: Option<String>,
    /// The sync resolved this path by taking *theirs* over an overlapping local
    /// edit — flagged for priority review.
    pub conflicted: bool,
}

/// List the notes the most recent sync changed, relative to the recorded
/// pre-sync baseline (`last_sync_oid` → current HEAD), each flagged whether the
/// merge took theirs over a local edit. Drives the notebox-wide Changes list and
/// the status-bar / panel indicator. Empty when nothing has been synced yet, the
/// notebox isn't a repo, or the last sync changed nothing locally.
#[tauri::command]
pub async fn git_changes_since_sync(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<SinceSyncEntry>> {
    let session = state.session(window.label()).await;
    let root = match session.notebox_root.read().await.clone() {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    if session.notebox_settings.read().await.git.is_none() {
        return Ok(vec![]);
    }
    tokio::task::spawn_blocking(move || -> Result<Vec<SinceSyncEntry>> {
        if !GitBackend::is_repo(&root) {
            return Ok(vec![]);
        }
        let baseline = match sync_baseline_oid(&root) {
            Some(oid) => oid,
            None => return Ok(vec![]),
        };
        let backend = GitBackend::open(&root)?;
        let head = match backend.current_head()? {
            Some((_, oid)) => oid,
            None => return Ok(vec![]),
        };
        let conflicted: std::collections::HashSet<String> =
            crate::notebox_settings::load_local_state(&root)
                .last_sync_conflicted
                .into_iter()
                .collect();
        let mut out: Vec<SinceSyncEntry> = backend
            .changed_paths(Some(baseline), head)?
            .into_iter()
            .map(|cp| {
                let rel_path = to_frontend_string(&cp.path);
                let conflicted = conflicted.contains(&rel_path);
                SinceSyncEntry {
                    path: to_frontend_string(&root.join(&cp.path)),
                    rel_path,
                    status: change_status_str(cp.status).to_string(),
                    old_rel_path: cp.old_path.as_deref().map(to_frontend_string),
                    conflicted,
                }
            })
            .collect();
        // Conflicted (took theirs) first, then alphabetical — the riskiest
        // changes surface at the top of the review list.
        out.sort_by(|a, b| {
            b.conflicted
                .cmp(&a.conflicted)
                .then_with(|| a.rel_path.cmp(&b.rel_path))
        });
        Ok(out)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("changes-since-sync task failed: {e}")))?
}

/// One note's hunk-level review, split by *where each change came from*. The
/// last sync is the dividing line: the merge commit (HEAD) holds what the sync
/// brought in, and any working-tree edits on top of it are the user's own work
/// since. Keeping the two apart stops a user's own new note/edit from being
/// labelled "incoming" (it isn't), which the single-baseline view conflated.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNoteDiff {
    /// Changes the last sync folded in: pre-sync baseline (`last_sync_oid`) →
    /// HEAD. These are *theirs* — what to review and possibly revert.
    pub incoming: Vec<crate::git::sync_review::SyncHunk>,
    /// The user's own uncommitted edits since the sync: HEAD → working text.
    /// Informational (no revert) — your own in-progress work, not something the
    /// sync did.
    pub local: Vec<crate::git::sync_review::SyncHunk>,
    /// The sync *added* this note (it had no pre-sync version). The frontend
    /// shows a single "added" status under Incoming instead of a whole-file hunk
    /// whose first line is the (auto-managed) import preamble.
    pub incoming_created: bool,
    /// The note is brand-new local work, not yet in HEAD. The frontend shows a
    /// single "created" status under Local activity for the same reason.
    pub local_created: bool,
}

/// Review one note's changes since the last sync, split into incoming (theirs,
/// `last_sync_oid` → HEAD) and local (yours, HEAD → working). Empty when nothing
/// has been synced on this machine yet. The import preamble is filtered from
/// both sides — it is auto-managed, never a reviewable change.
#[tauri::command]
pub async fn git_note_sync_diff(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<SyncNoteDiff> {
    let session = state.session(window.label()).await;
    let (root, _git) = require_collaborative_with_root(&session).await?;
    let storage = session
        .storage
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    let rel = notebox_relative(&root, &path);

    // "Since last sync" is only meaningful once a sync has happened on this
    // machine. With no recorded baseline, the review surface is empty (mirrors
    // the notebox-wide changes-since-sync list).
    let has_baseline = {
        let root = root.clone();
        tokio::task::spawn_blocking(move || sync_baseline_oid(&root).is_some())
            .await
            .map_err(|e| InkyCapError::Git(format!("baseline-probe task failed: {e}")))?
    };
    if !has_baseline {
        return Ok(SyncNoteDiff::default());
    }

    let working = storage.read_file(&rel).await.unwrap_or_default();
    let last_sync = read_sync_baseline_text(&root, &rel).await?;
    let head = read_head_text(&root, &rel).await?;
    let diff = tokio::task::spawn_blocking(move || {
        let filt = |hs| {
            crate::git::sync_review::drop_structural_hunks(
                hs,
                crate::notebox_package::is_notebox_import_line,
            )
        };
        let incoming_created = last_sync.trim().is_empty() && !head.trim().is_empty();
        let local_created = head.trim().is_empty() && !working.trim().is_empty();
        SyncNoteDiff {
            // A wholly-new note is reported via its *_created flag, not as a
            // whole-file "added" hunk (whose preview would be the import line).
            incoming: if incoming_created {
                Vec::new()
            } else {
                filt(crate::git::sync_review::diff_hunks(&last_sync, &head))
            },
            local: if local_created {
                Vec::new()
            } else {
                filt(crate::git::sync_review::diff_hunks(&head, &working))
            },
            incoming_created,
            local_created,
        }
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("sync-diff task failed: {e}")))?;
    Ok(diff)
}

/// Read a note's text at the current HEAD commit. Empty when HEAD has no such
/// note (a brand-new, not-yet-committed file) or the branch is unborn.
async fn read_head_text(root: &Path, rel: &Path) -> Result<String> {
    let root = root.to_path_buf();
    let rel = rel.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        let backend = GitBackend::open(&root)?;
        let head = match backend.current_head()? {
            Some((_, oid)) => oid,
            None => return Ok(String::new()),
        };
        Ok(backend
            .read_blob_at(head, &rel)?
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default())
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("head-read task failed: {e}")))?
}

/// Read a note's text at the pre-sync baseline. Empty string when nothing has
/// been synced yet or the note did not exist in the baseline (incoming added
/// it) — both mean "nothing to revert to," which the hunk engine handles.
async fn read_sync_baseline_text(root: &Path, rel: &Path) -> Result<String> {
    let root = root.to_path_buf();
    let rel = rel.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String> {
        let baseline = match sync_baseline_oid(&root) {
            Some(oid) => oid,
            None => return Ok(String::new()),
        };
        let backend = GitBackend::open(&root)?;
        Ok(backend
            .read_blob_at(baseline, &rel)?
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default())
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("baseline-read task failed: {e}")))?
}

/// Revert a single hunk of a note to its pre-sync baseline form, leaving the
/// note's other changes intact. `currentStart`/`currentEnd` identify the hunk by
/// its current-side line range (from [`git_note_sync_diff`]). The write goes
/// through [`NoteboxStorage`] as an ordinary edit. Errors with a 400 when the
/// range no longer matches a hunk (the note changed since the diff — refetch).
#[tauri::command]
pub async fn git_revert_sync_hunk(
    path: String,
    current_start: usize,
    current_end: usize,
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

    let current = storage.read_file(&rel).await?;
    let baseline = read_sync_baseline_text(&root, &rel).await?;
    let reverted = tokio::task::spawn_blocking(move || {
        crate::git::sync_review::revert_hunk(&baseline, &current, current_start, current_end)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("revert-hunk task failed: {e}")))?
    .ok_or_else(|| {
        InkyCapError::BadRequest("that change no longer matches the note — refresh and try again".into())
    })?;

    storage.write_file(&rel, &reverted).await?;
    Ok(())
}

/// Revert a whole note to its pre-sync baseline: restore the baseline content,
/// or delete the note when the sync *added* it (it has no baseline version).
/// The write goes through [`NoteboxStorage`] as an ordinary edit; history is
/// untouched and the revert becomes a change the user then re-syncs.
#[tauri::command]
pub async fn git_revert_note_since_sync(
    path: String,
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

    // Was the note present in the baseline? Read its bytes (None = the sync
    // added it, so reverting means removing it).
    let read_rel = rel.clone();
    let read_root = root.clone();
    let baseline_bytes = tokio::task::spawn_blocking(move || -> Result<Option<Vec<u8>>> {
        match sync_baseline_oid(&read_root) {
            Some(oid) => GitBackend::open(&read_root)?.read_blob_at(oid, &read_rel),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("baseline-read task failed: {e}")))??;

    match baseline_bytes {
        Some(bytes) => {
            let content = String::from_utf8(bytes).map_err(|_| {
                InkyCapError::BadRequest("the baseline version of the note could not be read".into())
            })?;
            storage.write_file(&rel, &content).await?;
        }
        None => {
            if storage.exists(&rel).await {
                storage.delete_file(&rel).await?;
            }
        }
    }
    Ok(())
}

// ─────────────────────────── Identity & review session ─────────────────────

/// Set the commit identity for *this* notebox. Stored per-notebox in the
/// gitignored `local.json` (never enters the repo, never travels), so two clones
/// of one repo on a machine can commit as different people.
#[tauri::command]
pub async fn git_set_identity(
    name: String,
    email: String,
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
    let id = GitIdentity { name, email };
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut local = crate::notebox_settings::load_local_state(&root);
        local.git_identity = id.is_complete().then_some(id);
        crate::notebox_settings::save_local_state(&root, &local)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("set-identity task failed: {e}")))?
}

/// The commit identity configured for this notebox, if any (for the setup UI to
/// display / seed). Per-notebox (local.json), with the legacy per-remote store
/// as a fallback for noteboxes set up before the move.
#[tauri::command]
pub async fn git_get_identity(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Option<GitIdentity>> {
    let session = state.session(window.label()).await;
    let git = require_collaborative(&session).await?;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    Ok(tokio::task::spawn_blocking(move || resolved_local_identity(&root, &git.remote))
        .await
        .map_err(|e| InkyCapError::Git(format!("get-identity task failed: {e}")))?)
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
        // 1. The identity already chosen for this notebox (local.json, with the
        //    legacy per-remote store as a fallback), if complete.
        if let Some(root) = &root {
            if let Some(id) = resolved_local_identity(root, remote.as_deref().unwrap_or("")) {
                return Ok(Some(id));
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
    let remote = git.remote.clone();

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
                let identity = resolved_local_identity(&root, &remote);
                let sig = backend.author_signature(identity.as_ref())?;
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
    emit_git(&app_handle, window.label(), "notebox:git-fetch-started", ());

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
        let outcome = run_sync(&root, &tmp_git, false)?;
        // Record the *received* tip as the package-handoff baseline. After
        // importing, we're even with what the sender gave us, so the status
        // reads "shared" until a new local edit — without this the import's
        // merge commit looks like an unshared change forever, and the same file
        // ping-pongs between collaborators (the never-ending-share bug). Using
        // the received tip (not local HEAD) means a user who had their *own*
        // unshared edits still correctly sees "changes to share" for those.
        let backend = GitBackend::open(&root)?;
        if let Some(t) = backend.remote_tracking_oid(REMOTE_NAME, &git.branch)? {
            let mut local = crate::notebox_settings::load_local_state(&root);
            local.last_shared_oid = Some(t.to_string());
            crate::notebox_settings::save_local_state(&root, &local)?;
        }
        drop(staging);
        Ok(outcome)
    })
    .await
    .map_err(|e| InkyCapError::Git(format!("import task failed: {e}")))?;
    emit_sync_events(&app_handle, window.label(), &result);
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
        apply_setup(&setup_root, "", &setup_branch, None, None, identity)
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
    use std::path::PathBuf;

    fn sig() -> git2::Signature<'static> {
        git2::Signature::now("Reviewer", "rev@example.com").unwrap()
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
        let asig = a.author_signature(None).unwrap();
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
            let s = g.author_signature(None).unwrap();
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
        let result = apply_setup(root, url, "main", None, None, None).unwrap();
        assert!(result.initialized, "a non-repo should be git-init'd");

        // It is now a repo, has the managed .gitignore, and origin points at url.
        assert!(GitBackend::is_repo(root));
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.contains(".inkycap/incoming/"), "staging ignored");
        let backend = GitBackend::open(root).unwrap();
        assert_eq!(backend.remote_url(REMOTE_NAME).as_deref(), Some(url));

        // Re-running adopts the existing repo (no second init) and is idempotent.
        let again = apply_setup(root, url, "main", None, None, None).unwrap();
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
        apply_setup(root, url, "main", None, None, None).unwrap();
        set_git_identity(root);
        let backend = GitBackend::open(root).unwrap();

        std::fs::write(root.join("note.typ"), "hello\n").unwrap();
        backend.stage_all().unwrap();
        let sig = backend.author_signature(None).unwrap();
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
        let sig = a.author_signature(None).unwrap();
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

    // ── Phase 5: Sync model (run_sync) ────────────────────────────────────────

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
        a.commit("base", &a.author_signature(None).unwrap()).unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
    }

    fn commit_push(a: &GitBackend, apath: &Path, url: &str, file: &str, content: &str) {
        std::fs::write(apath.join(file), content).unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &a.author_signature(None).unwrap())
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
        let out = run_sync(&bp, &git, true).unwrap();
        assert!(out.committed && out.pulled && out.pushed);
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

    /// Same-region edits conflict: merge-first takes *theirs*, commits, and
    /// pushes — no pause. The overlap is flagged in `conflicted` so the user can
    /// revert it from the Changes pane if they'd rather keep their version.
    #[test]
    fn sync_conflict_takes_theirs_and_pushes() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("note.typ", "line one\nline two\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        commit_push(&a, &ap, &url, "note.typ", "AAA one\nline two\n");

        // B rewrites the same line (uncommitted) and syncs → take theirs, push.
        std::fs::write(bp.join("note.typ"), "BBB one\nline two\n").unwrap();
        let out = run_sync(&bp, &git, true).unwrap();
        assert!(out.pulled && out.pushed);
        assert_eq!(
            out.conflicted,
            vec!["note.typ".to_string()],
            "the overlapping note is flagged for after-the-fact review"
        );
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "AAA one\nline two\n"
        );

        // A third clone sees theirs.
        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(
            std::fs::read_to_string(cp.join("note.typ")).unwrap(),
            "AAA one\nline two\n"
        );
    }

    /// A take-theirs sync records the "Changes since last sync" baseline: the
    /// pre-merge local tip is stored, the conflicted path is flagged, and the
    /// baseline→HEAD diff (what `git_changes_since_sync` reports) lists the note.
    #[test]
    fn sync_records_changes_since_baseline() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("note.typ", "line one\nline two\n")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        commit_push(&a, &ap, &url, "note.typ", "AAA one\nline two\n");
        std::fs::write(bp.join("note.typ"), "BBB one\nline two\n").unwrap();
        run_sync(&bp, &git, true).unwrap();

        let local = crate::notebox_settings::load_local_state(&bp);
        let baseline = local
            .last_sync_oid
            .as_deref()
            .and_then(|s| git2::Oid::from_str(s).ok())
            .expect("baseline recorded");
        assert_eq!(
            local.last_sync_conflicted,
            vec!["note.typ".to_string()],
            "the take-theirs note is flagged for review"
        );

        // The baseline is B's pre-merge tip (a parent of the new merge HEAD).
        let backend = GitBackend::open(&bp).unwrap();
        let head = backend.current_head().unwrap().unwrap().1;
        assert_ne!(baseline, head, "baseline is before the merge commit");
        let changed = backend.changed_paths(Some(baseline), head).unwrap();
        assert!(
            changed.iter().any(|c| c.path == Path::new("note.typ")),
            "the note shows as changed since the baseline"
        );
    }

    /// Both sides change the same binary → merge-first takes *theirs* (whole
    /// file) and pushes; the path is flagged in `conflicted`. The user reverts
    /// from the Changes pane to get their version back (preserved in history).
    #[test]
    fn binary_conflict_takes_theirs() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed(&a, &ap, &url, &[("note.typ", "n\n"), ("img.bin", "BASE")]);
        let (_bd, bp, _b) = clone_at(&url, "b");

        // A changes the binary and pushes; B changes it differently (uncommitted).
        commit_push(&a, &ap, &url, "img.bin", "THEIRS");
        std::fs::write(bp.join("img.bin"), "MINE").unwrap();

        let out = run_sync(&bp, &git, true).unwrap();
        assert!(out.pulled && out.pushed);
        assert!(
            out.conflicted.iter().any(|p| p.ends_with("img.bin")),
            "the binary overlap is flagged"
        );
        // Merge-first takes theirs for the conflicted binary.
        assert_eq!(std::fs::read(bp.join("img.bin")).unwrap(), b"THEIRS");

        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(std::fs::read(cp.join("img.bin")).unwrap(), b"THEIRS");
    }

    /// Seed a single-line `settings.json` (so a both-sides edit forces a git
    /// conflict on the one line, exercising the structured merge) plus a note.
    fn seed_settings(a: &GitBackend, apath: &Path, url: &str, json: &str) {
        std::fs::create_dir_all(apath.join(".inkycap")).unwrap();
        std::fs::write(apath.join(".inkycap/settings.json"), json).unwrap();
        std::fs::write(apath.join("n.typ"), "n\n").unwrap();
        a.ensure_initial_branch("main").unwrap();
        a.stage_all().unwrap();
        a.commit("base", &a.author_signature(None).unwrap()).unwrap();
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
        a.commit("a-edit", &a.author_signature(None).unwrap())
            .unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
        std::fs::write(bp.join(".inkycap/settings.json"), r#"{"a":5,"b":2}"#).unwrap();

        let out = run_sync(&bp, &git, true).unwrap();
        assert!(
            out.pulled && out.pushed,
            "distinct-key settings edits merge automatically"
        );
        assert_eq!(read_settings(&bp), serde_json::json!({ "a": 5, "b": 9 }));

        // A third clone sees both edits.
        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(read_settings(&cp), serde_json::json!({ "a": 5, "b": 9 }));
    }

    /// Both sides set the *same* key differently → merge-first takes *theirs*
    /// for the clashing key (distinct-key edits still both survive) and pushes,
    /// with no pause.
    #[test]
    fn settings_same_key_clash_takes_theirs() {
        let (_bare, url) = bare_remote();
        let git = main_cfg(&url);
        let (_ad, ap, a) = clone_at(&url, "a");
        seed_settings(&a, &ap, &url, r#"{"view":"source"}"#);
        let (_bd, bp, _b) = clone_at(&url, "b");

        std::fs::write(ap.join(".inkycap/settings.json"), r#"{"view":"live"}"#).unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &a.author_signature(None).unwrap())
            .unwrap();
        assert!(!a.push(REMOTE_NAME, "main").unwrap().rejected);
        std::fs::write(bp.join(".inkycap/settings.json"), r#"{"view":"reading"}"#).unwrap();

        let out = run_sync(&bp, &git, true).unwrap();
        assert!(
            out.pulled && out.pushed,
            "merge-first resolves a same-key settings clash to theirs"
        );
        assert_eq!(read_settings(&bp), serde_json::json!({ "view": "live" }));

        let (_cd, cp, _c) = clone_at(&url, "c");
        assert_eq!(read_settings(&cp), serde_json::json!({ "view": "live" }));
    }

    /// Package mode (no remote): "unshared" is true while the working tree
    /// *content* differs from the last shared/received baseline, and resets once
    /// that baseline is recorded — so the status reads "Changes to share" →
    /// shared → "Changes to share" across an export-then-edit cycle. The check is
    /// content-based (not a commit-oid compare), which is what stops the
    /// never-ending-share loop where an import's merge commit looked unshared
    /// forever even with identical content.
    #[test]
    fn package_unshared_tracks_shared_baseline() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        git2::Repository::init(root).unwrap();
        set_git_identity(root);
        let backend = GitBackend::open(root).unwrap();
        // A real collaborative notebox gitignores `.inkycap/local.json`, so
        // recording the baseline (which writes local.json) is not itself a
        // change — the content-based check relies on that.
        crate::git::backend::ensure_collaboration_gitignore(root).unwrap();
        let git = NoteboxGitConfig {
            remote: String::new(),
            branch: "main".into(),
        };
        let sig = backend.author_signature(None).unwrap();

        std::fs::write(root.join("n.typ"), "one\n").unwrap();
        backend.stage_all().unwrap();
        backend.commit("c1", &sig).unwrap();

        // Nothing shared yet → unshared.
        let summary = backend.status_summary().unwrap();
        assert!(has_unshared_changes(&backend, root, &git, &summary).unwrap());

        // Record the export baseline → shared (content matches it).
        record_shared_head(&backend, root).unwrap();
        let summary = backend.status_summary().unwrap();
        assert!(!has_unshared_changes(&backend, root, &git, &summary).unwrap());

        // A new commit changes content past the baseline → unshared again.
        std::fs::write(root.join("n.typ"), "two\n").unwrap();
        backend.stage_all().unwrap();
        backend.commit("c2", &sig).unwrap();
        let summary2 = backend.status_summary().unwrap();
        assert!(has_unshared_changes(&backend, root, &git, &summary2).unwrap());

        // Re-record, then a dirty edit → unshared.
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
        let out = run_sync(&bp, &git, true).unwrap();
        assert!(out.pulled && !out.pushed && !out.committed);
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

        let out = run_sync(&bp, &git, true).unwrap();
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
        let out = run_sync(&bp, &git, true).unwrap();
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
        let staging = package::extract_to_temp(archive, None).unwrap();
        let tmp = NoteboxGitConfig {
            remote: staging.path().to_string_lossy().into_owned(),
            branch: "main".into(),
        };
        run_sync(into, &tmp, false).unwrap()
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
        assert!(out.committed && out.pulled && !out.pushed);
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

    /// A same-line conflict in a package import takes *theirs* and commits
    /// locally (no server, no pause) under the package-mode (empty-remote)
    /// config; the path is flagged in `conflicted`.
    #[test]
    fn package_handoff_conflict_takes_theirs() {
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
        assert!(out.pulled && !out.pushed);
        assert!(
            out.conflicted.iter().any(|p| p.ends_with("note.typ")),
            "the overlapping note is flagged"
        );
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "AAA one\nline two\n"
        );
    }

    // ── Review-incoming mode (pause + stage every incoming change) ────────────

    /// With review on, a *clean* incoming change (no conflict) still pauses and
    /// is staged as a suggestion to review — not auto-merged silently.
    #[test]
    fn merge_first_lands_clean_incoming_change_without_pausing() {
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

        // Even with the legacy `review` flag set, merge-first never pauses — the
        // incoming edit lands immediately.
        let out = reconcile_package(&update_pkg, &bp);
        assert!(out.pulled, "merge-first never pauses");
        assert!(out.conflicted.is_empty(), "a clean change is not a conflict");
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "ALPHA\nbeta\n"
        );
    }

    /// The load-bearing guarantee: an incoming change to a note the importer
    /// *also* edited in a different region merges cleanly and keeps *both*
    /// edits — merge-first only takes theirs when the regions actually overlap.
    #[test]
    fn merge_first_combines_nonoverlapping_edits() {
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
        let out = reconcile_package(&update_pkg, &bp);
        assert!(out.pulled);
        assert!(out.conflicted.is_empty(), "non-overlapping edits don't conflict");
        assert_eq!(
            std::fs::read_to_string(bp.join("note.typ")).unwrap(),
            "AAA\nline2\nBBB\n",
            "merge-first must not drop the local edit on a clean merge"
        );
    }
}
