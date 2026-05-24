//! The per-collection version sidecar (`versions.json`).
//!
//! One file per collaborative collection at
//! `.inkycap/collab/<collection-id>/versions.json`. It is the thing that
//! travels inside a package and the thing the importer compares against
//! the local copy. It maps each note's [`collabid`](super) to its
//! [`VectorClock`], current path, content hash, and optional tombstone,
//! plus a parallel map for shared-bibliography entries.
//!
//! This module owns the schema and its serialization; the decision logic
//! that *compares* two `VersionsFile`s lives in `review.rs` (a later
//! slice). Mutators here are the small, local edits the save path and
//! migration perform.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::clock::{Tombstone, VectorClock};
use crate::errors::Result;

/// Current on-disk schema version. Bump when the shape changes
/// incompatibly so a future loader can migrate.
pub const SCHEMA_VERSION: u32 = 1;

/// One note's version record, keyed by `collabid` in [`VersionsFile::notes`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteVersion {
    /// Per-collaborator edit counters for this note.
    pub clock: VectorClock,
    /// Current notebox-relative path, for display and filename-collision
    /// handling. Not part of identity — the `collabid` is.
    pub path: String,
    /// Content hash (`"sha256:…"`) as of this clock. `None` for a
    /// tombstoned note (no content to hash). Lets the importer collapse
    /// no-op fast-forwards and auto-resolve byte-identical concurrent
    /// edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// Present when the note has been deleted. See [`Tombstone`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tombstone: Option<Tombstone>,
}

impl NoteVersion {
    pub fn is_deleted(&self) -> bool {
        self.tombstone.is_some()
    }
}

/// Metadata for one shared-bibliography entry, keyed by citation key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BibEntryMeta {
    /// Hash of the entry's serialized form, to detect divergent edits to
    /// the same citation key.
    pub hash: String,
    /// Handle of the collaborator who first contributed this entry.
    pub added_by: String,
}

/// The bibliography section of the sidecar: `citation key -> metadata`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BibVersions(pub BTreeMap<String, BibEntryMeta>);

/// One referenced attachment's version record, keyed by its notebox-relative
/// path in [`VersionsFile::attachments`]. Binary assets have no clock of their
/// own in the document, so we attach one here: the per-collaborator counter
/// lets the importer distinguish a one-sided change (take it silently) from a
/// genuine two-sided conflict (ask the user), exactly as notes are compared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentVersion {
    /// Per-collaborator edit counters for this attachment.
    pub clock: VectorClock,
    /// Content hash (`"sha256:…"`) of the bytes as of this clock.
    pub hash: String,
}

/// The whole sidecar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionsFile {
    pub schema: u32,
    /// Stable id of the collection this sidecar describes (see
    /// [`super::collection_id`]). Self-describing so a package remains
    /// interpretable even if the receiving notebox keys its directory
    /// differently.
    pub collection_id: String,
    /// `collabid -> NoteVersion`.
    #[serde(default)]
    pub notes: BTreeMap<String, NoteVersion>,
    #[serde(default)]
    pub bibliography: BibVersions,
    /// `notebox-relative attachment path -> AttachmentVersion`. Added after
    /// the initial schema; `#[serde(default)]` so an older sidecar (or
    /// package) without it still loads — its attachments are simply untracked
    /// and reconcile as conservative conflicts rather than silent overwrites.
    #[serde(default)]
    pub attachments: BTreeMap<String, AttachmentVersion>,
}

impl VersionsFile {
    /// A fresh, empty sidecar for `collection_id`.
    pub fn new(collection_id: impl Into<String>) -> Self {
        Self {
            schema: SCHEMA_VERSION,
            collection_id: collection_id.into(),
            notes: BTreeMap::new(),
            bibliography: BibVersions::default(),
            attachments: BTreeMap::new(),
        }
    }

