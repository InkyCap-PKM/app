//! Notebox backups: a zip archive of the open notebox written to a chosen
//! folder, optionally AES-256 encrypted with a password from the OS keychain.
//!
//! - `archive`: builds the zip from the notebox (and optionally the user config
//!   folder).
//! - `filename`: fills `{notebox}`, `{YYYY}`, … into the file name pattern,
//!   making each value safe for Windows.
//! - `state`: the last successful backup, for scheduling and the only-on-change
//!   check, in `$CONFIG_DIR/inkycap/backup_state.json` (not settings.json, as
//!   it changes often and isn't a preference).
//! - `password`: the backup password in the OS keychain (`keyring`).
//! - `runner`: runs one backup: takes the lock, builds the path, calls
//!   `archive::write`, prunes old backups and updates the state.
//!
//! When to back up is decided in `commands::backup` and the background task
//! from `lib.rs`; this module only knows how.

pub mod archive;
pub mod filename;
pub mod password;
pub mod restore;
pub mod runner;
pub mod schedule;
pub mod state;
