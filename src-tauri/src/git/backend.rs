//! Thin synchronous wrapper over `git2` — the only place in InkyCap that
//! talks to libgit2.
//!
//! It exposes exactly the operations the collaboration loop needs and nothing
//! more: open/init, remote management, the head/status read used on notebox
//! open, the merge-base + blob reads that Phase 2's 3-way diff will run
//! against, and the stage/commit/fetch/push that Phase 3 will drive. There is
//! deliberately **no** high-level `pull`/`sync` — inline review always sits
//! between fetch and apply, so the steps stay separate.
//!
//! ## Threading
//! [`git2::Repository`] is `Send` but not `Sync`, so a `GitBackend` is **not**
//! stored in the shared [`crate::state::AppState`]. Callers open one per
//! operation from the notebox root (opening is cheap relative to a fetch) and
//! drop it. Network operations (`fetch`/`push`) block and should be run on a
//! blocking executor by their command.

use std::path::{Path, PathBuf};

use git2::{Oid, Repository};
use serde::Serialize;

use crate::errors::{InkyCapError, Result};

use super::auth;

/// A short, frontend-safe summary of a collaborative notebox's git state,
/// computed on notebox open. Carries no note content or filesystem paths.
#[derive(Debug, Clone, Default, Serialize)]
pub struct GitStatusSummary {
    /// Currently checked-out branch, if the head is born.
    pub branch: Option<String>,
    /// Short hash of the head commit, if any (`None` on an unborn branch).
    pub head: Option<String>,
    /// Working tree has uncommitted changes (tracked or untracked,
    /// gitignored files excluded).
    pub dirty: bool,
    /// Commits the local branch is ahead of its upstream (outgoing). `0` when
    /// there is no upstream tracking branch (e.g. before the first fetch).
    pub ahead: usize,
    /// Commits the local branch is behind its upstream (incoming). `0` when
    /// there is no upstream tracking branch.
    pub behind: usize,
    /// Commits present locally but not yet on the remote — what "Publish"
    /// would send. Unlike [`ahead`], this counts *all* local commits when the
    /// remote-tracking ref does not exist yet (never pushed/fetched), so the
    /// first publish is surfaced. Populated by the command layer (which knows
    /// the configured remote + branch); `0` from a bare [`status_summary`].
    pub unpushed: usize,
}

/// How a path changed between two commits (git rename detection is off, so a
/// rename appears as a `Deleted` + `Added` pair).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
}

/// Result of a 3-way merge ([`GitBackend::merge_commits_to_tree`]).
#[derive(Debug, Clone)]
pub enum MergeOutcome {
    /// Clean merge — the OID of the merged tree, ready to commit.
    Clean(Oid),
    /// Conflicting notebox-relative paths needing hand resolution.
    Conflicts(Vec<PathBuf>),
}

/// Result of materializing the *clean* portion of a conflicted 3-way merge into
/// the working tree ([`GitBackend::apply_clean_merge`]).
#[derive(Debug, Clone, Default)]
pub struct MergeApplication {
    /// Notebox-relative paths that conflict (left untouched in the working tree,
    /// still at *ours* — the review layer renders these as suggestions).
    pub conflicts: Vec<PathBuf>,
    /// Notebox-relative paths whose cleanly-merged result was written to (or
    /// removed from) the working tree.
    pub applied: Vec<PathBuf>,
}

/// One path that differs between two commit trees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedPath {
    /// Notebox-relative path.
    pub path: PathBuf,
    pub status: ChangeStatus,
}

/// Author + message of a commit — the review-context the loop harvests from
/// git (incoming = banner; outgoing = decision summary). Carries no note
/// content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitInfo {
    pub author_name: String,
    pub author_email: String,
    /// Commit time, seconds since the Unix epoch (UTC).
    pub timestamp: i64,
    pub message: String,
    /// Short hash (7 hex chars), matching git's default.
    pub short_hash: String,
}

/// One past version of a single file in the commit graph — a row in a note's
/// version history. Carries commit metadata only (no content); the content is
/// fetched on demand via [`GitBackend::read_blob_at`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    /// Full commit hash — the opaque handle for fetching/restoring this version.
    pub commit: String,
    /// Short hash (7 hex chars), matching git's default.
    pub short_hash: String,
    pub author_name: String,
    /// Commit time, seconds since the Unix epoch (UTC).
    pub timestamp: i64,
    pub message: String,
}

/// Open git repository rooted at a notebox.
pub struct GitBackend {
    repo: Repository,
    root: PathBuf,
}

impl GitBackend {
    /// Open the repository at `root`, initializing a fresh one if none exists.
    pub fn open_or_init(root: &Path) -> Result<Self> {
        let repo = match Repository::open(root) {
            Ok(repo) => repo,
            Err(_) => Repository::init(root)?,
        };
        Ok(Self {
            repo,
            root: root.to_path_buf(),
        })
    }

    /// Open an existing repository at `root`. Errors if `root` is not a git
    /// repository — use [`Self::is_repo`] first when that is expected.
    pub fn open(root: &Path) -> Result<Self> {
        let repo = Repository::open(root)?;
        Ok(Self {
            repo,
            root: root.to_path_buf(),
        })
    }

    /// Whether `root` is the top level of a git working tree. Distinguishes a
    /// collaborative notebox from a plain one without taking ownership.
    pub fn is_repo(root: &Path) -> bool {
        root.join(".git").exists()
    }

    /// Notebox root this backend was opened against.
    pub fn root(&self) -> &Path {
        &self.root
    }

    // ── Remotes ──────────────────────────────────────────────────────────

