//! Vector clocks — the heart of package-handoff collaboration.
//!
//! Each collaborative note carries a [`VectorClock`]: a map from
//! collaborator *handle* to that collaborator's monotonic edit counter
//! for the note. Comparing two clocks under the vector-clock partial
//! order tells us, without any shared history, whether one version
//! descends from the other (a clean fast-forward) or whether the two
//! were edited independently (a concurrent edit that needs review).
//!
//! This module is pure logic with no I/O, so the merge math can be
//! exhaustively unit-tested in isolation — which matters, because it is
//! the single most correctness-critical piece of the feature.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// A vector clock for one note: `handle -> edit counter`.
///
/// A `BTreeMap` (not `HashMap`) so serialization is deterministic — two
/// machines that hold the same logical clock write byte-identical JSON,
/// which keeps content hashing and diffing stable across collaborators.
/// `#[serde(transparent)]` so it stores as a bare object
/// (`{"alice": 3, "bob": 5}`) rather than a wrapped tuple.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VectorClock(BTreeMap<String, u64>);

/// Result of comparing two clocks under the vector-clock partial order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockOrdering {
    /// Identical counters for every handle.
    Equal,
    /// `self` is strictly ahead of `other` — every counter ≥ and at
    /// least one >. The incoming-side reading of this is "fast-forward".
    Dominates,
    /// `self` is strictly behind `other` (the mirror of `Dominates`).
    DominatedBy,
    /// Neither dominates: each has at least one counter the other lacks
    /// or exceeds. This is a genuinely concurrent edit.
    Concurrent,
}

impl VectorClock {
    pub fn new() -> Self {
        Self(BTreeMap::new())
    }

    /// This handle's counter, or 0 if the handle has never edited.
    pub fn get(&self, handle: &str) -> u64 {
        self.0.get(handle).copied().unwrap_or(0)
    }

    /// Iterate `(handle, counter)` pairs in deterministic (sorted) order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, u64)> {
        self.0.iter().map(|(k, v)| (k.as_str(), *v))
    }

    /// Increment one handle's counter, returning the new value. Used when
    /// the local user saves a meaningful change to a note they're editing.
    pub fn bump(&mut self, handle: &str) -> u64 {
        let entry = self.0.entry(handle.to_string()).or_insert(0);
        *entry += 1;
        *entry
    }

    /// Set a handle's counter directly. Mainly for tests and migration.
    pub fn set(&mut self, handle: &str, value: u64) {
        self.0.insert(handle.to_string(), value);
    }

    /// True when no handle has recorded any edit.
    pub fn is_empty(&self) -> bool {
        self.0.values().all(|&v| v == 0)
    }

    /// Merge `other` into `self` by taking the cell-wise maximum of every
    /// counter. This is how an accepted incoming version folds into the
    /// local clock, and how two `versions.json` files reconcile: the
    /// least upper bound in the lattice, so the result dominates both
    /// inputs.
    pub fn merge(&mut self, other: &VectorClock) {
        for (handle, &counter) in &other.0 {
            let entry = self.0.entry(handle.clone()).or_insert(0);
            if counter > *entry {
                *entry = counter;
            }
        }
    }

    /// Compare against `other` under the vector-clock partial order.
    pub fn compare(&self, other: &VectorClock) -> ClockOrdering {
        let mut self_greater = false;
        let mut other_greater = false;

        // Walk the union of handles; a handle absent on one side reads as 0.
        let handles: BTreeSet<&String> = self.0.keys().chain(other.0.keys()).collect();
        for handle in handles {
            let a = self.0.get(handle).copied().unwrap_or(0);
            let b = other.0.get(handle).copied().unwrap_or(0);
            if a > b {
                self_greater = true;
            }
            if b > a {
                other_greater = true;
            }
            // Once both directions are set, the result is Concurrent
            // regardless of remaining handles — short-circuit.
            if self_greater && other_greater {
                return ClockOrdering::Concurrent;
            }
        }

        match (self_greater, other_greater) {
            (false, false) => ClockOrdering::Equal,
            (true, false) => ClockOrdering::Dominates,
            (false, true) => ClockOrdering::DominatedBy,
            (true, true) => ClockOrdering::Concurrent, // unreachable via short-circuit
        }
    }
}

