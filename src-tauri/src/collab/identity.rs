//! Collaborator identity: handles, composite note ids, and the local
//! "which collaborator am I" pin.
//!
//! A collaborator is identified by a **handle** — a short, stable,
//! filename-safe token (`joshua-chalifour`). The handle, not the display
//! name, is what appears in vector clocks and composite note ids, so a
//! later spelling fix to the display name never orphans version history.
//! Handles are *seeded* from the name as a convenience, then frozen.
//!
//! A note's durable identity is its **collabid**: `<zid>-<handle>` of the
//! collaborator who created it ("birth author"). Because the handle is
//! globally distinct within a collection, two collaborators creating a
//! note in the same wall-clock second get different collabids — the ZID
//! timestamp collision is resolved by construction, not probability.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::errors::Result;

/// Derive a starting handle from a display name: lowercase, ASCII
/// alphanumerics kept, runs of whitespace / `-` / `_` collapsed to a
/// single hyphen, everything else (punctuation, non-ASCII letters)
/// dropped. Constrained to `[a-z0-9-]` so it is safe to embed in a
/// collabid and, ultimately, a filename on every platform.
///
/// Non-ASCII names degrade rather than fail (`José García` →
/// `jos-garca`); the result is only a *seed* the user can edit before it
/// is frozen, and an all-dropped name falls back to `author`.
pub fn seed_handle(name: &str) -> String {
    let mut out = String::new();
    let mut last_hyphen = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_hyphen = false;
        } else if c.is_whitespace() || c == '-' || c == '_' {
            if !out.is_empty() && !last_hyphen {
                out.push('-');
                last_hyphen = true;
            }
        }
        // else: drop
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "author".to_string()
    } else {
        out
    }
}

/// Make `seed` unique within `existing` by appending `-2`, `-3`, … until
/// it is free. Returns `seed` unchanged when already unique.
pub fn unique_handle(seed: &str, existing: &HashSet<String>) -> String {
    if !existing.contains(seed) {
        return seed.to_string();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{seed}-{n}");
        if !existing.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Build a composite note id from a ZID and a birth-author handle.
///
/// Hyphens are stripped from the ZID component first so the id can be
/// split back at its first hyphen unambiguously even when the user's
/// `zid_pattern` contains separators (e.g. `YYYY-MM-DD`). The handle —
/// which legitimately contains hyphens — is everything after that first
/// hyphen.
pub fn make_collabid(zid: &str, handle: &str) -> String {
    let zid_clean: String = zid.chars().filter(|c| *c != '-').collect();
    format!("{zid_clean}-{handle}")
}

/// Extract the birth-author handle from a collabid, or `None` if the id
/// isn't well-formed. Used for filename-collision suffixing on import.
pub fn birth_author(collabid: &str) -> Option<&str> {
    collabid.split_once('-').map(|(_, handle)| handle)
}

/// Which collaborator the local user is, for one collection. Stored in
/// `me.json` and never travels in a package — identity is per-machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalIdentity {
    pub handle: String,
}

fn me_path(collab_dir: &Path) -> PathBuf {
    collab_dir.join("me.json")
}

/// Read the local identity pin, or `None` if the user hasn't chosen which
/// collaborator they are for this collection yet.
pub fn load_me(collab_dir: &Path) -> Result<Option<LocalIdentity>> {
    match std::fs::read_to_string(me_path(collab_dir)) {
        Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Persist the local identity pin, creating the collab directory if needed.
pub fn save_me(collab_dir: &Path, id: &LocalIdentity) -> Result<()> {
    std::fs::create_dir_all(collab_dir)?;
    let json = serde_json::to_string_pretty(id)?;
    std::fs::write(me_path(collab_dir), json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_handle_basic() {
        assert_eq!(seed_handle("Joshua Chalifour"), "joshua-chalifour");
        assert_eq!(seed_handle("  Jane   Doe  "), "jane-doe");
        assert_eq!(seed_handle("J. R. R. Tolkien"), "j-r-r-tolkien");
        assert_eq!(seed_handle("already-hyphenated"), "already-hyphenated");
        assert_eq!(seed_handle("under_score_name"), "under-score-name");
    }

    #[test]
    fn seed_handle_degrades_and_falls_back() {
        // Non-ASCII letters are dropped, not transliterated.
        assert_eq!(seed_handle("José García"), "jos-garca");
        // An all-dropped name falls back to a generic seed.
        assert_eq!(seed_handle("日本語"), "author");
        assert_eq!(seed_handle("!!!"), "author");
    }

    #[test]
    fn unique_handle_suffixes_on_collision() {
        let mut existing = HashSet::new();
        assert_eq!(unique_handle("alice", &existing), "alice");
        existing.insert("alice".to_string());
        assert_eq!(unique_handle("alice", &existing), "alice-2");
        existing.insert("alice-2".to_string());
        assert_eq!(unique_handle("alice", &existing), "alice-3");
    }

    #[test]
    fn collabid_round_trips_with_hyphenated_handle() {
        let id = make_collabid("20260521143000", "joshua-chalifour");
        assert_eq!(id, "20260521143000-joshua-chalifour");
        assert_eq!(birth_author(&id), Some("joshua-chalifour"));
    }

    #[test]
    fn collabid_strips_hyphens_from_zid_for_unambiguous_split() {
        // Even a hyphenated zid_pattern stays splittable.
        let id = make_collabid("2026-05-21", "jane-doe");
        assert_eq!(id, "20260521-jane-doe");
        assert_eq!(birth_author(&id), Some("jane-doe"));
    }

    #[test]
    fn same_zid_different_authors_are_distinct_ids() {
        let a = make_collabid("20260521143000", "alice");
        let b = make_collabid("20260521143000", "bob");
        assert_ne!(a, b);
    }

    #[test]
    fn me_json_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_me(dir.path()).unwrap().is_none());
        let id = LocalIdentity { handle: "alice".into() };
        save_me(dir.path(), &id).unwrap();
        assert_eq!(load_me(dir.path()).unwrap().unwrap(), id);
    }
}
