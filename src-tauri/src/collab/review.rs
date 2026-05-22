//! Comparing an incoming sidecar against the local one to produce a
//! reviewable change set.
//!
//! This is the import-time decision engine. For every note (by collabid)
//! and every shared-bibliography entry (by citation key) present in
//! either sidecar, it decides one of:
//!   - **skip** — nothing to do (equal, local already ahead, a delete of a
//!     note we never had, or a fast-forward whose content is unchanged);
//!   - **auto-merge** — clocks differ but content is byte-identical, so we
//!     fold the clocks together silently with no user prompt;
//!   - **review** — a real change the user must accept/reject: added,
//!     modified, deleted, or a genuine conflict.
//!
//! Pure logic over two [`VersionsFile`]s; the apply step that *acts* on
//! these decisions lives in a later slice.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::clock::{ClockOrdering, VectorClock};
use super::versions::{NoteVersion, VersionsFile};

/// The kind of change a review item represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    /// A note new to this machine.
    Added,
    /// An existing note advanced to a newer version.
    Modified,
    /// An existing note was deleted by a collaborator.
    Deleted,
    /// Independent concurrent edits (or a delete-vs-edit clash).
    Conflict,
}

/// One note-level change awaiting the user's decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewItem {
    pub collabid: String,
    /// Notebox-relative path to show / write to.
    pub path: String,
    pub kind: ChangeKind,
    /// Collaborator handles responsible for the incoming change (the
    /// handles whose counters advanced, or the deleter for a tombstone),
    /// sorted for determinism.
    pub changed_by: Vec<String>,
}

/// The full classification of one import.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewResult {
    /// Notes needing a user decision.
    pub note_items: Vec<ReviewItem>,
    /// Collabids of notes with identical concurrent edits — clocks should
    /// be merged on apply, but there is nothing for the user to review.
    pub note_auto_merges: Vec<String>,
    /// Citation keys whose content diverged between sides — need review.
    pub bib_conflicts: Vec<String>,
    /// Citation keys added or unchanged — union-merged silently.
    pub bib_auto_merges: Vec<String>,
}

/// Internal per-note decision.
enum NoteAction {
    Skip,
    AutoMerge,
    Review(ChangeKind),
}

fn hashes_equal(a: &NoteVersion, b: &NoteVersion) -> bool {
    match (&a.hash, &b.hash) {
        (Some(x), Some(y)) => x == y,
        // A missing hash can't prove identity — never silently skip/merge.
        _ => false,
    }
}

fn classify_note(local: Option<&NoteVersion>, incoming: Option<&NoteVersion>) -> NoteAction {
    use ClockOrdering::*;
    match (local, incoming) {
        // Incoming says nothing about this note: absence is not deletion,
        // so our local copy (if any) stands.
        (_, None) => NoteAction::Skip,

        // New to us. A tombstone for a note we never had is a no-op.
        (None, Some(inc)) => {
            if inc.is_deleted() {
                NoteAction::Skip
            } else {
                NoteAction::Review(ChangeKind::Added)
            }
        }

        (Some(loc), Some(inc)) => match (loc.is_deleted(), inc.is_deleted()) {
            // Both gone — converged on deletion.
            (true, true) => NoteAction::Skip,

            // They deleted; we still have it. Compare the deletion's clock
            // to our live clock.
            (false, true) => {
                let tomb = inc.tombstone.as_ref().expect("is_deleted ⇒ tombstone");
                match tomb.clock.compare(&loc.clock) {
                    Dominates | Equal => NoteAction::Review(ChangeKind::Deleted),
                    DominatedBy => NoteAction::Skip, // our live edits postdate their delete
                    Concurrent => NoteAction::Review(ChangeKind::Conflict),
                }
            }

            // We deleted; they still have a live version. Compare their
            // clock to our deletion's clock.
            (true, false) => {
                let tomb = loc.tombstone.as_ref().expect("is_deleted ⇒ tombstone");
                match inc.clock.compare(&tomb.clock) {
                    Dominates => NoteAction::Review(ChangeKind::Added), // resurrected, newer
                    Equal | DominatedBy => NoteAction::Skip,            // our delete stands
                    Concurrent => NoteAction::Review(ChangeKind::Conflict),
                }
            }

            // Both live — the common case.
            (false, false) => match inc.clock.compare(&loc.clock) {
                Equal => NoteAction::Skip,
                DominatedBy => NoteAction::Skip, // we're ahead
                Dominates => {
                    if hashes_equal(loc, inc) {
                        NoteAction::Skip // no-op fast-forward
                    } else {
                        NoteAction::Review(ChangeKind::Modified)
                    }
                }
                Concurrent => {
                    if hashes_equal(loc, inc) {
                        NoteAction::AutoMerge // identical concurrent edit
                    } else {
                        NoteAction::Review(ChangeKind::Conflict)
                    }
                }
            },
        },
    }
}

