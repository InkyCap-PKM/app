//! Structured 3-way merge for JSON documents — used to reconcile the shared
//! `.inkycap/settings.json` when both collaborators edited it.
//!
//! A whole-file pick ("keep mine" / "take theirs") is the wrong model for
//! settings: the file is a nested object of config sections, so two people
//! editing *different* keys (one changes the citation path, the other the
//! attachment folder) should keep *both* edits, not force a winner. This module
//! merges key-by-key: agreements and one-sided changes resolve automatically;
//! only a true same-key-different-value clash needs a hand decision.
//!
//! The merge is recursive over JSON objects. Arrays and scalars are atomic —
//! a differing array is a single clash (settings arrays are small, and there's
//! no stable identity to merge their elements on).

use serde::Serialize;
use serde_json::{Map, Value};

/// One key both sides changed to different values — needs a hand pick. The
/// `path` is dotted (e.g. `"citations.zotero_path"`); the merged document
/// defaults to [`mine`](Self::mine) until the user chooses otherwise.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyConflict {
    pub path: String,
    pub mine: Value,
    pub theirs: Value,
}

/// The outcome of a 3-way JSON merge.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonMerge {
    /// The merged document. Non-conflicting keys are unioned automatically;
    /// each conflicting key defaults to mine (flip individual keys with
    /// [`set_at_path`]).
    pub merged: Value,
    /// Keys both sides changed differently. Empty ⇒ a fully automatic merge.
    pub conflicts: Vec<KeyConflict>,
}

/// Merge `mine` and `theirs` against their common ancestor `base`.
pub fn three_way(base: &Value, mine: &Value, theirs: &Value) -> JsonMerge {
    let mut conflicts = Vec::new();
    let merged = merge_value("", base, mine, theirs, &mut conflicts);
    JsonMerge { merged, conflicts }
}

fn merge_value(
    path: &str,
    base: &Value,
    mine: &Value,
    theirs: &Value,
    conflicts: &mut Vec<KeyConflict>,
) -> Value {
    // Agreement (including both-unchanged), or only one side moved off base.
    if mine == theirs || theirs == base {
        return mine.clone();
    }
    if mine == base {
        return theirs.clone();
    }

    // Both changed differently. Recurse when both are objects so distinct keys
    // still merge; otherwise it's an atomic clash (scalar, array, type change).
    if let (Value::Object(mo), Value::Object(to)) = (mine, theirs) {
        let empty = Map::new();
        let bo = base.as_object().unwrap_or(&empty);
        let mut out = Map::new();

        // Stable order: mine's keys first, then theirs-only keys.
        let mut keys: Vec<&String> = mo.keys().collect();
        for k in to.keys() {
            if !mo.contains_key(k) {
                keys.push(k);
            }
        }

        for k in keys {
            let child_path = if path.is_empty() {
                k.clone()
            } else {
                format!("{path}.{k}")
            };
            let null = Value::Null;
            let bv = bo.get(k).unwrap_or(&null);
            match (mo.get(k), to.get(k)) {
                (Some(mv), Some(tv)) => {
                    out.insert(k.clone(), merge_value(&child_path, bv, mv, tv, conflicts));
                }
                // Present on one side only. Accept a deletion only when the
                // other side left the value untouched; otherwise keep the
                // surviving value (a change-vs-delete biases toward keeping).
                (Some(mv), None) => {
                    if !(bo.contains_key(k) && bv == mv) {
                        out.insert(k.clone(), mv.clone());
                    }
                }
                (None, Some(tv)) => {
                    if !(bo.contains_key(k) && bv == tv) {
                        out.insert(k.clone(), tv.clone());
                    }
                }
                (None, None) => {}
            }
        }
        return Value::Object(out);
    }

    // Atomic clash — default to mine, record it for a hand pick.
    conflicts.push(KeyConflict {
        path: path.to_string(),
        mine: mine.clone(),
        theirs: theirs.clone(),
    });
    mine.clone()
}

