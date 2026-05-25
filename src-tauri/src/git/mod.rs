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
//! ```text
//!   fetch ─▶ stage-as-suggestions ─▶ resolve inline ─▶ consolidate ─▶ push
//! ```
//!
//! ## Module map
//! - [`backend`] — thin, synchronous wrapper over `git2` (open/init, remote,
//!   fetch, merge-base, blob reads, commit, push). The only place that talks
//!   to libgit2.
//! - [`auth`] — credential resolution for fetch/push: keyring-backed SSH keys
//!   and HTTPS PATs, surfaced to the user via [`crate::events::AppEvent`]
//!   rather than blocking commands.
//! - [`staging`] — the `.inkycap/incoming/` staging-folder lifecycle for
//!   incoming-change review.
//! - [`suggest`] — maps a 3-way diff onto inline `#suggestion` Typst markup
//!   (the conflict-rendering core).
//! - [`history`] — the `.inkycap/history/` scratch lifecycle for read-only
//!   version-view tabs (Phase 6).
//!
//! Per-notebox git configuration ([`crate::notebox_settings::NoteboxGitConfig`])
//! lives in the notebox settings, not globally and not in a `.collection` file.

pub mod auth;
pub mod backend;
pub mod history;
pub mod staging;
pub mod suggest;

pub use backend::GitBackend;