/// Handles whose counter is higher in `inc` than in `local` (the
/// collaborators responsible for the incoming change). For an `Added`
/// note `local` is `None`, so every nonzero handle qualifies.
fn advanced_handles(local: Option<&VectorClock>, inc: &VectorClock) -> Vec<String> {
    inc.iter()
        .filter(|(h, v)| *v > local.map(|c| c.get(h)).unwrap_or(0))
        .map(|(h, _)| h.to_string())
        .collect()
}

fn changed_by(kind: ChangeKind, local: Option<&NoteVersion>, inc: &NoteVersion) -> Vec<String> {
    match kind {
        ChangeKind::Deleted => inc
            .tombstone
            .as_ref()
            .map(|t| vec![t.by.clone()])
            .unwrap_or_default(),
        _ => advanced_handles(local.map(|l| &l.clock), &inc.clock),
    }
}

/// Compare `incoming` against `local` and classify every note and
/// bibliography entry.
pub fn compute_review(local: &VersionsFile, incoming: &VersionsFile) -> ReviewResult {
    let mut result = ReviewResult::default();

    let ids: BTreeSet<&String> = local.notes.keys().chain(incoming.notes.keys()).collect();
    for id in ids {
        let loc = local.notes.get(id);
        let inc = incoming.notes.get(id);
        match classify_note(loc, inc) {
            NoteAction::Skip => {}
            NoteAction::AutoMerge => result.note_auto_merges.push(id.clone()),
            NoteAction::Review(kind) => {
                // `inc` is always Some for every reviewable kind — Added,
                // Modified, Conflict, and Deleted all require the incoming
                // side to mention the note.
                let inc = inc.expect("reviewable change ⇒ incoming present");
                let path = if inc.path.is_empty() {
                    loc.map(|n| n.path.clone()).unwrap_or_default()
                } else {
                    inc.path.clone()
                };
                result.note_items.push(ReviewItem {
                    collabid: id.clone(),
                    path,
                    kind,
                    changed_by: changed_by(kind, loc, inc),
                });
            }
        }
    }

    // Bibliography: union by key. New or identical → silent merge;
    // same key with diverged content → review.
    for (key, inc_meta) in &incoming.bibliography.0 {
        match local.bibliography.0.get(key) {
            None => result.bib_auto_merges.push(key.clone()),
            Some(loc_meta) if loc_meta.hash != inc_meta.hash => {
                result.bib_conflicts.push(key.clone())
            }
            Some(_) => result.bib_auto_merges.push(key.clone()),
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::clock::{Tombstone, VectorClock};
    use crate::collab::versions::{BibEntryMeta, VersionsFile};

    fn clock(pairs: &[(&str, u64)]) -> VectorClock {
        let mut c = VectorClock::new();
        for (h, v) in pairs {
            c.set(h, *v);
        }
        c
    }

    fn live(path: &str, clk: VectorClock, hash: &str) -> NoteVersion {
        NoteVersion { clock: clk, path: path.into(), hash: Some(hash.into()), tombstone: None }
    }

    fn dead(path: &str, by: &str, clk: VectorClock) -> NoteVersion {
        NoteVersion {
            clock: clk.clone(),
            path: path.into(),
            hash: None,
            tombstone: Some(Tombstone { by: by.into(), clock: clk }),
        }
    }

    /// Build a one-note sidecar.
    fn vf(id: &str, note: NoteVersion) -> VersionsFile {
        let mut v = VersionsFile::new("col");
        v.notes.insert(id.into(), note);
        v
    }

    fn classify(local: Option<&NoteVersion>, incoming: Option<&NoteVersion>) -> NoteAction {
        super::classify_note(local, incoming)
    }

    fn is_review(a: &NoteAction, k: ChangeKind) -> bool {
        matches!(a, NoteAction::Review(x) if *x == k)
    }

    #[test]
    fn added_when_incoming_only_and_live() {
        let inc = live("a.typ", clock(&[("alice", 1)]), "h1");
        assert!(is_review(&classify(None, Some(&inc)), ChangeKind::Added));
    }

    #[test]
    fn skip_when_incoming_only_tombstone() {
        let inc = dead("a.typ", "alice", clock(&[("alice", 2)]));
        assert!(matches!(classify(None, Some(&inc)), NoteAction::Skip));
    }

    #[test]
    fn skip_when_local_only() {
        let loc = live("a.typ", clock(&[("alice", 1)]), "h1");
        assert!(matches!(classify(Some(&loc), None), NoteAction::Skip));
    }

    #[test]
    fn skip_when_equal() {
        let loc = live("a.typ", clock(&[("alice", 1)]), "h1");
        let inc = live("a.typ", clock(&[("alice", 1)]), "h1");
        assert!(matches!(classify(Some(&loc), Some(&inc)), NoteAction::Skip));
    }

    #[test]
    fn modified_on_fast_forward_with_changed_hash() {
        let loc = live("a.typ", clock(&[("alice", 1)]), "h1");
        let inc = live("a.typ", clock(&[("alice", 1), ("bob", 1)]), "h2");
        assert!(is_review(&classify(Some(&loc), Some(&inc)), ChangeKind::Modified));
    }

    #[test]
    fn skip_on_fast_forward_with_same_hash() {
        // Clock advanced but content identical — no-op.
        let loc = live("a.typ", clock(&[("alice", 1)]), "h1");
        let inc = live("a.typ", clock(&[("alice", 1), ("bob", 1)]), "h1");
        assert!(matches!(classify(Some(&loc), Some(&inc)), NoteAction::Skip));
    }

    #[test]
    fn skip_when_local_dominates() {
        let loc = live("a.typ", clock(&[("alice", 2), ("bob", 1)]), "h2");
        let inc = live("a.typ", clock(&[("alice", 1)]), "h1");
        assert!(matches!(classify(Some(&loc), Some(&inc)), NoteAction::Skip));
    }

    #[test]
    fn auto_merge_on_identical_concurrent_edit() {
        let loc = live("a.typ", clock(&[("alice", 2), ("bob", 1)]), "same");
        let inc = live("a.typ", clock(&[("alice", 1), ("bob", 2)]), "same");
        assert!(matches!(classify(Some(&loc), Some(&inc)), NoteAction::AutoMerge));
    }

    #[test]
    fn conflict_on_divergent_concurrent_edit() {
        let loc = live("a.typ", clock(&[("alice", 2), ("bob", 1)]), "mine");
        let inc = live("a.typ", clock(&[("alice", 1), ("bob", 2)]), "theirs");
        assert!(is_review(&classify(Some(&loc), Some(&inc)), ChangeKind::Conflict));
    }

    #[test]
    fn deleted_when_incoming_tombstone_dominates() {
        let loc = live("a.typ", clock(&[("alice", 1)]), "h1");
        let inc = dead("a.typ", "bob", clock(&[("alice", 1), ("bob", 1)]));
        assert!(is_review(&classify(Some(&loc), Some(&inc)), ChangeKind::Deleted));
    }

    #[test]
    fn conflict_when_incoming_tombstone_concurrent_with_local_edit() {
        let loc = live("a.typ", clock(&[("alice", 2)]), "mine");
        let inc = dead("a.typ", "bob", clock(&[("alice", 1), ("bob", 1)]));
        assert!(is_review(&classify(Some(&loc), Some(&inc)), ChangeKind::Conflict));
    }

    #[test]
    fn skip_when_incoming_tombstone_dominated_by_local_edit() {
        let loc = live("a.typ", clock(&[("alice", 2), ("bob", 2)]), "newer");
        let inc = dead("a.typ", "bob", clock(&[("alice", 1), ("bob", 1)]));
        assert!(matches!(classify(Some(&loc), Some(&inc)), NoteAction::Skip));
    }

    #[test]
    fn resurrect_when_local_tombstone_dominated_by_incoming() {
        let loc = dead("a.typ", "alice", clock(&[("alice", 1)]));
        let inc = live("a.typ", clock(&[("alice", 1), ("bob", 1)]), "h2");
        assert!(is_review(&classify(Some(&loc), Some(&inc)), ChangeKind::Added));
    }

    #[test]
    fn conflict_when_local_tombstone_concurrent_with_incoming_edit() {
        let loc = dead("a.typ", "alice", clock(&[("alice", 2)]));
        let inc = live("a.typ", clock(&[("alice", 1), ("bob", 1)]), "h2");
        assert!(is_review(&classify(Some(&loc), Some(&inc)), ChangeKind::Conflict));
    }

    #[test]
    fn skip_when_both_tombstoned() {
        let loc = dead("a.typ", "alice", clock(&[("alice", 1)]));
        let inc = dead("a.typ", "bob", clock(&[("alice", 1), ("bob", 1)]));
        assert!(matches!(classify(Some(&loc), Some(&inc)), NoteAction::Skip));
    }

    #[test]
    fn changed_by_lists_advanced_handles() {
        let loc = live("a.typ", clock(&[("alice", 1)]), "h1");
        let inc = live("a.typ", clock(&[("alice", 1), ("bob", 2), ("carol", 1)]), "h2");
        let cb = super::changed_by(ChangeKind::Modified, Some(&loc), &inc);
        assert_eq!(cb, vec!["bob".to_string(), "carol".to_string()]);
    }

    #[test]
    fn changed_by_for_delete_is_the_deleter() {
        let inc = dead("a.typ", "bob", clock(&[("alice", 1), ("bob", 1)]));
        let cb = super::changed_by(ChangeKind::Deleted, None, &inc);
        assert_eq!(cb, vec!["bob".to_string()]);
    }

    #[test]
    fn compute_review_end_to_end() {
        // local: note X live; note Y live (will be locally ahead)
        let mut local = vf("zid-alice", live("x.typ", clock(&[("alice", 1)]), "x1"));
        local.notes.insert("zid-bob".into(), live("y.typ", clock(&[("bob", 2)]), "y2"));

        // incoming: X modified (FF), Y older (skip), Z new
        let mut incoming = vf("zid-alice", live("x.typ", clock(&[("alice", 1), ("bob", 1)]), "x2"));
        incoming.notes.insert("zid-bob".into(), live("y.typ", clock(&[("bob", 1)]), "y1"));
        incoming.notes.insert("zid-carol".into(), live("z.typ", clock(&[("carol", 1)]), "z1"));

        // bib: shared has one new key + one conflicting key
        local.bibliography.0.insert(
            "smith".into(),
            BibEntryMeta { hash: "s1".into(), added_by: "alice".into() },
        );
        incoming.bibliography.0.insert(
            "smith".into(),
            BibEntryMeta { hash: "s2".into(), added_by: "bob".into() },
        );
        incoming.bibliography.0.insert(
            "jones".into(),
            BibEntryMeta { hash: "j1".into(), added_by: "bob".into() },
        );

        let r = compute_review(&local, &incoming);
        let kinds: Vec<_> = r.note_items.iter().map(|i| (i.collabid.as_str(), i.kind)).collect();
        assert!(kinds.contains(&("zid-alice", ChangeKind::Modified)));
        assert!(kinds.contains(&("zid-carol", ChangeKind::Added)));
        // zid-bob: local ahead → not reviewed
        assert!(!kinds.iter().any(|(id, _)| *id == "zid-bob"));
        assert_eq!(r.bib_conflicts, vec!["smith".to_string()]);
        assert_eq!(r.bib_auto_merges, vec!["jones".to_string()]);
    }
}
