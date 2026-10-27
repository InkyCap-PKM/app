//! Sign-in and identity details for a git remote.
//!
//! 1. **Credentials** for fetch and push. The main path is a **username and
//!    password** over HTTPS; SSH keys are the advanced option. The password is
//!    kept in the OS keychain ([`keyring`]) and the username in a
//!    per-installation store, both keyed by the normalized remote URL, so
//!    noteboxes can use different accounts on one service.
//! 2. **Author identity** (name and email for commits). The current choice is
//!    stored per notebox in `local.json` (see
//!    `commands::git::resolved_local_identity`); the per-installation store
//!    here, keyed by remote, is the older location and is still read as a
//!    fallback.
//!
//! Identity is never stored in the shared notebox settings, or every
//! collaborator would commit under one name. At commit time: the notebox's
//! identity, then this store, then git config (`user.name` / `user.email`),
//! else the user is asked.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::errors::{InkyCapError, Result};

// ───────────────────────────── Author identity ─────────────────────────────

/// A commit author identity: the name + email stamped on commits.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

impl GitIdentity {
    /// True when both fields are non-empty — git refuses to build a signature
    /// from a blank name or email.
    pub fn is_complete(&self) -> bool {
        !self.name.trim().is_empty() && !self.email.trim().is_empty()
    }
}

/// Per-installation map of remote URL → the identity to commit as for any
/// notebox backed by that remote.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GitIdentityStore {
    identities: BTreeMap<String, GitIdentity>,
}

/// Location of the identity store, in the config folder, never inside a
/// notebox.
fn identity_store_path() -> PathBuf {
    crate::app_paths::config_dir().join("git-identities.json")
}

/// Normalize a remote URL so equivalent forms (`https://h/o/r` and
/// `https://h/o/r.git`, `git@h:o/r.git` and `ssh://git@h/o/r`) give the same
/// key: lower-cased, without `.git` or a trailing slash, SSH `host:path` as
/// `host/path`. Other forms pass through unchanged.
pub fn normalize_remote(remote: &str) -> String {
    let mut s = remote.trim().to_ascii_lowercase();
    // scp-like `git@host:owner/repo` → `git@host/owner/repo`
    if !s.contains("://") {
        if let Some(colon) = s.find(':') {
            // Only rewrite the first colon that separates host from path, not a
            // port colon in a URL (handled by the `://` branch above).
            s.replace_range(colon..=colon, "/");
        }
    }
    // strip scheme and any `user@`
    if let Some(idx) = s.find("://") {
        s = s[idx + 3..].to_string();
    }
    if let Some(at) = s.find('@') {
        s = s[at + 1..].to_string();
    }
    s = s.trim_end_matches('/').to_string();
    s = s.strip_suffix(".git").unwrap_or(&s).to_string();
    s
}

