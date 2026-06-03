//! Line-level hunk diff and per-hunk revert for the merge-first "Changes since
//! last sync" review.
//!
//! The merge-first collaboration model (see [`crate::commands::git`]) never
//! pauses: a Sync / package import always lands incoming changes, taking
//! *theirs* on an overlap, and the user reverts anything they disagree with
//! afterwards. This module is the diff/revert core behind that "revert later"
//! gesture. It compares the **baseline** (the note as it stood just before the
//! sync, read from the recorded `last_sync_oid` commit) against the **current**
//! working-tree text, splits the difference into hunks, and reconstructs the
//! text with any one hunk reverted to its baseline form.
//!
//! It is deliberately pure (`&str` in, value out) so it unit-tests without a
//! repo or the filesystem; the [`crate::commands::git`] layer reads the two
//! sides and writes the result through [`crate::storage`].
//!
//! Line diffing reuses the same `similar` engine as [`crate::git::suggest`] so
//! the two review surfaces agree on hunk boundaries.

use similar::{capture_diff_slices, Algorithm, DiffOp};

/// One contiguous region that differs between the baseline and current text.
///
/// Identity and the editor scroll target are the **current**-side line range:
/// `[current_start, current_end)`, 0-based and end-exclusive over the current
/// text's lines. A pure deletion (a region present in the baseline but gone now)
/// is zero-width — `current_start == current_end` at the point the lines were
/// removed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHunk {
    /// First current-side line this hunk occupies (0-based).
    pub current_start: usize,
    /// One past the last current-side line (end-exclusive). Equals
    /// `current_start` for a pure deletion.
    pub current_end: usize,
    /// The baseline (pre-sync) text for this region — what a revert restores.
    /// Empty when the current text *added* the region (nothing to restore to).
    pub baseline_text: String,
    /// The current text for this region — what is there now. Empty when the
    /// current text *deleted* a baseline region.
    pub current_text: String,
}

