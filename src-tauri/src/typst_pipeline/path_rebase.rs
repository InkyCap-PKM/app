//! AST-based rewriter for path-bearing Typst function calls.
//!
//! When a note's content is inlined into another document (today: merged
//! collection export), Typst resolves relative path arguments — to
//! `image()`, `read()`, `embed()`, `bibliography()` — against the *outer*
//! document's directory, not the source note's. That breaks every
//! `image("daisy.png")` style call as soon as the note moves into a
//! foreign anchor.
//!
//! [`rebase_relative_paths`] walks the parsed Typst AST, finds calls to
//! the recognized functions whose first positional argument is a
//! string-literal *relative* path, and rewrites that argument to a
//! notebox-root-absolute path computed from the note's own directory.
//! Already-absolute paths (leading `/`) and non-string arguments are
//! left untouched, so the rewriter is safe to run on any source.
//!
//! Per CLAUDE.md's Typst-first principle: parsing uses `typst::syntax`
//! directly — the same parser the compiler uses — so we operate on byte
//! ranges from typed nodes and preserve multi-byte UTF-8 verbatim.

use std::path::{Component, Path, PathBuf};

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// Typst function names whose first positional argument is a path that
/// should be rebased. Exact identifier match, case-sensitive.
const PATH_BEARING_CALLS: &[&str] = &["image", "read", "embed", "bibliography"];

/// Rewrite relative path arguments to notebox-root-absolute paths.
///
/// - `source`: the note's Typst source.
/// - `note_dir`: the directory the note's relative paths are anchored to
///   — typically the note file's parent directory. Must be a notebox-
///   relative path (e.g. `notes/sub`); pass an empty path for a note at
///   the notebox root.
///
/// Returns the rewritten source. If no rewrites apply, returns a copy of
/// the input.
///
/// Paths that escape the notebox after rebasing (e.g. `../../outside.png`
/// from a top-level note) are left unchanged and a warning is logged.
pub fn rebase_relative_paths(source: &str, note_dir: &Path) -> String {
    let root = parse(source);
    let link = LinkedNode::new(&root);

    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    collect_edits(&link, note_dir, &mut edits);

    if edits.is_empty() {
        return source.to_string();
    }

    // Apply edits from the back so earlier byte offsets remain valid.
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    let mut out = source.to_string();
    for (range, replacement) in edits {
        out.replace_range(range, &replacement);
    }
    out
}

/// Recursively walk the AST collecting `(range, replacement)` edits.
fn collect_edits(
    node: &LinkedNode<'_>,
    note_dir: &Path,
    edits: &mut Vec<(std::ops::Range<usize>, String)>,
) {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if let ast::Expr::Ident(ident) = call.callee() {
                if PATH_BEARING_CALLS.contains(&ident.as_str()) {
                    if let Some(edit) = rebase_first_string_arg(node, note_dir) {
                        edits.push(edit);
                    }
                }
            }
        }
    }

    for child in node.children() {
        collect_edits(&child, note_dir, edits);
    }
}

/// Inspect the first positional argument of a FuncCall LinkedNode. If it's
/// a string literal whose value is a relative path, compute the rebased
/// path and return a `(range, replacement)` edit covering the string
/// literal (quotes included). Returns `None` when no rewrite applies.
fn rebase_first_string_arg(
    call_node: &LinkedNode<'_>,
    note_dir: &Path,
) -> Option<(std::ops::Range<usize>, String)> {
    let args_node = call_node
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)?;

    // Walk args children in source order. The first thing that's either a
    // string literal (positional) or a Named/Spread node decides whether
    // we have a string positional in the first slot. Trivia, parens, and
    // commas are skipped.
    for child in args_node.children() {
        match child.kind() {
            SyntaxKind::LeftParen
            | SyntaxKind::RightParen
            | SyntaxKind::Comma
            | SyntaxKind::Space
            | SyntaxKind::Parbreak
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment => continue,

            SyntaxKind::Str => {
                let str_ast = child.cast::<ast::Str>()?;
                let value = str_ast.get();
                let value_str: &str = &value;

                // Already absolute? Leave it alone.
                if value_str.starts_with('/') {
                    return None;
                }
                // Non-path-like (e.g. a URL) — bibliography accepts strings
                // that look like CSL style names. Heuristic: anything
                // containing `://` is not a notebox path.
                if value_str.contains("://") {
                    return None;
                }
                // Empty string is nonsensical for a path; leave alone.
                if value_str.is_empty() {
                    return None;
                }

                let rebased = match rebase_path(value_str, note_dir) {
                    Some(r) => r,
                    None => {
                        log::warn!(
                            "path_rebase: path '{}' from note_dir '{}' escapes notebox; left unchanged",
                            value_str,
                            note_dir.display()
                        );
                        return None;
                    }
                };

                // No-op: if rebasing changed nothing, skip the edit so we
                // don't churn source bytes.
                if rebased == value_str {
                    return None;
                }

                let escaped = escape_typst_string(&rebased);
                let replacement = format!("\"{escaped}\"");
                return Some((child.range(), replacement));
            }

            // Any other expression kind in the first positional slot
            // means the path isn't a literal we can rewrite (variable,
            // function call, raw, etc.). Leave the whole call alone.
            //
            // Named/Spread in the first slot means there's no positional;
            // also leave alone.
            _ => return None,
        }
    }
    None
}

