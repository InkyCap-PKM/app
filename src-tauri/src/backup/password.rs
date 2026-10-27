//! The backup password, kept in the OS keychain, not settings.json.
//!
//! One password per OS user, shared by every notebox. The `keyring` crate uses:
//!
//!   - Secret Service on Linux (gnome-keyring / kwallet / KeePassXC / …)
//!   - Keychain on macOS
//!   - Credential Manager on Windows
//!
//! Without a keyring service (e.g. a minimal Linux container), saving fails
//! with a `NoStorageAccess`-type error, returned as `BackupError::Keychain` so
//! the UI can ask the user to install one.

use std::sync::OnceLock;

use crate::errors::{InkyCapError, Result};

/// Keychain service name, in reverse-DNS form. Must not change, or users lose
/// access to their stored password.
const SERVICE_NAME: &str = "ca.unom.inkycap.backup";

/// Account within the service; fixed, since there is one backup password per OS
/// user.
const ACCOUNT_NAME: &str = "default";

/// Cached entry, so each scheduled backup doesn't open a new keychain
/// connection.
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

/// The stored backup password, or `Ok(None)` if there is none (most users don't
/// encrypt). Keychain errors are returned as `Err`.
pub fn get() -> Result<Option<String>> {
    let e = entry().map_err(map_err)?;
    match e.get_password() {
        Ok(p) => Ok(Some(p)),
        // "No entry" means no password (None); "keychain unavailable" is an
        // error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// Delete the stored password. Succeeds if there is none.
pub fn clear() -> Result<()> {
    let e = entry().map_err(map_err)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(map_err(e)),
    }
}