/// A delete record. A delete has no content to clock-compare, so instead
/// of dropping a note's entry we mark it with the clock as of deletion.
/// On import, the tombstone's clock is compared against the local note
/// clock exactly like an edit: dominates → delete locally; concurrent
/// with a local edit → a delete-vs-edit conflict for the user to resolve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    /// Handle of the collaborator who deleted the note.
    pub by: String,
    /// The note's clock at the moment of deletion.
    pub clock: VectorClock,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(pairs: &[(&str, u64)]) -> VectorClock {
        let mut c = VectorClock::new();
        for (h, v) in pairs {
            c.set(h, *v);
        }
        c
    }

    #[test]
    fn equal_clocks() {
        let a = clock(&[("alice", 2), ("bob", 1)]);
        let b = clock(&[("alice", 2), ("bob", 1)]);
        assert_eq!(a.compare(&b), ClockOrdering::Equal);
    }

    #[test]
    fn absent_handle_reads_as_zero() {
        // {alice:1} vs {alice:1, bob:0} are equal — an absent handle is 0.
        let a = clock(&[("alice", 1)]);
        let b = clock(&[("alice", 1), ("bob", 0)]);
        assert_eq!(a.compare(&b), ClockOrdering::Equal);
    }

    #[test]
    fn fast_forward_dominates() {
        // Turn-taking: {alice:1} -> Bob edits -> {alice:1, bob:1}.
        let local = clock(&[("alice", 1)]);
        let incoming = clock(&[("alice", 1), ("bob", 1)]);
        assert_eq!(incoming.compare(&local), ClockOrdering::Dominates);
        assert_eq!(local.compare(&incoming), ClockOrdering::DominatedBy);
    }

    #[test]
    fn concurrent_edit_detected() {
        // Both start at {alice:1,bob:1}; each edits independently.
        let alice = clock(&[("alice", 2), ("bob", 1)]);
        let bob = clock(&[("alice", 1), ("bob", 2)]);
        assert_eq!(alice.compare(&bob), ClockOrdering::Concurrent);
        assert_eq!(bob.compare(&alice), ClockOrdering::Concurrent);
    }

    #[test]
    fn three_party_transitive_dominance() {
        // Carol at {1,1,1} receives a package carrying Alice's + Bob's
        // edits transitively at {2,2,1} — should fast-forward.
        let carol = clock(&[("alice", 1), ("bob", 1), ("carol", 1)]);
        let incoming = clock(&[("alice", 2), ("bob", 2), ("carol", 1)]);
        assert_eq!(incoming.compare(&carol), ClockOrdering::Dominates);
    }

    #[test]
    fn empty_clocks_are_equal() {
        assert_eq!(
            VectorClock::new().compare(&VectorClock::new()),
            ClockOrdering::Equal
        );
    }

    #[test]
    fn merge_takes_cellwise_max_and_dominates_both() {
        let mut a = clock(&[("alice", 2), ("bob", 1)]);
        let b = clock(&[("alice", 1), ("bob", 3), ("carol", 1)]);
        a.merge(&b);
        assert_eq!(a, clock(&[("alice", 2), ("bob", 3), ("carol", 1)]));
        // The merged clock dominates (or equals) both inputs.
        assert!(matches!(
            a.compare(&b),
            ClockOrdering::Dominates | ClockOrdering::Equal
        ));
    }

    #[test]
    fn bump_increments_from_zero() {
        let mut c = VectorClock::new();
        assert_eq!(c.bump("alice"), 1);
        assert_eq!(c.bump("alice"), 2);
        assert_eq!(c.get("alice"), 2);
        assert_eq!(c.get("bob"), 0);
    }

    #[test]
    fn serializes_transparently() {
        let c = clock(&[("alice", 3), ("bob", 5)]);
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, r#"{"alice":3,"bob":5}"#);
        let round: VectorClock = serde_json::from_str(&json).unwrap();
        assert_eq!(round, c);
    }
}