/// Compute the notebox-root-absolute path for `value` anchored at
/// `note_dir`. Returns `None` if the result escapes the notebox root via
/// `..`. The returned string always starts with `/`.
fn rebase_path(value: &str, note_dir: &Path) -> Option<String> {
    let mut joined: PathBuf = note_dir.to_path_buf();
    joined.push(value);

    // Resolve `.` and `..` lexically against the notebox root. We don't
    // touch the filesystem — this is purely a string operation against
    // the notebox-relative layout.
    let mut normalized: Vec<&std::ffi::OsStr> = Vec::new();
    for component in joined.components() {
        match component {
            Component::CurDir => continue,
            Component::ParentDir => {
                // Escapes notebox root when there's nothing to pop.
                if normalized.pop().is_none() {
                    return None;
                }
            }
            Component::Normal(s) => normalized.push(s),
            // Should not occur for a relative input on Unix; treat
            // defensively as a no-op rather than panicking.
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }

    // Re-encode with forward slashes for Typst path syntax. The Typst
    // language uses `/` as the path separator regardless of host OS.
    let joined: String = normalized
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Some(format!("/{joined}"))
}

/// Rewrite path-bearing function calls whose string-literal argument
/// begins with `/<old_prefix_segment>/` so the prefix becomes
/// `/<new_prefix_segment>/`. Used by Phase C's attachment-folder
/// migration: when the user renames `assets` → `media`, every
/// `#image("/assets/foo.png")` across the notebox becomes
/// `#image("/media/foo.png")`. Non-matching calls and non-string
/// arguments are left untouched.
///
/// `old_segment` and `new_segment` are bare folder names (no slashes).
/// Matching is exact and case-sensitive — same surface as the
/// underlying filesystem operation.
pub fn replace_absolute_prefix(source: &str, old_segment: &str, new_segment: &str) -> String {
    if old_segment == new_segment || old_segment.is_empty() || new_segment.is_empty() {
        return source.to_string();
    }
    if old_segment.contains('/') || new_segment.contains('/') {
        // Caller bug — segments are bare folder names. Refuse the
        // rewrite rather than produce garbled paths.
        log::warn!(
            "replace_absolute_prefix: segment contains '/', refusing: old={old_segment:?} new={new_segment:?}"
        );
        return source.to_string();
    }

    let root = parse(source);
    let link = LinkedNode::new(&root);
    let needle = format!("/{old_segment}/");
    let replacement_prefix = format!("/{new_segment}/");

    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    collect_prefix_edits(&link, &needle, &replacement_prefix, &mut edits);

    if edits.is_empty() {
        return source.to_string();
    }

    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    let mut out = source.to_string();
    for (range, replacement) in edits {
        out.replace_range(range, &replacement);
    }
    out
}

/// Count path-bearing calls in `source` whose string-literal argument
/// begins with `/<segment>/`. Cheap pre-flight metric for the
/// attachment-folder migration's preview counts — does not allocate
/// edit lists.
pub fn count_absolute_prefix_matches(source: &str, segment: &str) -> usize {
    if segment.is_empty() || segment.contains('/') {
        return 0;
    }
    let root = parse(source);
    let link = LinkedNode::new(&root);
    let needle = format!("/{segment}/");
    let mut count = 0;
    count_prefix_matches(&link, &needle, &mut count);
    count
}

fn collect_prefix_edits(
    node: &LinkedNode<'_>,
    needle: &str,
    replacement_prefix: &str,
    edits: &mut Vec<(std::ops::Range<usize>, String)>,
) {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if let ast::Expr::Ident(ident) = call.callee() {
                if PATH_BEARING_CALLS.contains(&ident.as_str()) {
                    if let Some(edit) = match_prefix_arg(node, needle, replacement_prefix) {
                        edits.push(edit);
                    }
                }
            }
        }
    }
    for child in node.children() {
        collect_prefix_edits(&child, needle, replacement_prefix, edits);
    }
}