/// Set the value at a dotted `path` (e.g. `"citations.zotero_path"`) in an
/// object tree, creating intermediate objects as needed. Used to flip a
/// conflicting key to "theirs" after the user decides. No-op if a path segment
/// runs through a non-object.
pub fn set_at_path(root: &mut Value, path: &str, value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = root;
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        match cur {
            Value::Object(map) => {
                if last {
                    map.insert((*part).to_string(), value);
                    return;
                }
                cur = map
                    .entry((*part).to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
            }
            _ => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn distinct_keys_union_without_conflict() {
        let base = json!({ "a": 1, "b": 2 });
        let mine = json!({ "a": 9, "b": 2 }); // changed a
        let theirs = json!({ "a": 1, "b": 8 }); // changed b
        let m = three_way(&base, &mine, &theirs);
        assert!(m.conflicts.is_empty(), "different keys don't clash");
        assert_eq!(m.merged, json!({ "a": 9, "b": 8 }));
    }

    #[test]
    fn same_key_different_value_conflicts_and_defaults_to_mine() {
        let base = json!({ "view": "source" });
        let mine = json!({ "view": "reading" });
        let theirs = json!({ "view": "live" });
        let m = three_way(&base, &mine, &theirs);
        assert_eq!(m.conflicts.len(), 1);
        assert_eq!(m.conflicts[0].path, "view");
        assert_eq!(m.conflicts[0].mine, json!("reading"));
        assert_eq!(m.conflicts[0].theirs, json!("live"));
        assert_eq!(
            m.merged,
            json!({ "view": "reading" }),
            "merged defaults to mine"
        );
    }

    #[test]
    fn same_change_on_both_sides_is_not_a_conflict() {
        let base = json!({ "view": "source" });
        let same = json!({ "view": "reading" });
        let m = three_way(&base, &same, &same);
        assert!(m.conflicts.is_empty());
        assert_eq!(m.merged, json!({ "view": "reading" }));
    }

    #[test]
    fn nested_objects_merge_per_key() {
        let base = json!({ "citations": { "path": "a.bib", "style": "apa" } });
        let mine = json!({ "citations": { "path": "mine.bib", "style": "apa" } });
        let theirs = json!({ "citations": { "path": "a.bib", "style": "mla" } });
        let m = three_way(&base, &mine, &theirs);
        assert!(m.conflicts.is_empty(), "nested distinct keys merge");
        assert_eq!(
            m.merged,
            json!({ "citations": { "path": "mine.bib", "style": "mla" } })
        );
    }

    #[test]
    fn nested_same_key_clash_reports_dotted_path() {
        let base = json!({ "citations": { "style": "apa" } });
        let mine = json!({ "citations": { "style": "mla" } });
        let theirs = json!({ "citations": { "style": "chicago" } });
        let m = three_way(&base, &mine, &theirs);
        assert_eq!(m.conflicts.len(), 1);
        assert_eq!(m.conflicts[0].path, "citations.style");
    }

    #[test]
    fn added_key_on_one_side_is_kept() {
        let base = json!({ "a": 1 });
        let mine = json!({ "a": 1, "new": true });
        let theirs = json!({ "a": 1 });
        let m = three_way(&base, &mine, &theirs);
        assert!(m.conflicts.is_empty());
        assert_eq!(m.merged, json!({ "a": 1, "new": true }));
    }

    #[test]
    fn one_sided_deletion_is_accepted() {
        let base = json!({ "a": 1, "gone": 2 });
        let mine = json!({ "a": 1 }); // mine deleted "gone"
        let theirs = json!({ "a": 1, "gone": 2 }); // theirs untouched
        let m = three_way(&base, &mine, &theirs);
        assert!(m.conflicts.is_empty());
        assert_eq!(m.merged, json!({ "a": 1 }), "deletion sticks");
    }

    #[test]
    fn differing_arrays_are_an_atomic_clash() {
        let base = json!({ "fonts": ["a"] });
        let mine = json!({ "fonts": ["a", "b"] });
        let theirs = json!({ "fonts": ["a", "c"] });
        let m = three_way(&base, &mine, &theirs);
        assert_eq!(m.conflicts.len(), 1);
        assert_eq!(m.conflicts[0].path, "fonts");
    }

    #[test]
    fn set_at_path_flips_a_nested_key_to_theirs() {
        let mut merged = json!({ "citations": { "style": "mla" } });
        set_at_path(&mut merged, "citations.style", json!("chicago"));
        assert_eq!(merged, json!({ "citations": { "style": "chicago" } }));
    }
}
