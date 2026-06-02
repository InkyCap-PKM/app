//! Notebox-level git collaboration.
//!
//! The unit of sharing is the **whole notebox**: a notebox is either
//! collaborative (backed by a git remote) or it is not. The notebox root
//! *is* the git repository — there is no mirror worktree. Incoming file
//! versions are read straight from a fetched commit's git objects (blob by
//! OID), so the working tree is never disturbed by a fetch.
//!
//! The collaboration loop is a deliberate **subset** of git — no branch
//! manager, rebase, stash, cherry-pick, or log explorer:
//!
//! The model is **merge-first**: a sync never pauses for review.
//!
//! ```text
//!   commit local ─▶ fetch ─▶ merge (take theirs on overlap) ─▶ push
//!                                   └▶ review & revert later (Changes pane)
//! ```
//!
//! ## Module map
//! - [`backend`] — thin, synchronous wrapper over `git2` (open/init, remote,
//!   fetch, merge-base, blob reads, commit, push). The only place that talks
//!   to libgit2.
//! - [`auth`] — credential resolution for fetch/push: keyring-backed SSH keys
//!   and HTTPS PATs, surfaced to the user via [`crate::events::AppEvent`]
//!   rather than blocking commands.
//! - [`sync_review`] — line-level hunk diff + per-hunk revert for the
//!   merge-first "Changes since last sync" review (the revert-later core).
//! - [`json_merge`] — structured 3-way merge for the shared `settings.json`
//!   (key-level, so distinct config edits on both sides both survive).
//! - [`package`] — offline package handoff (Phase 7): zip a notebox's whole
//!   `.git` to a file and extract a received package to a staging repo, so a
//!   notebox can collaborate with no hosted git server.
//!
//! Per-notebox git configuration ([`crate::notebox_settings::NoteboxGitConfig`])
//! lives in the notebox settings, not globally and not in a `.collection` file.

pub mod auth;
pub mod backend;
pub mod json_merge;
pub mod package;
pub mod sync_review;

pub use backend::GitBackend;
