//! Notebox git collaboration.
//!
//! The whole notebox is shared: it is collaborative (backed by a git remote, or
//! package handoff) or not. The notebox root is the repository. Incoming
//! versions are read from fetched git objects, so a fetch never touches the
//! working tree.
//!
//! Only a small part of git is used (no branches, rebase, stash or log browser),
//! and a sync never pauses for review:
//!
//! ```text
//!   commit local ─▶ fetch ─▶ merge (take theirs on overlap) ─▶ push
//!                                   └▶ review & revert later (Changes pane)
//! ```
//!
//! ## Modules
//! - [`backend`]: synchronous wrapper over `git2`, the only code talking to
//!   libgit2.
//! - [`auth`]: credentials for fetch and push (HTTPS username and keychain
//!   password, or SSH keys).
//! - [`sync_review`]: line-level diff and per-hunk revert for "Changes since
//!   last sync".
//! - [`json_merge`]: key-level 3-way merge of the shared `settings.json`, so
//!   different edits on both sides survive.
//! - [`package`]: offline package handoff: zip a notebox's `.git` to a file and
//!   extract a received one, for collaboration without a server.
//!
//! The per-notebox git config ([`crate::notebox_settings::NoteboxGitConfig`]) is
//! kept with the notebox settings.

pub mod auth;
pub mod backend;
pub mod json_merge;
pub mod package;
pub mod sync_review;

pub use backend::GitBackend;