fn count_prefix_matches(node: &LinkedNode<'_>, needle: &str, count: &mut usize) {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if let ast::Expr::Ident(ident) = call.callee() {
                if PATH_BEARING_CALLS.contains(&ident.as_str())
                    && first_string_arg_starts_with(node, needle)
                {
                    *count += 1;
                }
            }
        }
    }
    for child in node.children() {
        count_prefix_matches(&child, needle, count);
    }
}

fn first_string_arg<'a>(call_node: &'a LinkedNode<'a>) -> Option<(LinkedNode<'a>, String)> {
    let args_node = call_node
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)?;
    for child in args_node.children() {
        match child.kind() {
            SyntaxKind::LeftParen
            | SyntaxKind::RightParen
            | SyntaxKind::Comma
            | SyntaxKind::Space
            | SyntaxKind::Parbreak
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment => continue,
            SyntaxKind::Str => {
                let s = child.cast::<ast::Str>()?;
                let value: String = s.get().to_string();
                return Some((child, value));
            }
            _ => return None,
        }
    }
    None
}

fn first_string_arg_starts_with(call_node: &LinkedNode<'_>, needle: &str) -> bool {
    first_string_arg(call_node)
        .map(|(_, v)| v.starts_with(needle))
        .unwrap_or(false)
}

fn match_prefix_arg(
    call_node: &LinkedNode<'_>,
    needle: &str,
    replacement_prefix: &str,
) -> Option<(std::ops::Range<usize>, String)> {
    let (node, value) = first_string_arg(call_node)?;
    if !value.starts_with(needle) {
        return None;
    }
    let rewritten = format!("{}{}", replacement_prefix, &value[needle.len()..]);
    let escaped = escape_typst_string(&rewritten);
    let replacement = format!("\"{escaped}\"");
    Some((node.range(), replacement))
}

