//! Backup-archive password — stored in the OS keychain, not in
//! settings.json.
//!
//! Per-machine secret: every install of InkyCap on a given OS user
//! account gets one backup password, shared across all noteboxes that
//! user opens. This matches the user expectation (one password they
//! remember to unlock their backups) and avoids cross-notebox key
//! rotation headaches. The `keyring` crate routes us to:
//!
//!   - Secret Service on Linux (gnome-keyring / kwallet / KeePassXC / …)
//!   - macOS Keychain on Darwin
//!   - Windows Credential Manager on Windows
//!
//! All three need *some* keyring backend to be available at runtime; on
//! a barebones Linux container without a Secret Service implementation
//! `Entry::set_password` will return a `NoStorageAccess`-shaped error.
//! That bubbles up as a `BackupError::Keychain` so the UI can prompt
//! the user to install one rather than failing silently.

use std::sync::OnceLock;

use crate::errors::{InkyCapError, Result};

/// Service identifier used in the OS keychain. Stable across versions so
/// a user who upgrades InkyCap keeps access to their stored password
/// without re-entering it. Format follows the reverse-DNS convention
/// keyring backends expect on macOS/Windows.
const SERVICE_NAME: &str = "ca.unom.inkycap.backup";

/// Account / username within the keyring service. We use a fixed value
/// because there is only one backup password per OS user — there's no
/// concept of multiple keyring entries for backups today.
const ACCOUNT_NAME: &str = "default";

/// Cached entry handle. Cheap to recreate but we hold one so repeated
/// reads (e.g. each scheduled backup) don't repeatedly allocate the
/// underlying platform connection.
fn entry() -> std::result::Result<&'static keyring::Entry, keyring::Error> {
    static ENTRY: OnceLock<keyring::Entry> = OnceLock::new();
    if let Some(e) = ENTRY.get() {
        return Ok(e);
    }
    let e = keyring::Entry::new(SERVICE_NAME, ACCOUNT_NAME)?;
    Ok(ENTRY.get_or_init(|| e))
}

fn map_err(err: keyring::Error) -> InkyCapError {
    InkyCapError::BadRequest(format!("OS keychain error: {err}"))
}

/// Persist a new backup password. Overwrites any existing entry.
pub fn set(password: &str) -> Result<()> {
    let e = entry().map_err(map_err)?;
    e.set_password(password).map_err(map_err)?;
    Ok(())
}

/// Fetch the stored backup password, returning `Ok(None)` when no
/// password is set (a normal state — most users won't enable
/// encryption). Real keychain errors still bubble up as `Err` so the
/// caller can surface them.
pub fn get() -> Result<Option<String>> {
    let e = entry().map_err(map_err)?;
    match e.get_password() {
        Ok(p) => Ok(Some(p)),
        // The crate uses distinct error variants for "no entry" vs.
        // "keychain unavailable" — we want the former to surface as
        // None and the latter to surface as an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// Delete the stored password. Idempotent — "no entry" is treated as
/// success because the post-condition the caller wants is "the keychain
/// no longer contains a backup password," which is already true.
pub fn clear() -> Result<()> {
    let e = entry().map_err(map_err)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(map_err(e)),
    }
}