    /// Load from `path`. Returns `Ok(None)` when the file does not exist
    /// (the normal state before a collection is made collaborative). A
    /// malformed file is a real error so corruption surfaces rather than
    /// silently resetting version history.
    pub fn load(path: &Path) -> Result<Option<Self>> {
        match std::fs::read_to_string(path) {
            Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Write to `path`, creating parent directories. Written pretty so the
    /// sidecar diffs cleanly if a user ever inspects it.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    /// Record a meaningful local edit: bump `handle`'s counter for the
    /// note, refresh its path and hash, and clear any tombstone (a
    /// re-creation revives the note). Inserts the note if new.
    pub fn record_edit(&mut self, collabid: &str, handle: &str, path: &str, hash: String) {
        let entry = self.notes.entry(collabid.to_string()).or_insert(NoteVersion {
            clock: VectorClock::new(),
            path: path.to_string(),
            hash: None,
            tombstone: None,
        });
        entry.clock.bump(handle);
        entry.path = path.to_string();
        entry.hash = Some(hash);
        entry.tombstone = None;
    }

    /// Record an attachment's current bytes: bump `handle`'s counter and
    /// update the hash, but only when the content actually changed (a fresh
    /// hash, or a path we weren't tracking). Returns whether anything changed —
    /// so packaging only re-saves the sidecar when an attachment truly moved.
    /// Mirrors the lazy, hash-based edit capture used for notes.
    pub fn record_attachment_edit(&mut self, path: &str, handle: &str, hash: String) -> bool {
        match self.attachments.get_mut(path) {
            Some(av) if av.hash == hash => false,
            Some(av) => {
                av.clock.bump(handle);
                av.hash = hash;
                true
            }
            None => {
                let mut clock = VectorClock::new();
                clock.bump(handle);
                self.attachments
                    .insert(path.to_string(), AttachmentVersion { clock, hash });
                true
            }
        }
    }

    /// Mark a note deleted by `handle`. The tombstone captures the note's
    /// clock (bumped once for the deletion) so the delete participates in
    /// clock comparison on import. No-op if the note is unknown.
    pub fn record_delete(&mut self, collabid: &str, handle: &str) {
        if let Some(entry) = self.notes.get_mut(collabid) {
            entry.clock.bump(handle);
            entry.hash = None;
            entry.tombstone = Some(Tombstone {
                by: handle.to_string(),
                clock: entry.clock.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_edit_inserts_then_bumps() {
        let mut v = VersionsFile::new("col-1");
        v.record_edit("zid-alice", "alice", "a.typ", "sha256:aaa".into());
        v.record_edit("zid-alice", "alice", "a.typ", "sha256:bbb".into());
        let note = &v.notes["zid-alice"];
        assert_eq!(note.clock.get("alice"), 2);
        assert_eq!(note.hash.as_deref(), Some("sha256:bbb"));
        assert!(!note.is_deleted());
    }

    #[test]
    fn record_delete_sets_tombstone_with_bumped_clock() {
        let mut v = VersionsFile::new("col-1");
        v.record_edit("zid-alice", "alice", "a.typ", "sha256:aaa".into());
        v.record_delete("zid-alice", "alice");
        let note = &v.notes["zid-alice"];
        assert!(note.is_deleted());
        assert!(note.hash.is_none());
        let tomb = note.tombstone.as_ref().unwrap();
        assert_eq!(tomb.by, "alice");
        // Clock advanced from 1 (the edit) to 2 (the delete).
        assert_eq!(tomb.clock.get("alice"), 2);
    }

    #[test]
    fn re_edit_after_delete_revives_note() {
        let mut v = VersionsFile::new("col-1");
        v.record_edit("zid-alice", "alice", "a.typ", "sha256:aaa".into());
        v.record_delete("zid-alice", "alice");
        v.record_edit("zid-alice", "alice", "a.typ", "sha256:ccc".into());
        let note = &v.notes["zid-alice"];
        assert!(!note.is_deleted());
        assert_eq!(note.clock.get("alice"), 3);
    }

    #[test]
    fn record_attachment_edit_inserts_then_bumps_only_on_change() {
        let mut v = VersionsFile::new("col-1");
        // First sight of the attachment: inserts, clock = 1.
        assert!(v.record_attachment_edit("img/a.png", "alice", "sha256:aaa".into()));
        assert_eq!(v.attachments["img/a.png"].clock.get("alice"), 1);
        // Same hash again: no-op, clock unchanged.
        assert!(!v.record_attachment_edit("img/a.png", "alice", "sha256:aaa".into()));
        assert_eq!(v.attachments["img/a.png"].clock.get("alice"), 1);
        // New content: bumps.
        assert!(v.record_attachment_edit("img/a.png", "alice", "sha256:bbb".into()));
        assert_eq!(v.attachments["img/a.png"].clock.get("alice"), 2);
        assert_eq!(v.attachments["img/a.png"].hash, "sha256:bbb");
    }

    #[test]
    fn save_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("versions.json");

        let mut v = VersionsFile::new("col-1");
        v.record_edit("zid-alice", "alice", "a.typ", "sha256:aaa".into());
        v.bibliography.0.insert(
            "smith2020".into(),
            BibEntryMeta { hash: "sha256:zzz".into(), added_by: "alice".into() },
        );
        v.record_attachment_edit("img/a.png", "alice", "sha256:img".into());
        v.save(&path).unwrap();

        let loaded = VersionsFile::load(&path).unwrap().unwrap();
        assert_eq!(loaded, v);
    }

    #[test]
    fn load_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope.json");
        assert!(VersionsFile::load(&path).unwrap().is_none());
    }
}