    /// Create the named remote, or update its URL if it already exists.
    pub fn set_remote(&self, name: &str, url: &str) -> Result<()> {
        match self.repo.find_remote(name) {
            Ok(_) => self.repo.remote_set_url(name, url)?,
            Err(_) => {
                self.repo.remote(name, url)?;
            }
        }
        Ok(())
    }

    /// URL of the named remote, if it exists (and is valid UTF-8).
    pub fn remote_url(&self, name: &str) -> Option<String> {
        self.repo
            .find_remote(name)
            .ok()
            .and_then(|r| r.url().ok().map(str::to_string))
    }

    // ── Head & status ────────────────────────────────────────────────────

    /// `(branch, head_oid)` of the current head, or `None` on an unborn
    /// branch (a freshly-`init`ed repo before its first commit).
    pub fn current_head(&self) -> Result<Option<(String, Oid)>> {
        match self.repo.head() {
            Ok(head) => {
                let branch = head.shorthand().unwrap_or("HEAD").to_string();
                let oid = head
                    .target()
                    .ok_or_else(|| InkyCapError::Git("head has no target".into()))?;
                Ok(Some((branch, oid)))
            }
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Summarize the repo state for display on notebox open.
    pub fn status_summary(&self) -> Result<GitStatusSummary> {
        let mut summary = GitStatusSummary::default();

        if let Some((branch, oid)) = self.current_head()? {
            summary.branch = Some(branch);
            // Short hash: first 7 hex chars, matching git's default.
            summary.head = Some(oid.to_string().chars().take(7).collect());

            // Ahead/behind vs. the upstream tracking branch, if one is set.
            if let Ok(head_ref) = self.repo.head() {
                if let Some(local_oid) = head_ref.target() {
                    if let Ok(branch_obj) = self
                        .repo
                        .find_branch(head_ref.shorthand().unwrap_or(""), git2::BranchType::Local)
                    {
                        if let Ok(upstream) = branch_obj.upstream() {
                            if let Some(up_oid) = upstream.get().target() {
                                if let Ok((ahead, behind)) =
                                    self.repo.graph_ahead_behind(local_oid, up_oid)
                                {
                                    summary.ahead = ahead;
                                    summary.behind = behind;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Dirty = any non-ignored status entry. Untracked files count as
        // dirty (a collaborator's new, unsaved note matters); ignored files
        // (staging, local.json, caches) do not.
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).include_ignored(false);
        let statuses = self.repo.statuses(Some(&mut opts))?;
        summary.dirty = !statuses.is_empty();

        Ok(summary)
    }

    // ── 3-way-diff inputs (Phase 2) ──────────────────────────────────────

    /// Best common ancestor of two commits — the merge base that makes a real
    /// 3-way merge possible. `None` when the histories are unrelated.
    pub fn merge_base(&self, a: Oid, b: Oid) -> Result<Option<Oid>> {
        match self.repo.merge_base(a, b) {
            Ok(oid) => Ok(Some(oid)),
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Resolve the tip of a remote-tracking branch
    /// (`refs/remotes/<remote>/<branch>`) to its commit OID. `None` until a
    /// fetch has populated it.
    pub fn remote_tracking_oid(&self, remote_name: &str, branch: &str) -> Result<Option<Oid>> {
        let refname = format!("refs/remotes/{remote_name}/{branch}");
        match self.repo.refname_to_id(&refname) {
            Ok(oid) => Ok(Some(oid)),
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Author + message of a commit, for the review banner / decision log.
    pub fn commit_info(&self, oid: Oid) -> Result<CommitInfo> {
        let commit = self.repo.find_commit(oid)?;
        let author = commit.author();
        Ok(CommitInfo {
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            timestamp: author.when().seconds(),
            message: commit.message().unwrap_or("").to_string(),
            short_hash: oid.to_string().chars().take(7).collect(),
        })
    }

    /// Paths that differ between two commit trees (`from` → `to`). `from` is
    /// `None` for an unborn local branch (everything in `to` is an add).
    /// Rename detection is off, so a rename surfaces as a delete + add.
    pub fn changed_paths(&self, from: Option<Oid>, to: Oid) -> Result<Vec<ChangedPath>> {
        let from_tree = match from {
            Some(oid) => Some(self.repo.find_commit(oid)?.tree()?),
            None => None,
        };
        let to_tree = self.repo.find_commit(to)?.tree()?;
        let diff = self
            .repo
            .diff_tree_to_tree(from_tree.as_ref(), Some(&to_tree), None)?;

        let mut out = Vec::new();
        for delta in diff.deltas() {
            let (status, file) = match delta.status() {
                git2::Delta::Added => (ChangeStatus::Added, delta.new_file()),
                git2::Delta::Deleted => (ChangeStatus::Deleted, delta.old_file()),
                git2::Delta::Modified => (ChangeStatus::Modified, delta.new_file()),
                // Treat anything else with a content change conservatively as a
                // modification of the new path; skip if it carries no path.
                _ => (ChangeStatus::Modified, delta.new_file()),
            };
            if let Some(path) = file.path() {
                out.push(ChangedPath {
                    path: path.to_path_buf(),
                    status,
                });
            }
        }
        Ok(out)
    }

    /// Read a file's bytes as of a specific commit, by notebox-relative path.
    /// `None` when the path does not exist in that commit's tree. Reads
    /// straight from git objects — the working tree is never touched.
    pub fn read_blob_at(&self, commit: Oid, rel: &Path) -> Result<Option<Vec<u8>>> {
        let tree = self.repo.find_commit(commit)?.tree()?;
        let entry = match tree.get_path(rel) {
            Ok(entry) => entry,
            Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let object = entry.to_object(&self.repo)?;
        Ok(object.as_blob().map(|b| b.content().to_vec()))
    }

    // ── Version history (Phase 6) ─────────────────────────────────────────

    /// The commits that changed `rel`, newest first, up to `limit` — a note's
    /// version history. Each entry's content is fetched on demand with
    /// [`Self::read_blob_at`]. Walks the first-parent-relative diff of each
    /// commit (a merge that altered the note relative to its first parent
    /// counts as a version). Returns an empty list on an unborn branch.
    pub fn file_history(&self, rel: &Path, limit: usize) -> Result<Vec<FileVersion>> {
        if self.current_head()?.is_none() {
            return Ok(Vec::new());
        }
        let mut walk = self.repo.revwalk()?;
        walk.push_head()?;
        walk.set_sorting(git2::Sort::TIME)?;

        let mut out = Vec::new();
        for oid in walk {
            if out.len() >= limit {
                break;
            }
            let oid = oid?;
            let commit = self.repo.find_commit(oid)?;
            if !commit_touched_path(&commit, rel)? {
                continue;
            }
            let author = commit.author();
            out.push(FileVersion {
                commit: oid.to_string(),
                short_hash: oid.to_string().chars().take(7).collect(),
                author_name: author.name().unwrap_or("").to_string(),
                timestamp: author.when().seconds(),
                message: commit.message().unwrap_or("").to_string(),
            });
        }
        Ok(out)
    }

    // ── Staging & commit (Phase 3) ───────────────────────────────────────

    /// Resolve the commit author for `remote`: the per-installation identity
    /// keyed by remote first, then git's own `user.name`/`user.email`
    /// (`.git/config` → `~/.gitconfig`). Errors when neither yields a complete
    /// name + email, so the caller can prompt rather than commit anonymously.
    pub fn author_signature(&self, remote: &str) -> Result<git2::Signature<'static>> {
        if let Some(id) = auth::identity_for_remote(remote) {
            if id.is_complete() {
                return Ok(git2::Signature::now(&id.name, &id.email)?);
            }
        }
        // Fall back to git's own configured identity.
        self.repo.signature().map_err(|_| {
            InkyCapError::Git(
                "no commit identity set for this notebox or in your git config".into(),
            )
        })
    }

    /// Stage notebox-relative paths into the index.
    pub fn stage_paths(&self, rels: &[PathBuf]) -> Result<()> {
        let mut index = self.repo.index()?;
        for rel in rels {
            index.add_path(rel)?;
        }
        index.write()?;
        Ok(())
    }

    /// On an unborn HEAD (a freshly initialized repo with no commits), point
    /// HEAD at `refs/heads/<branch>` so the first commit lands on the
    /// *configured* branch rather than libgit2's compiled-in default
    /// (`master`). No-op once a commit exists (an adopted repo keeps its branch).
    pub fn ensure_initial_branch(&self, branch: &str) -> Result<()> {
        if self.current_head()?.is_none() {
            self.repo.set_head(&format!("refs/heads/{branch}"))?;
        }
        Ok(())
    }

    /// Stage every working-tree change (additions, modifications, deletions),
    /// honouring `.gitignore` — the index image for a "publish my work" commit.
    /// `add_all` covers new/modified non-ignored files; `update_all` records
    /// deletions of tracked files.
    pub fn stage_all(&self) -> Result<()> {
        let mut index = self.repo.index()?;
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
        index.update_all(["*"].iter(), None)?;
        index.write()?;
        Ok(())
    }

    /// Count commits present locally but not yet on the remote — what a publish
    /// would send. When the remote-tracking ref exists, that's the ahead-count
    /// against it; before the first push/fetch it does not exist, so every
    /// commit reachable from HEAD is unpushed.
    pub fn unpushed_count(&self, remote_name: &str, branch: &str) -> Result<usize> {
        let head = match self.current_head()? {
            Some((_, oid)) => oid,
            None => return Ok(0),
        };
        match self.remote_tracking_oid(remote_name, branch)? {
            Some(up) => Ok(self.repo.graph_ahead_behind(head, up)?.0),
            None => {
                let mut walk = self.repo.revwalk()?;
                walk.push(head)?;
                Ok(walk.count())
            }
        }
    }

    // ── 3-way merge (Phase 5: the Sync model) ────────────────────────────
    //
    // Real git merge, not the rebase-onto-theirs of the retired consolidate
    // path: a merge commit with both tips as parents fast-forwards the remote
    // and is atomic (no partial-merge trap). `merge_commits_to_tree` does the
    // file-level 3-way; conflicts come back as paths for the suggestion UI.

    /// 3-way merge `ours` and `theirs` (libgit2 finds the common ancestor).
    /// Returns the merged tree to commit, or the conflicting notebox-relative
    /// paths. Operates in memory — the working tree is untouched.
    pub fn merge_commits_to_tree(&self, ours: Oid, theirs: Oid) -> Result<MergeOutcome> {
        let our_c = self.repo.find_commit(ours)?;
        let their_c = self.repo.find_commit(theirs)?;
        let mut idx = self.repo.merge_commits(&our_c, &their_c, None)?;
        if idx.has_conflicts() {
            let mut paths = Vec::new();
            for c in idx.conflicts()? {
                let c = c?;
                // Prefer whichever side carries the path; git stores it as raw
                // bytes (UTF-8 in practice for note paths). Lossy is fine here —
                // the value is only used as a relative-path identity for the UI.
                if let Some(entry) = c.our.or(c.their).or(c.ancestor) {
                    let p = PathBuf::from(String::from_utf8_lossy(&entry.path).into_owned());
                    if !paths.contains(&p) {
                        paths.push(p);
                    }
                }
            }
            return Ok(MergeOutcome::Conflicts(paths));
        }
        Ok(MergeOutcome::Clean(idx.write_tree_to(&self.repo)?))
    }

    /// Materialize the *cleanly-merged* portion of a 3-way merge of `ours`+
    /// `theirs` into the working tree, leaving conflicting paths untouched
    /// (still at *ours*) for the suggestion-review layer to render.
    ///
    /// Used on the conflict-pause path: the user sees every non-conflicting
    /// incoming change land immediately, and resolves only the conflicts. The
    /// merge is recomputed in memory (cheap); for every path *theirs* changed
    /// relative to the merge base that did **not** conflict, the merged blob is
    /// written to disk (or the file removed, for a clean deletion). This is a
    /// git-level checkout of part of a tree — the same kind of direct
    /// working-tree write [`Self::checkout_head_force`] performs — so it
    /// deliberately bypasses `NoteboxStorage`, which is for app-authored content.
    pub fn apply_clean_merge(&self, ours: Oid, theirs: Oid) -> Result<MergeApplication> {
        let our_c = self.repo.find_commit(ours)?;
        let their_c = self.repo.find_commit(theirs)?;
        let idx = self.repo.merge_commits(&our_c, &their_c, None)?;

        // Conflicting paths: any entry the merge index records at stage > 0.
        let mut conflicts: Vec<PathBuf> = Vec::new();
        for c in idx.conflicts()? {
            let c = c?;
            if let Some(entry) = c.our.as_ref().or(c.their.as_ref()).or(c.ancestor.as_ref()) {
                let p = PathBuf::from(String::from_utf8_lossy(&entry.path).into_owned());
                if !conflicts.contains(&p) {
                    conflicts.push(p);
                }
            }
        }

        // Only paths *theirs* changed (vs the merge base) can differ in the
        // merged result from *ours*; anything else the merge keeps at ours.
        let base = self.merge_base(ours, theirs)?;
        let mut applied = Vec::new();
        for cp in self.changed_paths(base, theirs)? {
            if conflicts.contains(&cp.path) {
                continue; // a conflicted path stays at ours until resolved
            }
            // Defense in depth: never write through a path that escapes the root.
            if cp.path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                continue;
            }
            let dest = self.root.join(&cp.path);
            match idx.get_path(&cp.path, 0) {
                Some(entry) => {
                    let blob = self.repo.find_blob(entry.id)?;
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&dest, blob.content())?;
                    applied.push(cp.path);
                }
                None => {
                    // Absent at stage 0 with no conflict ⇒ a clean deletion.
                    if dest.exists() {
                        std::fs::remove_file(&dest)?;
                        applied.push(cp.path);
                    }
                }
            }
        }
        Ok(MergeApplication { conflicts, applied })
    }

    /// Write the current index out as a tree object and return its OID — the
    /// merged tree to hand to [`Self::commit_tree`] after a conflict resolution
    /// has been staged into the working tree + index.
    pub fn write_index_tree(&self) -> Result<Oid> {
        let mut index = self.repo.index()?;
        Ok(index.write_tree()?)
    }

    /// Commit an explicit `tree` with the given `parents` (e.g. a two-parent
    /// merge commit), moving the current branch to it. Returns the new OID.
    pub fn commit_tree(
        &self,
        message: &str,
        author: &git2::Signature,
        tree: Oid,
        parents: &[Oid],
    ) -> Result<Oid> {
        let tree = self.repo.find_tree(tree)?;
        let parent_commits = parents
            .iter()
            .map(|p| self.repo.find_commit(*p))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        Ok(self
            .repo
            .commit(Some("HEAD"), author, author, message, &tree, &parent_refs)?)
    }

    /// Update the working tree (and index) to match HEAD. Called after a merge
    /// commit or a fast-forward, where local work is already committed so
    /// nothing uncommitted is at risk. Forced so the working tree ends up
    /// exactly matching HEAD.
    pub fn checkout_head_force(&self) -> Result<()> {
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        self.repo.checkout_head(Some(&mut co))?;
        Ok(())
    }

    /// Fast-forward the current branch to `target` and update the working tree.
    /// For a pure pull when local has not diverged. The caller has already
    /// committed local work, so the forced checkout discards nothing.
    pub fn fast_forward_checkout(&self, target: Oid) -> Result<()> {
        let mut head_ref = self.repo.head()?;
        head_ref.set_target(target, "fast-forward")?;
        self.checkout_head_force()
    }

    /// Commit whatever is currently staged in the index, with `author` as both
    /// author and committer. Parents are the current head (none on the first
    /// commit). Returns the new commit's OID.
    pub fn commit(&self, message: &str, author: &git2::Signature) -> Result<Oid> {
        let mut index = self.repo.index()?;
        let tree_oid = index.write_tree()?;
        let tree = self.repo.find_tree(tree_oid)?;

        let parents = match self.current_head()? {
            Some((_, oid)) => vec![self.repo.find_commit(oid)?],
            None => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

        let oid = self.repo.commit(
            Some("HEAD"),
            author,
            author,
            message,
            &tree,
            &parent_refs,
        )?;
        Ok(oid)
    }

    // ── Network (Phase 2/3; first exercised there) ───────────────────────

    /// Fetch `branch` from the named remote into its remote-tracking ref. Does
    /// not merge — review sits between fetch and apply. Blocking.
    ///
    /// Prunes while fetching: a plain fetch leaves a remote-tracking ref in
    /// place even after its branch disappears from the remote (a deleted/
    /// migrated/re-created remote). Sync reads that ref as "theirs", so a stale
    /// one makes it merge against phantom content that no longer exists upstream.
    /// Pruning drops `refs/remotes/<remote>/<branch>` when the remote no longer
    /// has the branch, so Sync then correctly sees "nothing incoming".
    pub fn fetch(&self, remote_name: &str, branch: &str) -> Result<()> {
        let mut remote = self.repo.find_remote(remote_name)?;
        let url = remote.url().unwrap_or("").to_string();
        let mut fo = git2::FetchOptions::new();
        fo.remote_callbacks(auth::remote_callbacks(&url));
        fo.prune(git2::FetchPrune::On);
        let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote_name}/{branch}");
        remote.fetch(&[refspec], Some(&mut fo), None)?;
        Ok(())
    }

    /// Push `branch` to the named remote. Never force-pushes. Returns whether
    /// the remote *rejected* the update (it moved since the last fetch) so the
    /// caller can fall back to fetch-and-review instead of forcing. A rejection
    /// is a normal outcome, not an error; transport/auth failures are `Err`.
    /// Blocking.
    pub fn push(&self, remote_name: &str, branch: &str) -> Result<PushResult> {
        use std::sync::{Arc, Mutex};
        let mut remote = self.repo.find_remote(remote_name)?;
        let url = remote.url().unwrap_or("").to_string();

        let mut cb = auth::remote_callbacks(&url);
        // libgit2 reports a per-ref rejection here (e.g. non-fast-forward)
        // rather than as an error from `push`, so capture it.
        let rejection: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = rejection.clone();
        cb.push_update_reference(move |refname, status| {
            if let Some(msg) = status {
                *sink.lock().unwrap() = Some(format!("{refname}: {msg}"));
            }
            Ok(())
        });

        let mut po = git2::PushOptions::new();
        po.remote_callbacks(cb);
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        // A non-fast-forward is a normal "remote moved" outcome, surfaced
        // either as a `NotFastForward` error or via the callback above
        // depending on transport — treat both as a rejection, not a failure.
        match remote.push(&[refspec], Some(&mut po)) {
            Ok(()) => {}
            Err(e) if e.code() == git2::ErrorCode::NotFastForward => {
                return Ok(PushResult {
                    rejected: true,
                    message: Some(e.message().to_string()),
                })
            }
            Err(e) => return Err(e.into()),
        }

        let message = rejection.lock().unwrap().take();
        if message.is_none() {
            // Mirror the just-pushed branch into the local remote-tracking ref
            // so status (unpushed / behind) reflects the push immediately,
            // without requiring a round-trip fetch. This is what git does for a
            // tracked push; libgit2's `push` does not do it for us.
            if let Some((_, head)) = self.current_head()? {
                let refname = format!("refs/remotes/{remote_name}/{branch}");
                self.repo
                    .reference(&refname, head, true, "update tracking after push")?;
            }
        }
        Ok(PushResult {
            rejected: message.is_some(),
            message,
        })
    }
}

/// Outcome of a [`GitBackend::push`].
#[derive(Debug, Clone, Default, Serialize)]
pub struct PushResult {
    /// The remote rejected the update because it moved — fetch & review, then
    /// push again. Never resolved by force-pushing.
    pub rejected: bool,
    /// The rejection reason, when `rejected`.
    pub message: Option<String>,
}

/// Header marking InkyCap's managed entries in a notebox `.gitignore`, so a
/// reader knows why they're there. Written once.
const GITIGNORE_MARKER: &str = "# --- InkyCap (managed) ---";

/// Notebox-internal paths a collaborative `.gitignore` must exclude, each with a
/// one-line rationale. Only entries InkyCap writes *inside* the notebox belong
/// here — window state, the metadata cache and the search index already live
/// under the OS config/cache dirs, outside the repo. Everything else in the
/// notebox (`.typ` notes, attachments, `.bib`, `.collection`, the bundled
/// `inkycap-notebox` package, the shared `.inkycap/settings.json`) is meant to
/// travel.
const GITIGNORE_ENTRIES: &[(&str, &str)] = &[
    (
        ".inkycap/local.json",
        "Per-machine state (cursor position) — must not travel to collaborators.",
    ),
    (
        ".inkycap/incoming/",
        "Incoming-change staging area; rebuilt on each fetch.",
    ),
    (
        ".inkycap/history/",
        "Version-history scratch copies opened for viewing; disposable.",
    ),
    (".DS_Store", "OS file-manager noise."),
    ("Thumbs.db", ""),
];

/// Ensure a collaborative notebox's `.gitignore` excludes every managed entry.
/// Idempotent and **additive**: it appends only the entries not already present
/// (so a notebox set up by an older version gains new ones without duplication),
/// writes the header once, and never touches user-authored lines.
pub fn ensure_collaboration_gitignore(root: &Path) -> Result<()> {
    let path = root.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let present: std::collections::HashSet<&str> =
        existing.lines().map(str::trim).collect();

    let missing: Vec<&(&str, &str)> = GITIGNORE_ENTRIES
        .iter()
        .filter(|(pat, _)| !present.contains(*pat))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }

    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    // Write the header only the first time the managed block is created.
    if !out.contains(GITIGNORE_MARKER) {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(GITIGNORE_MARKER);
        out.push('\n');
    }
    for (pat, comment) in missing {
        if !comment.is_empty() {
            out.push_str("# ");
            out.push_str(comment);
            out.push('\n');
        }
        out.push_str(pat);
        out.push('\n');
    }
    std::fs::write(&path, out)?;
    Ok(())
}

/// Whether `commit` changed `rel` relative to its first parent (added, removed,
/// or modified). A root commit (no parent) counts the file as changed if present.
fn commit_touched_path(commit: &git2::Commit, rel: &Path) -> Result<bool> {
    let this = commit.tree()?.get_path(rel).ok().map(|e| e.id());
    let parent = match commit.parent(0) {
        Ok(p) => p.tree()?.get_path(rel).ok().map(|e| e.id()),
        Err(_) => None,
    };
    Ok(this != parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig() -> git2::Signature<'static> {
        git2::Signature::now("Test", "test@example.com").unwrap()
    }

    #[test]
    fn open_or_init_creates_then_reopens() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!GitBackend::is_repo(dir.path()));
        let _b = GitBackend::open_or_init(dir.path()).unwrap();
        assert!(GitBackend::is_repo(dir.path()));
        // Re-open the now-existing repo.
        let _b2 = GitBackend::open(dir.path()).unwrap();
    }

    #[test]
    fn unborn_head_is_none_then_commit_sets_it() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        assert!(b.current_head().unwrap().is_none());

        std::fs::write(dir.path().join("note.typ"), "= Hello\n").unwrap();
        b.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        let oid = b.commit("first", &sig()).unwrap();

        let (branch, head_oid) = b.current_head().unwrap().expect("head born after commit");
        assert!(!branch.is_empty());
        assert_eq!(head_oid, oid);
    }

    #[test]
    fn set_remote_creates_then_updates() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        b.set_remote("origin", "https://example.com/a.git").unwrap();
        assert_eq!(
            b.remote_url("origin").as_deref(),
            Some("https://example.com/a.git")
        );
        b.set_remote("origin", "https://example.com/b.git").unwrap();
        assert_eq!(
            b.remote_url("origin").as_deref(),
            Some("https://example.com/b.git")
        );
    }

    #[test]
    fn read_blob_at_returns_committed_bytes_and_none_for_missing() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        std::fs::write(dir.path().join("note.typ"), "líne with ünïcode 🌱\n").unwrap();
        b.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        let oid = b.commit("c", &sig()).unwrap();

        let bytes = b.read_blob_at(oid, Path::new("note.typ")).unwrap().unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "líne with ünïcode 🌱\n");
        assert!(b.read_blob_at(oid, Path::new("absent.typ")).unwrap().is_none());
    }

    #[test]
    fn file_history_lists_only_touching_commits_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        // v1 of the note.
        std::fs::write(dir.path().join("note.typ"), "one\n").unwrap();
        b.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        b.commit("create note", &sig()).unwrap();
        // A commit that does NOT touch the note must be excluded.
        std::fs::write(dir.path().join("other.typ"), "x\n").unwrap();
        b.stage_paths(&[PathBuf::from("other.typ")]).unwrap();
        b.commit("unrelated", &sig()).unwrap();
        // v2 of the note.
        std::fs::write(dir.path().join("note.typ"), "two\n").unwrap();
        b.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        b.commit("edit note", &sig()).unwrap();

        let hist = b.file_history(Path::new("note.typ"), 10).unwrap();
        assert_eq!(hist.len(), 2, "only the two commits that changed the note");
        assert_eq!(hist[0].message, "edit note", "newest first");
        assert_eq!(hist[1].message, "create note");
        assert_eq!(hist[0].short_hash.len(), 7);

        // Each version's content is fetchable by its commit hash.
        let oldest = git2::Oid::from_str(&hist[1].commit).unwrap();
        let bytes = b.read_blob_at(oldest, Path::new("note.typ")).unwrap().unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "one\n");
    }

    #[test]
    fn file_history_empty_on_unborn_branch() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        assert!(b.file_history(Path::new("note.typ"), 10).unwrap().is_empty());
    }

