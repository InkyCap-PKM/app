//! Who the user is with respect to a git remote — two distinct concerns
//! that both key off the remote:
//!
//! 1. **Transport credentials** — what *authenticates* a fetch or push. The
//!    primary, beginner-friendly path is a **username + password** for the
//!    repository (over HTTPS); SSH keys are the advanced alternative. The
//!    password is a secret and lives in the OS keychain via [`keyring`]; the
//!    username is not a secret and lives in a per-installation store. Both are
//!    keyed by the (normalized) remote URL, so different noteboxes can sign in
//!    as different accounts on the same service.
//! 2. **Author identity** — the name + email stamped on commits. *Not* a
//!    secret; stored per-installation, keyed by remote URL, so a user can use
//!    a different account per notebox and so the choice re-applies to any
//!    clone of that notebox on this machine.
//!
//! ## Why author identity is stored here, keyed by remote
//! Commit identity is *per-user*, not a property of the notebox: if it
//! travelled inside the committed notebox settings, every collaborator who
//! opened the notebox would commit under one name. Git's own transport is the
//! committed repo, so anything that travels through it reaches collaborators
//! too. Keying identity by remote URL in a *per-installation* store keeps it
//! out of the repo (no leak) while still being per-notebook (different remote
//! ⇒ different account) and auto-applying to every clone of that notebox on
//! this machine. Carrying it to a *second* machine automatically would need
//! InkyCap settings-sync (a future feature); the store is shaped so that slots
//! in additively — sync the file and identities follow.
//!
//! Resolution order at commit time is: this store (by remote) → git's own
//! config (`user.name`/`user.email`, which [`git2`] reads via
//! `Repository::signature`) → prompt. Only the first is implemented here; the
//! backend handles the git-config fallback.

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

/// On-disk location of the identity store. Per-installation (config dir),
/// alongside the other preference files — never inside a notebox, so it never
/// travels through collaboration.
fn identity_store_path() -> PathBuf {
    crate::app_paths::config_dir().join("git-identities.json")
}

/// Normalize a remote URL so equivalent spellings (`https://h/o/r` vs
/// `https://h/o/r.git`, `git@h:o/r.git` vs `ssh://git@h/o/r`) resolve to the
/// same identity key. Best-effort: lower-cases, drops a `.git` suffix and any
/// trailing slash, and reduces SSH `host:path` to `host/path`. Unknown shapes
/// fall through unchanged, so a key always exists.
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
    store
        .identities
        .insert(normalize_remote(remote), identity);
    save_identities(&store)
}

/// Forget the commit identity for `remote`. Idempotent.
pub fn clear_identity_for_remote(remote: &str) -> Result<()> {
    let mut store = load_identities();
    store.identities.remove(&normalize_remote(remote));
    save_identities(&store)
}

// ───────────────────────── HTTPS username (not secret) ─────────────────────

/// Per-installation map of remote URL → the username to sign in as over HTTPS.
/// The username is not a secret (the password is), so it lives in a plain
/// preference file alongside the identity store — never inside a notebox.
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

/// OS-keychain service for repository passwords. The keychain *account* is the
/// normalized remote URL (host **and** path), so two repositories — even on the
/// same host — can hold passwords for two different accounts. Stable across
/// versions; reverse-DNS form per the keyring backends' conventions.
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
/// fallback when ssh-agent has nothing; explicit key selection is Phase 4.
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

/// Build the [`git2::RemoteCallbacks`] used for fetch/push against `remote`.
///
/// The credentials callback resolves, in order:
/// - **HTTPS** (`USER_PASS_PLAINTEXT`): the saved username + the keychain
///   password for this repository. The username falls back to one embedded in
///   the URL, then `git`. This is the primary path.
/// - **SSH** (`SSH_KEY`): ssh-agent first, then the first default `~/.ssh` key.
///   The advanced path, for users who already use SSH.
///
/// When nothing resolves, libgit2 surfaces an auth error; the fetch/push
/// command surfaces it to the user rather than blocking. Returning callbacks
/// (not performing auth here) keeps this layer free of any UI concern.
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
        assert_eq!(normalize_remote("https://codeberg.org/joch/notes.git"), canonical);
        assert_eq!(normalize_remote("https://codeberg.org/joch/notes"), canonical);
        assert_eq!(normalize_remote("git@codeberg.org:joch/notes.git"), canonical);
        assert_eq!(normalize_remote("ssh://git@codeberg.org/joch/notes"), canonical);
        assert_eq!(normalize_remote("  HTTPS://Codeberg.org/joch/Notes.git/ "), canonical);
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
        assert!(!GitIdentity { name: "A".into(), email: "  ".into() }.is_complete());
        assert!(GitIdentity { name: "A".into(), email: "a@b.c".into() }.is_complete());
    }
}
