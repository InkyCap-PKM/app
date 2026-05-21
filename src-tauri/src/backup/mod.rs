//! Notebox backup feature.
//!
//! Writes a zip archive of the currently-open notebox to a user-chosen
//! destination folder, optionally encrypted with AES-256 via a password
//! stored in the OS keychain. See `CLAUDE.md` and the planning thread for
//! the design rationale; the high-level shape is:
//!
//!   - `archive`   — builds the zip file from a notebox root (+ optional
//!                   user-config folder).
//!   - `filename`  — substitutes `{notebox}`, `{YYYY}`, … tokens into the
//!                   configured filename pattern, sanitizing each
//!                   substitution against Windows-reserved characters and
//!                   reserved names.
//!   - `state`     — persists "last successful backup" timestamp so the
//!                   scheduler and only-on-change guard can do their job
//!                   across restarts. Lives in
//!                   `$CONFIG_DIR/inkycap/backup_state.json`, separate from
//!                   settings.json because it churns more frequently and
//!                   isn't really a user preference.
//!   - `password`  — read/write/delete the per-machine backup password in
//!                   the OS keychain via the `keyring` crate.
//!   - `runner`    — the public entry point for a one-shot backup: locks
//!                   a mutex, builds the destination path, calls
//!                   `archive::write`, prunes old backups, updates state.
//!
//! Scheduling (interval timer, on-launch check, only-on-change guard) lives
//! one layer up in `commands::backup` and the background task started from
//! `lib.rs` — this module stays a thin core that knows how to *do* a
//! backup but not *when* to do one.

pub mod archive;
pub mod filename;
pub mod password;
pub mod restore;
pub mod runner;
pub mod schedule;
pub mod state;