    #[test]
    fn merge_base_of_linear_history_is_the_parent() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        std::fs::write(dir.path().join("a.typ"), "1\n").unwrap();
        b.stage_paths(&[PathBuf::from("a.typ")]).unwrap();
        let c1 = b.commit("c1", &sig()).unwrap();
        std::fs::write(dir.path().join("a.typ"), "2\n").unwrap();
        b.stage_paths(&[PathBuf::from("a.typ")]).unwrap();
        let c2 = b.commit("c2", &sig()).unwrap();

        assert_eq!(b.merge_base(c1, c2).unwrap(), Some(c1));
    }

    #[test]
    fn status_reports_dirty_then_clean() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        std::fs::write(dir.path().join("note.typ"), "x\n").unwrap();
        // Untracked file ⇒ dirty.
        assert!(b.status_summary().unwrap().dirty);
        b.stage_paths(&[PathBuf::from("note.typ")]).unwrap();
        b.commit("c", &sig()).unwrap();
        // Nothing outstanding ⇒ clean, head born.
        let s = b.status_summary().unwrap();
        assert!(!s.dirty);
        assert!(s.head.is_some());
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn commit_info_reports_author_and_message() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        std::fs::write(dir.path().join("n.typ"), "x\n").unwrap();
        b.stage_paths(&[PathBuf::from("n.typ")]).unwrap();
        let author = git2::Signature::now("Ada", "ada@example.com").unwrap();
        let oid = b.commit("did a thing", &author).unwrap();

        let info = b.commit_info(oid).unwrap();
        assert_eq!(info.author_name, "Ada");
        assert_eq!(info.author_email, "ada@example.com");
        assert_eq!(info.message, "did a thing");
        assert_eq!(info.short_hash.len(), 7);
    }

    #[test]
    fn changed_paths_classifies_add_modify_delete() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        // c1: a.typ + b.typ
        std::fs::write(dir.path().join("a.typ"), "a1\n").unwrap();
        std::fs::write(dir.path().join("b.typ"), "b1\n").unwrap();
        b.stage_paths(&[PathBuf::from("a.typ"), PathBuf::from("b.typ")]).unwrap();
        let c1 = b.commit("c1", &sig()).unwrap();
        // c2: modify a, delete b, add c
        std::fs::write(dir.path().join("a.typ"), "a2\n").unwrap();
        std::fs::remove_file(dir.path().join("b.typ")).unwrap();
        std::fs::write(dir.path().join("c.typ"), "c1\n").unwrap();
        let mut idx = b.repo.index().unwrap();
        idx.add_path(Path::new("a.typ")).unwrap();
        idx.remove_path(Path::new("b.typ")).unwrap();
        idx.add_path(Path::new("c.typ")).unwrap();
        idx.write().unwrap();
        let c2 = b.commit("c2", &sig()).unwrap();

        let mut changed = b.changed_paths(Some(c1), c2).unwrap();
        changed.sort_by(|x, y| x.path.cmp(&y.path));
        assert_eq!(changed.len(), 3);
        assert_eq!(changed[0], ChangedPath { path: PathBuf::from("a.typ"), status: ChangeStatus::Modified });
        assert_eq!(changed[1], ChangedPath { path: PathBuf::from("b.typ"), status: ChangeStatus::Deleted });
        assert_eq!(changed[2], ChangedPath { path: PathBuf::from("c.typ"), status: ChangeStatus::Added });

        // Unborn `from` (None) ⇒ every path in `to` is an add.
        let from_empty = b.changed_paths(None, c1).unwrap();
        assert_eq!(from_empty.len(), 2);
        assert!(from_empty.iter().all(|c| c.status == ChangeStatus::Added));
    }

    #[test]
    fn remote_tracking_oid_is_none_without_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let b = GitBackend::open_or_init(dir.path()).unwrap();
        assert!(b.remote_tracking_oid("origin", "main").unwrap().is_none());
    }

    #[test]
    fn gitignore_is_written_once_and_preserves_user_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "secrets.txt\n").unwrap();

        ensure_collaboration_gitignore(root).unwrap();
        let after_first = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(after_first.contains("secrets.txt"), "user entry preserved");
        assert!(after_first.contains(".inkycap/local.json"));
        assert!(after_first.contains(".inkycap/incoming/"));
        assert!(after_first.contains(".inkycap/history/"));

        // Idempotent: a second call does not duplicate the managed block.
        ensure_collaboration_gitignore(root).unwrap();
        let after_second = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert_eq!(after_first, after_second);
        assert_eq!(after_second.matches(GITIGNORE_MARKER).count(), 1);
    }

    /// A `.gitignore` from an older setup (missing a newer entry) gains only the
    /// missing entry on the next call — additive, no duplication, header once.
    #[test]
    fn gitignore_additively_backfills_missing_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // Simulate an older managed block without `.inkycap/history/`.
        std::fs::write(
            root.join(".gitignore"),
            format!("{GITIGNORE_MARKER}\n.inkycap/local.json\n.inkycap/incoming/\n.DS_Store\nThumbs.db\n"),
        )
        .unwrap();

        ensure_collaboration_gitignore(root).unwrap();
        let after = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(after.contains(".inkycap/history/"), "missing entry backfilled");
        assert_eq!(after.matches(".inkycap/local.json").count(), 1, "no duplication");
        assert_eq!(after.matches(GITIGNORE_MARKER).count(), 1, "header stays single");
    }

    // ── Phase 5 merge engine ─────────────────────────────────────────────

    /// Build a bare remote seeded with `files` on `main`, plus two clones A and
    /// B both at that base. Returns the temp dirs (kept alive), the clones'
    /// backends + paths, and the branch name.
    #[allow(clippy::type_complexity)]
    fn bare_with_two_clones(
        files: &[(&str, &str)],
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        tempfile::TempDir,
        GitBackend,
        std::path::PathBuf,
        GitBackend,
        std::path::PathBuf,
        String,
    ) {
        let bare = tempfile::tempdir().unwrap();
        let r = git2::Repository::init_bare(bare.path()).unwrap();
        r.set_head("refs/heads/main").unwrap();
        let url = bare.path().to_str().unwrap();

        let adir = tempfile::tempdir().unwrap();
        let apath = adir.path().join("a");
        git2::Repository::clone(url, &apath).unwrap();
        let a = GitBackend::open(&apath).unwrap();
        // Cloning an empty remote leaves an unborn HEAD on libgit2's default
        // branch (master); pin it to main before the first commit, exactly as
        // setup's apply_setup does, so the whole fixture is on one branch.
        a.ensure_initial_branch("main").unwrap();
        for (name, content) in files {
            std::fs::write(apath.join(name), content).unwrap();
        }
        a.stage_all().unwrap();
        a.commit("base", &sig()).unwrap();
        let branch = a.current_head().unwrap().unwrap().0;
        assert!(!a.push("origin", &branch).unwrap().rejected);

        let bdir = tempfile::tempdir().unwrap();
        let bpath = bdir.path().join("b");
        git2::Repository::clone(url, &bpath).unwrap();
        let b = GitBackend::open(&bpath).unwrap();

        (bare, adir, bdir, a, apath, b, bpath, branch)
    }

    /// Edits to different files merge cleanly, the merge commit has both tips as
    /// parents, and it fast-forwards the remote (no rebase) — the core Sync path.
    #[test]
    fn merge_clean_different_files_fast_forwards_remote() {
        let (_bare, _ad, _bd, a, apath, b, bpath, branch) =
            bare_with_two_clones(&[("x.typ", "l1\nl2\nl3\n"), ("y.typ", "yy\n")]);

        // Theirs (A): change x.typ, push.
        std::fs::write(apath.join("x.typ"), "CHANGED1\nl2\nl3\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        assert!(!a.push("origin", &branch).unwrap().rejected);

        // Ours (B): change a different file, commit locally, fetch theirs.
        std::fs::write(bpath.join("y.typ"), "B-EDIT\n").unwrap();
        b.stage_all().unwrap();
        let ours = b.commit("b-edit", &sig()).unwrap();
        b.fetch("origin", &branch).unwrap();
        let theirs = b.remote_tracking_oid("origin", &branch).unwrap().unwrap();

        let tree = match b.merge_commits_to_tree(ours, theirs).unwrap() {
            MergeOutcome::Clean(t) => t,
            MergeOutcome::Conflicts(p) => panic!("expected clean, got {p:?}"),
        };
        b.commit_tree("Merge", &sig(), tree, &[ours, theirs]).unwrap();
        b.checkout_head_force().unwrap();

        // Both sides' edits are present, and the merge fast-forwards the remote.
        assert_eq!(std::fs::read_to_string(bpath.join("x.typ")).unwrap(), "CHANGED1\nl2\nl3\n");
        assert_eq!(std::fs::read_to_string(bpath.join("y.typ")).unwrap(), "B-EDIT\n");
        assert!(
            !b.push("origin", &branch).unwrap().rejected,
            "a merge commit parented on theirs fast-forwards the remote"
        );
    }

    /// Edits to the same region of the same note surface as a conflict path.
    #[test]
    fn merge_conflicts_same_region() {
        let (_bare, _ad, _bd, a, apath, b, bpath, branch) =
            bare_with_two_clones(&[("x.typ", "line1\nline2\n")]);

        std::fs::write(apath.join("x.typ"), "AAA\nline2\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        assert!(!a.push("origin", &branch).unwrap().rejected);

        std::fs::write(bpath.join("x.typ"), "BBB\nline2\n").unwrap();
        b.stage_all().unwrap();
        let ours = b.commit("b-edit", &sig()).unwrap();
        b.fetch("origin", &branch).unwrap();
        let theirs = b.remote_tracking_oid("origin", &branch).unwrap().unwrap();

        match b.merge_commits_to_tree(ours, theirs).unwrap() {
            MergeOutcome::Conflicts(paths) => {
                assert_eq!(paths, vec![std::path::PathBuf::from("x.typ")]);
            }
            MergeOutcome::Clean(_) => panic!("expected a conflict on x.typ"),
        }
    }

    /// On a conflicted merge, the clean (non-conflicting) incoming files are
    /// materialized into the working tree while the conflicting file is left at
    /// *ours* for the suggestion layer to render.
    #[test]
    fn apply_clean_merge_lands_clean_files_and_holds_conflicts() {
        let (_bare, _ad, _bd, a, apath, b, bpath, branch) = bare_with_two_clones(&[
            ("clean.typ", "shared\n"),
            ("conflict.typ", "line1\nline2\n"),
        ]);

        // Theirs (A): edit a file B won't touch (clean) + the shared region.
        std::fs::write(apath.join("clean.typ"), "THEIRS clean\n").unwrap();
        std::fs::write(apath.join("conflict.typ"), "AAA\nline2\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        assert!(!a.push("origin", &branch).unwrap().rejected);

        // Ours (B): edit the same region of conflict.typ, commit, fetch.
        std::fs::write(bpath.join("conflict.typ"), "BBB\nline2\n").unwrap();
        b.stage_all().unwrap();
        let ours = b.commit("b-edit", &sig()).unwrap();
        b.fetch("origin", &branch).unwrap();
        let theirs = b.remote_tracking_oid("origin", &branch).unwrap().unwrap();

        let app = b.apply_clean_merge(ours, theirs).unwrap();
        assert_eq!(app.conflicts, vec![PathBuf::from("conflict.typ")]);
        assert_eq!(app.applied, vec![PathBuf::from("clean.typ")]);
        // The clean file now holds theirs; the conflicted file still holds mine.
        assert_eq!(std::fs::read_to_string(bpath.join("clean.typ")).unwrap(), "THEIRS clean\n");
        assert_eq!(std::fs::read_to_string(bpath.join("conflict.typ")).unwrap(), "BBB\nline2\n");
    }

    /// When the remote's branch disappears (a reset / migrated / re-created
    /// remote), a pruning fetch drops the now-dangling remote-tracking ref, so
    /// Sync sees "nothing incoming" instead of merging against phantom content.
    #[test]
    fn fetch_prunes_stale_tracking_ref_when_remote_branch_deleted() {
        let (bare, _ad, _bd, _a, _apath, b, _bpath, branch) =
            bare_with_two_clones(&[("x.typ", "hi\n")]);
        // B (a clone) already tracks the remote branch.
        b.fetch("origin", &branch).unwrap();
        assert!(b.remote_tracking_oid("origin", &branch).unwrap().is_some());

        // The branch vanishes from the remote.
        let bare_repo = git2::Repository::open_bare(bare.path()).unwrap();
        bare_repo
            .find_reference(&format!("refs/heads/{branch}"))
            .unwrap()
            .delete()
            .unwrap();

        // The next fetch prunes the stale tracking ref.
        b.fetch("origin", &branch).unwrap();
        assert!(
            b.remote_tracking_oid("origin", &branch).unwrap().is_none(),
            "stale remote-tracking ref must be pruned once its branch is gone"
        );
    }

    /// A pure pull when local has not diverged: fast-forward the working tree to
    /// theirs.
    #[test]
    fn fast_forward_pure_pull_updates_working_tree() {
        let (_bare, _ad, _bd, a, apath, b, bpath, branch) =
            bare_with_two_clones(&[("x.typ", "before\n")]);

        std::fs::write(apath.join("x.typ"), "after\n").unwrap();
        a.stage_all().unwrap();
        a.commit("a-edit", &sig()).unwrap();
        assert!(!a.push("origin", &branch).unwrap().rejected);

        // B hasn't changed anything; fetch + fast-forward.
        b.fetch("origin", &branch).unwrap();
        let theirs = b.remote_tracking_oid("origin", &branch).unwrap().unwrap();
        b.fast_forward_checkout(theirs).unwrap();

        assert_eq!(std::fs::read_to_string(bpath.join("x.typ")).unwrap(), "after\n");
        assert_eq!(b.current_head().unwrap().unwrap().1, theirs);
    }
}