/// Escape a string for inclusion in a Typst string literal. Typst's
/// string-literal grammar accepts `\\` and `\"` escapes; we round-trip
/// only those because path values never legitimately contain control
/// characters.
fn escape_typst_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn rebase(source: &str, note_dir: &str) -> String {
        rebase_relative_paths(source, &PathBuf::from(note_dir))
    }

    #[test]
    fn relative_image_at_notebox_root() {
        let src = "#image(\"daisy.png\")";
        let out = rebase(src, "");
        assert_eq!(out, "#image(\"/daisy.png\")");
    }

    #[test]
    fn relative_image_in_subfolder() {
        let src = "#image(\"daisy.png\")";
        let out = rebase(src, "notes/sub");
        assert_eq!(out, "#image(\"/notes/sub/daisy.png\")");
    }

    #[test]
    fn already_absolute_left_unchanged() {
        let src = "#image(\"/assets/daisy.png\")";
        let out = rebase(src, "notes/sub");
        assert_eq!(out, src);
    }

    #[test]
    fn parent_dir_traversal_resolved() {
        let src = "#image(\"../images/daisy.png\")";
        let out = rebase(src, "notes/sub");
        assert_eq!(out, "#image(\"/notes/images/daisy.png\")");
    }

    #[test]
    fn escape_notebox_left_unchanged() {
        let src = "#image(\"../../outside.png\")";
        let out = rebase(src, "notes");
        // Would resolve to /../outside.png — escapes notebox. Untouched.
        assert_eq!(out, src);
    }

    #[test]
    fn non_literal_argument_left_unchanged() {
        let src = "#let p = \"daisy.png\"\n#image(p)";
        let out = rebase(src, "notes");
        assert_eq!(out, src);
    }

    #[test]
    fn url_left_unchanged() {
        let src = "#image(\"https://example.com/daisy.png\")";
        let out = rebase(src, "notes/sub");
        assert_eq!(out, src);
    }

    #[test]
    fn read_call_rebased() {
        let src = "#read(\"data.csv\")";
        let out = rebase(src, "notes");
        assert_eq!(out, "#read(\"/notes/data.csv\")");
    }

    #[test]
    fn embed_call_rebased() {
        let src = "#embed(\"file.pdf\")";
        let out = rebase(src, "notes");
        assert_eq!(out, "#embed(\"/notes/file.pdf\")");
    }

    #[test]
    fn bibliography_rebased() {
        let src = "#bibliography(\"refs.bib\")";
        let out = rebase(src, "notes/papers");
        assert_eq!(out, "#bibliography(\"/notes/papers/refs.bib\")");
    }

    #[test]
    fn bibliography_with_named_style_arg_rebased() {
        let src = "#bibliography(\"refs.bib\", style: \"apa\")";
        let out = rebase(src, "notes");
        assert_eq!(out, "#bibliography(\"/notes/refs.bib\", style: \"apa\")");
    }

    #[test]
    fn multiple_calls_in_one_document() {
        let src = "#image(\"a.png\")\n#read(\"b.csv\")\n#image(\"/abs.png\")";
        let out = rebase(src, "notes");
        assert_eq!(
            out,
            "#image(\"/notes/a.png\")\n#read(\"/notes/b.csv\")\n#image(\"/abs.png\")"
        );
    }

    #[test]
    fn other_function_calls_untouched() {
        let src = "#strong(\"hello\")\n#text(\"world\")";
        let out = rebase(src, "notes");
        assert_eq!(out, src);
    }

    #[test]
    fn code_mode_image_call_rebased() {
        let src = "#{ image(\"daisy.png\") }";
        let out = rebase(src, "notes");
        assert_eq!(out, "#{ image(\"/notes/daisy.png\") }");
    }

    #[test]
    fn multibyte_path_survives() {
        let src = "#image(\"日本語.png\")";
        let out = rebase(src, "notes");
        assert_eq!(out, "#image(\"/notes/日本語.png\")");
    }

    // ── replace_absolute_prefix ────────────────────────────────────

    #[test]
    fn replace_prefix_rewrites_image_call() {
        let src = "#image(\"/assets/daisy.png\")";
        let out = replace_absolute_prefix(src, "assets", "media");
        assert_eq!(out, "#image(\"/media/daisy.png\")");
    }

    #[test]
    fn replace_prefix_rewrites_nested_path() {
        let src = "#image(\"/assets/sub/dir/daisy.png\")";
        let out = replace_absolute_prefix(src, "assets", "media");
        assert_eq!(out, "#image(\"/media/sub/dir/daisy.png\")");
    }

    #[test]
    fn replace_prefix_leaves_relative_paths_alone() {
        let src = "#image(\"assets/daisy.png\")";
        let out = replace_absolute_prefix(src, "assets", "media");
        assert_eq!(out, src);
    }

    #[test]
    fn replace_prefix_leaves_other_folders_alone() {
        let src = "#image(\"/notes/assets/daisy.png\")";
        let out = replace_absolute_prefix(src, "assets", "media");
        assert_eq!(out, src);
    }

    #[test]
    fn replace_prefix_no_op_when_segments_equal() {
        let src = "#image(\"/assets/daisy.png\")";
        let out = replace_absolute_prefix(src, "assets", "assets");
        assert_eq!(out, src);
    }

    #[test]
    fn replace_prefix_rewrites_all_path_bearing_calls() {
        let src = "#image(\"/assets/a.png\")\n#read(\"/assets/b.csv\")\n#embed(\"/assets/c.pdf\")\n#bibliography(\"/assets/refs.bib\")";
        let out = replace_absolute_prefix(src, "assets", "media");
        assert_eq!(
            out,
            "#image(\"/media/a.png\")\n#read(\"/media/b.csv\")\n#embed(\"/media/c.pdf\")\n#bibliography(\"/media/refs.bib\")"
        );
    }

    #[test]
    fn replace_prefix_skips_non_path_bearing_calls() {
        let src = "#strong(\"/assets/foo\")\n#image(\"/assets/bar.png\")";
        let out = replace_absolute_prefix(src, "assets", "media");
        assert_eq!(out, "#strong(\"/assets/foo\")\n#image(\"/media/bar.png\")");
    }

    #[test]
    fn count_prefix_matches_basic() {
        let src = "#image(\"/assets/a.png\")\n#image(\"/notes/b.png\")\n#read(\"/assets/c.csv\")";
        assert_eq!(count_absolute_prefix_matches(src, "assets"), 2);
        assert_eq!(count_absolute_prefix_matches(src, "notes"), 1);
        assert_eq!(count_absolute_prefix_matches(src, "missing"), 0);
    }

    #[test]
    fn replace_prefix_segment_with_slash_refused() {
        let src = "#image(\"/assets/foo.png\")";
        let out = replace_absolute_prefix(src, "ass/ets", "media");
        assert_eq!(out, src);
    }

    #[test]
    fn replace_prefix_multibyte_filename() {
        let src = "#image(\"/assets/日本語.png\")";
        let out = replace_absolute_prefix(src, "assets", "media");
        assert_eq!(out, "#image(\"/media/日本語.png\")");
    }

    #[test]
    fn empty_string_left_unchanged() {
        let src = "#image(\"\")";
        let out = rebase(src, "notes");
        assert_eq!(out, src);
    }
}