/// Load the identity store, returning an empty store if absent or unparseable.
pub fn load_identities() -> GitIdentityStore {
    std::fs::read_to_string(identity_store_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_identities(store: &GitIdentityStore) -> Result<()> {
    let path = identity_store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

/// The commit identity to use for `remote`, if one has been set on this
/// installation. Keyed by [`normalize_remote`].
pub fn identity_for_remote(remote: &str) -> Option<GitIdentity> {
    load_identities()
        .identities
        .get(&normalize_remote(remote))
        .cloned()
}

/// Set (or replace) the commit identity for `remote`.
pub fn set_identity_for_remote(remote: &str, identity: GitIdentity) -> Result<()> {
    let mut store = load_identities();
    store.identities.insert(normalize_remote(remote), identity);
    save_identities(&store)
}

/// Forget the commit identity for `remote`. Idempotent.
pub fn clear_identity_for_remote(remote: &str) -> Result<()> {
    let mut store = load_identities();
    store.identities.remove(&normalize_remote(remote));
    save_identities(&store)
}

// ───────────────────────── HTTPS username (not secret) ─────────────────────

/// Per-installation map of remote URL to HTTPS username. Not a secret (the
/// password is), so a plain file in the config folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GitUsernameStore {
    usernames: BTreeMap<String, String>,
}

fn username_store_path() -> PathBuf {
    crate::app_paths::config_dir().join("git-usernames.json")
}

fn load_usernames() -> GitUsernameStore {
    std::fs::read_to_string(username_store_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_usernames(store: &GitUsernameStore) -> Result<()> {
    let path = username_store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

/// The HTTPS username saved for `remote`, if any. Keyed by [`normalize_remote`].
pub fn username_for_remote(remote: &str) -> Option<String> {
    load_usernames()
        .usernames
        .get(&normalize_remote(remote))
        .filter(|u| !u.trim().is_empty())
        .cloned()
}

/// Set (or replace) the HTTPS username for `remote`.
pub fn set_username_for_remote(remote: &str, username: &str) -> Result<()> {
    let mut store = load_usernames();
    store
        .usernames
        .insert(normalize_remote(remote), username.to_string());
    save_usernames(&store)
}

/// Forget the HTTPS username for `remote`. Idempotent.
pub fn clear_username_for_remote(remote: &str) -> Result<()> {
    let mut store = load_usernames();
    store.usernames.remove(&normalize_remote(remote));
    save_usernames(&store)
}

// ──────────────────────── Transport secret (password) ──────────────────────

/// Keychain service for repository passwords. The account is the normalized
/// remote URL (host and path), so two repositories on one host can use
/// different accounts. Keep it stable across versions.
const HTTPS_TOKEN_SERVICE: &str = "ca.unom.inkycap.git.https";

fn map_keyring_err(err: keyring::Error) -> InkyCapError {
    InkyCapError::Git(format!("OS keychain error: {err}"))
}

/// Store the HTTPS password for `remote`. Overwrites any existing one. Keyed by
/// the full normalized remote so it is per-repository, not per-host.
pub fn set_remote_password(remote: &str, password: &str) -> Result<()> {
    let entry = keyring::Entry::new(HTTPS_TOKEN_SERVICE, &normalize_remote(remote))
        .map_err(map_keyring_err)?;
    entry.set_password(password).map_err(map_keyring_err)
}

/// Fetch the stored HTTPS password for `remote`, if any. A missing password is
/// `Ok(None)`; only real keychain failures are `Err`.
pub fn remote_password(remote: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(HTTPS_TOKEN_SERVICE, &normalize_remote(remote))
        .map_err(map_keyring_err)?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(map_keyring_err(e)),
    }
}

/// Delete the stored HTTPS password for `remote`. Idempotent.
pub fn clear_remote_password(remote: &str) -> Result<()> {
    let entry = keyring::Entry::new(HTTPS_TOKEN_SERVICE, &normalize_remote(remote))
        .map_err(map_keyring_err)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(map_keyring_err(e)),
    }
}

/// First existing default SSH private key under `~/.ssh`, if any. Used as a
/// fallback when ssh-agent has nothing.
fn default_ssh_key() -> Option<PathBuf> {
    static KEY: OnceLock<Option<PathBuf>> = OnceLock::new();
    KEY.get_or_init(|| {
        let ssh = dirs::home_dir()?.join(".ssh");
        ["id_ed25519", "id_ecdsa", "id_rsa"]
            .iter()
            .map(|name| ssh.join(name))
            .find(|p| p.exists())
    })
    .clone()
}

/// The [`git2::RemoteCallbacks`] for fetching from and pushing to `remote`.
/// Credentials, in order:
///
/// - **HTTPS** (`USER_PASS_PLAINTEXT`): the saved username and keychain
///   password for this repository; the username falls back to one in the URL,
///   then `git`.
/// - **SSH** (`SSH_KEY`): ssh-agent, then the first default `~/.ssh` key.
///
/// If nothing works, libgit2 reports an auth error, which the command passes to
/// the user.
pub fn remote_callbacks(remote: &str) -> git2::RemoteCallbacks<'static> {
    let remote = remote.to_string();
    let mut cb = git2::RemoteCallbacks::new();
    cb.credentials(move |_url, username_from_url, allowed| {
        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            if let Ok(Some(password)) = remote_password(&remote) {
                let user = username_for_remote(&remote)
                    .or_else(|| username_from_url.map(str::to_string))
                    .unwrap_or_else(|| "git".to_string());
                return git2::Cred::userpass_plaintext(&user, &password);
            }
        }
        if allowed.contains(git2::CredentialType::SSH_KEY) {
            let user = username_from_url.unwrap_or("git");
            if let Ok(cred) = git2::Cred::ssh_key_from_agent(user) {
                return Ok(cred);
            }
            if let Some(key) = default_ssh_key() {
                // No passphrase support yet; unencrypted keys and agent-loaded
                // keys cover the common case.
                return git2::Cred::ssh_key(user, None, &key, None);
            }
        }
        Err(git2::Error::from_str(
            "no usable git credentials (enter a username and password, or set up an SSH key)",
        ))
    });
    cb
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_remote_unifies_equivalent_spellings() {
        let canonical = "codeberg.org/joch/notes";
        assert_eq!(
            normalize_remote("https://codeberg.org/joch/notes.git"),
            canonical
        );
        assert_eq!(
            normalize_remote("https://codeberg.org/joch/notes"),
            canonical
        );
        assert_eq!(
            normalize_remote("git@codeberg.org:joch/notes.git"),
            canonical
        );
        assert_eq!(
            normalize_remote("ssh://git@codeberg.org/joch/notes"),
            canonical
        );
        assert_eq!(
            normalize_remote("  HTTPS://Codeberg.org/joch/Notes.git/ "),
            canonical
        );
    }

    #[test]
    fn password_key_distinguishes_repos_on_same_host() {
        // Two repos on one host must not share a password key — that was the
        // old host-only behaviour. The keychain account is the full remote.
        assert_ne!(
            normalize_remote("https://codeberg.org/athena-otlet/notes"),
            normalize_remote("https://codeberg.org/athena-otlet/other"),
        );
    }

    #[test]
    fn identity_complete_requires_both_fields() {
        assert!(!GitIdentity::default().is_complete());
        assert!(!GitIdentity {
            name: "A".into(),
            email: "  ".into()
        }
        .is_complete());
        assert!(GitIdentity {
            name: "A".into(),
            email: "a@b.c".into()
        }
        .is_complete());
    }
}