/// Split `text` into lines that keep their terminators, so concatenating them
/// reproduces the original byte-for-byte (including a missing final newline).
/// An empty string yields no lines.
fn split_lines_keep_terminator(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            out.push(&text[start..=i]);
            start = i + 1;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

fn concat(lines: &[&str]) -> String {
    lines.concat()
}

/// The current-side line range a non-`Equal` op occupies, or `None` for an
/// `Equal` op (which is not a hunk).
fn current_range(op: &DiffOp) -> Option<(usize, usize)> {
    match *op {
        DiffOp::Equal { .. } => None,
        // A deletion is zero-width on the current side, at `new_index`.
        DiffOp::Delete { new_index, .. } => Some((new_index, new_index)),
        DiffOp::Insert {
            new_index, new_len, ..
        } => Some((new_index, new_index + new_len)),
        DiffOp::Replace {
            new_index, new_len, ..
        } => Some((new_index, new_index + new_len)),
    }
}

/// Diff `baseline` → `current` into hunks (one per changed region). Returns an
/// empty list when the two are identical.
pub fn diff_hunks(baseline: &str, current: &str) -> Vec<SyncHunk> {
    if baseline == current {
        return Vec::new();
    }
    let base_lines = split_lines_keep_terminator(baseline);
    let cur_lines = split_lines_keep_terminator(current);
    let ops = capture_diff_slices(Algorithm::Myers, &base_lines, &cur_lines);

    let mut hunks = Vec::new();
    for op in &ops {
        let (start, end) = match current_range(op) {
            Some(r) => r,
            None => continue,
        };
        let (baseline_text, current_text) = match *op {
            DiffOp::Delete {
                old_index, old_len, ..
            } => (
                concat(&base_lines[old_index..old_index + old_len]),
                String::new(),
            ),
            DiffOp::Insert {
                new_index, new_len, ..
            } => (
                String::new(),
                concat(&cur_lines[new_index..new_index + new_len]),
            ),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => (
                concat(&base_lines[old_index..old_index + old_len]),
                concat(&cur_lines[new_index..new_index + new_len]),
            ),
            DiffOp::Equal { .. } => unreachable!("filtered by current_range"),
        };
        hunks.push(SyncHunk {
            current_start: start,
            current_end: end,
            baseline_text,
            current_text,
        });
    }
    hunks
}

/// Rebuild `current` with the single hunk at current-side range
/// `[current_start, current_end)` reverted to its baseline form, leaving every
/// other hunk untouched. Returns `None` when no hunk matches that exact range
/// (the file changed since the diff was computed — the caller should refetch).
pub fn revert_hunk(
    baseline: &str,
    current: &str,
    current_start: usize,
    current_end: usize,
) -> Option<String> {
    let base_lines = split_lines_keep_terminator(baseline);
    let cur_lines = split_lines_keep_terminator(current);
    let ops = capture_diff_slices(Algorithm::Myers, &base_lines, &cur_lines);

    let mut out = String::with_capacity(current.len().max(baseline.len()));
    let mut matched = false;
    for op in &ops {
        match *op {
            // Unchanged lines pass through (identical on both sides).
            DiffOp::Equal { new_index, len, .. } => {
                out.push_str(&concat(&cur_lines[new_index..new_index + len]))
            }
            _ => {
                let is_target = current_range(op) == Some((current_start, current_end)) && !matched;
                if is_target {
                    matched = true;
                    // Emit the baseline side — this hunk's revert.
                    if let DiffOp::Delete {
                        old_index, old_len, ..
                    }
                    | DiffOp::Replace {
                        old_index, old_len, ..
                    } = *op
                    {
                        out.push_str(&concat(&base_lines[old_index..old_index + old_len]));
                    }
                    // (Insert reverts to nothing — the inserted region vanishes.)
                } else {
                    // Keep the current side for every other hunk.
                    match *op {
                        DiffOp::Insert {
                            new_index, new_len, ..
                        }
                        | DiffOp::Replace {
                            new_index, new_len, ..
                        } => out.push_str(&concat(&cur_lines[new_index..new_index + new_len])),
                        // A Delete contributes nothing to the current side.
                        _ => {}
                    }
                }
            }
        }
    }
    matched.then_some(out)
}

/// Drop hunks whose change is *entirely* structural — every non-blank line on
/// both sides satisfies `is_structural_line`. Used to hide the auto-injected
/// notebox import preamble (`#import "/.inkycap/notebox.typ": *`) from the
/// "changes since sync" review: InkyCap manages that line, so a collaborator
/// should never see it presented as a reviewable change. A hunk that mixes a
/// structural line with real content stays visible (the real edit matters), and
/// a pure-whitespace hunk is never dropped on this basis.
pub fn drop_structural_hunks<F>(hunks: Vec<SyncHunk>, is_structural_line: F) -> Vec<SyncHunk>
where
    F: Fn(&str) -> bool,
{
    hunks
        .into_iter()
        .filter(|h| {
            let mut saw_line = false;
            let all_structural = [&h.baseline_text, &h.current_text]
                .into_iter()
                .flat_map(|t| t.lines())
                .filter(|l| !l.trim().is_empty())
                .all(|l| {
                    saw_line = true;
                    is_structural_line(l)
                });
            // Keep unless the hunk had at least one line and they were all structural.
            !(saw_line && all_structural)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_has_no_hunks() {
        assert!(diff_hunks("a\nb\n", "a\nb\n").is_empty());
    }

    #[test]
    fn replace_hunk_carries_both_sides() {
        let hunks = diff_hunks("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!((h.current_start, h.current_end), (1, 2));
        assert_eq!(h.baseline_text, "b\n");
        assert_eq!(h.current_text, "B\n");
    }

    #[test]
    fn revert_replace_restores_baseline_line() {
        let baseline = "a\nb\nc\n";
        let current = "a\nB\nc\n";
        let h = &diff_hunks(baseline, current)[0];
        let reverted = revert_hunk(baseline, current, h.current_start, h.current_end).unwrap();
        assert_eq!(reverted, baseline);
    }

    #[test]
    fn revert_one_of_two_hunks_keeps_the_other() {
        // Two independent edits; reverting the first must keep the second.
        let baseline = "a\nb\nc\nd\n";
        let current = "A\nb\nc\nD\n";
        let hunks = diff_hunks(baseline, current);
        assert_eq!(hunks.len(), 2);
        let first = &hunks[0];
        let reverted =
            revert_hunk(baseline, current, first.current_start, first.current_end).unwrap();
        // First line back to baseline, last line still the current edit.
        assert_eq!(reverted, "a\nb\nc\nD\n");
    }

    #[test]
    fn revert_insertion_removes_it() {
        let baseline = "a\nc\n";
        let current = "a\nb\nc\n";
        let hunks = diff_hunks(baseline, current);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].baseline_text, "");
        assert_eq!(hunks[0].current_text, "b\n");
        let h = &hunks[0];
        let reverted = revert_hunk(baseline, current, h.current_start, h.current_end).unwrap();
        assert_eq!(reverted, baseline);
    }

    #[test]
    fn revert_deletion_restores_it() {
        let baseline = "a\nb\nc\n";
        let current = "a\nc\n";
        let hunks = diff_hunks(baseline, current);
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        // A deletion is zero-width on the current side.
        assert_eq!(h.current_start, h.current_end);
        assert_eq!(h.baseline_text, "b\n");
        let reverted = revert_hunk(baseline, current, h.current_start, h.current_end).unwrap();
        assert_eq!(reverted, baseline);
    }

    #[test]
    fn stale_range_returns_none() {
        let baseline = "a\nb\n";
        let current = "a\nB\n";
        assert!(revert_hunk(baseline, current, 99, 100).is_none());
    }

    #[test]
    fn handles_added_whole_file_and_multibyte() {
        // Baseline empty (incoming added the note); current has multi-byte text.
        let current = "café\n— dash\n";
        let hunks = diff_hunks("", current);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].baseline_text, "");
        assert_eq!(hunks[0].current_text, current);
        let h = &hunks[0];
        let reverted = revert_hunk("", current, h.current_start, h.current_end).unwrap();
        assert_eq!(reverted, "");
    }

    #[test]
    fn no_trailing_newline_round_trips() {
        let baseline = "a\nb";
        let current = "a\nB";
        let h = &diff_hunks(baseline, current)[0];
        let reverted = revert_hunk(baseline, current, h.current_start, h.current_end).unwrap();
        assert_eq!(reverted, baseline);
    }

    // The notebox import preamble; in the real path the predicate is
    // `crate::notebox_package::is_notebox_import_line`.
    fn is_import(line: &str) -> bool {
        line.trim_start().starts_with("#import")
    }

    #[test]
    fn drops_import_only_added_hunk() {
        // Baseline lacked the preamble; current added it — pure structural noise.
        let hunks = diff_hunks(
            "= Title\n",
            "#import \"/.inkycap/notebox.typ\": *\n= Title\n",
        );
        assert_eq!(hunks.len(), 1);
        assert!(drop_structural_hunks(hunks, is_import).is_empty());
    }

    #[test]
    fn keeps_real_content_hunks() {
        let hunks = diff_hunks("= Title\n", "= Title changed\n");
        let kept = drop_structural_hunks(hunks, is_import);
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn keeps_hunk_mixing_import_and_content() {
        // A single hunk that both adds the import line and edits content stays
        // visible — the real edit must not be hidden.
        let kept = drop_structural_hunks(
            vec![SyncHunk {
                current_start: 0,
                current_end: 2,
                baseline_text: String::new(),
                current_text: "#import \"/.inkycap/notebox.typ\": *\n= Heading\n".to_string(),
            }],
            is_import,
        );
        assert_eq!(kept.len(), 1);
    }
}
