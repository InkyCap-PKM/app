//! Find, and where safe fix, problems in a `.typ` file's source (leftover
//! Markdown and Typst syntax errors), for the "Audit .typ files for InkyCap
//! compatibility" tool.
//!
//! 1. **Markdown leftovers** in files from other tools or pasted Markdown: `#
//!    heading`, `[text](url)`, `![alt](url)`, `**bold**`. None of it means
//!    anything in Typst (a leading `# ` is a failing code expression; `**` and
//!    `[](…)` render as junk), so it is rewritten to the Typst equivalent. Code
//!    blocks are skipped (found with the parser, so a fence in a list item
//!    counts), and the inline fixes skip any line with a backtick rather than
//!    risk changing code. Every change is shown for review first.
//! 2. **Syntax errors** (a missing bracket, a typo) are found with
//!    `typst::syntax` and reported with line and column, but never fixed
//!    automatically: there is no reliable way to guess the intent, and a wrong
//!    guess corrupts content.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};

use crate::typst_pipeline::source_structure;

// ── Markdown leftovers ─────────────────────────────────────────────────────

/// A Markdown ATX heading: one to six `#`, a space, then text. `#import`,
/// `#note(`, `#let` etc. have no space after `#`, so they don't match.
static ATX_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(#{1,6})[ \t]+(\S.*)$").unwrap());

/// `**bold**` (Markdown) — Typst uses single `*bold*`.
static MD_BOLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*([^*\n]+)\*\*").unwrap());

/// `![alt](url)` Markdown image. Matched before links so the leading `!` form
/// wins. URL must be non-empty and space-free (a plain path/URL).
static MD_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[([^\]]*)\]\(([^)\s]+)\)").unwrap());

/// `[text](url)` Markdown link.
static MD_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]+)\]\(([^)\s]+)\)").unwrap());

/// A proposed Markdown-to-Typst fix on one line. Sent to the frontend and back
/// (each can be accepted or rejected), so it is `Serialize` and `Deserialize`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdFix {
    /// 1-based line number.
    pub line: usize,
    /// Which transforms applied to this line (e.g. "heading", "link+bold").
    pub kind: String,
    /// The original line (as authored).
    pub before: String,
    /// The proposed replacement line.
    pub after: String,
}

/// Escape a string for a Typst `"…"` string literal.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Apply the inline fixes (image, then link, then bold) to a line without
/// inline code. Returns the new line and which fixes applied.
fn transform_inline(line: &str) -> (String, Vec<&'static str>) {
    let mut kinds = Vec::new();
    let mut s = line.to_string();

    if MD_IMAGE.is_match(&s) {
        s = MD_IMAGE
            .replace_all(&s, |c: &Captures| {
                let alt = c.get(1).map(|m| m.as_str()).unwrap_or("");
                let url = c.get(2).map(|m| m.as_str()).unwrap_or("");
                if alt.is_empty() {
                    format!("#image(\"{}\")", esc(url))
                } else {
                    format!("#image(\"{}\", alt: \"{}\")", esc(url), esc(alt))
                }
            })
            .into_owned();
        kinds.push("image");
    }
    if MD_LINK.is_match(&s) {
        s = MD_LINK
            .replace_all(&s, |c: &Captures| {
                let text = c.get(1).map(|m| m.as_str()).unwrap_or("");
                let url = c.get(2).map(|m| m.as_str()).unwrap_or("");
                format!("#link(\"{}\")[{}]", esc(url), text)
            })
            .into_owned();
        kinds.push("link");
    }
    if MD_BOLD.is_match(&s) {
        s = MD_BOLD.replace_all(&s, "*$1*").into_owned();
        kinds.push("bold");
    }
    (s, kinds)
}

/// Fix one line, returning the new line and the fixes applied, or `None` if
/// unchanged. The heading fix always runs (it is anchored at the line start);
/// the inline fixes only on lines without a backtick, so `` `[x](y)` `` is left
/// alone.
fn transform_line(line: &str) -> Option<(String, String)> {
    let mut kinds: Vec<&'static str> = Vec::new();
    let mut s = line.to_string();

    if let Some(c) = ATX_HEADING.captures(&s) {
        let level = c.get(1).unwrap().as_str().len();
        let rest = c.get(2).unwrap().as_str().to_string();
        s = format!("{} {}", "=".repeat(level), rest);
        kinds.push("heading");
    }

    if !s.contains('`') {
        let (inlined, inline_kinds) = transform_inline(&s);
        if !inline_kinds.is_empty() {
            s = inlined;
            kinds.extend(inline_kinds);
        }
    }

    if kinds.is_empty() {
        None
    } else {
        Some((kinds.join("+"), s))
    }
}

/// Walk a file's lines and collect every proposed Markdown→Typst fix. Lines
/// inside fenced code blocks are skipped.
pub fn detect_md_fixes(content: &str) -> Vec<MdFix> {
    let raw_lines = source_structure::raw_block_lines(content);
    let mut out = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if raw_lines.contains(&(idx + 1)) {
            continue;
        }
        if let Some((kind, after)) = transform_line(line) {
            out.push(MdFix {
                line: idx + 1,
                kind,
                before: line.to_string(),
                after,
            });
        }
    }
    out
}

/// Apply every Markdown fix to a file, line by line, rejoining with `\n` and
/// keeping a trailing newline. Unchanged if there's nothing to fix.
pub fn apply_md_fixes(content: &str) -> String {
    if detect_md_fixes(content).is_empty() {
        return content.to_string();
    }
    let raw_lines = source_structure::raw_block_lines(content);
    let had_trailing_newline = content.ends_with('\n');
    let mut lines_out: Vec<String> = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if raw_lines.contains(&(idx + 1)) {
            lines_out.push(line.to_string());
            continue;
        }
        match transform_line(line) {
            Some((_, after)) => lines_out.push(after),
            None => lines_out.push(line.to_string()),
        }
    }
    let mut joined = lines_out.join("\n");
    if had_trailing_newline {
        joined.push('\n');
    }
    joined
}

/// Apply only the `accepted` fixes (the user may keep some lines as they are).
/// Each is matched by its 1-based `line` and applied only if the line still
/// reads as its `before`, in case the file changed since the audit. Fixes
/// replace single lines, so line numbers don't shift. Unchanged if nothing
/// applies.
pub fn apply_selected_md_fixes(content: &str, accepted: &[MdFix]) -> String {
    if accepted.is_empty() {
        return content.to_string();
    }
    let by_line: std::collections::HashMap<usize, &MdFix> =
        accepted.iter().map(|f| (f.line, f)).collect();
    let had_trailing_newline = content.ends_with('\n');
    let mut lines_out: Vec<String> = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        match by_line.get(&(idx + 1)) {
            Some(fix) if line == fix.before => lines_out.push(fix.after.clone()),
            _ => lines_out.push(line.to_string()),
        }
    }
    let mut joined = lines_out.join("\n");
    if had_trailing_newline {
        joined.push('\n');
    }
    joined
}

// ── Syntax errors ──────────────────────────────────────────────────────────

/// A Typst syntax error found by the parser, located in the source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxIssue {
    /// 1-based line number (0 if the span couldn't be located).
    pub line: usize,
    /// 1-based column.
    pub column: usize,
    /// The parser's error message.
    pub message: String,
}

/// Syntax errors in `content`, with locations, from `typst::syntax`. Only
/// parsing, so unresolved `#wikilink(...)` and the like aren't flagged; only
/// structural errors (unclosed brackets, stray tokens).
pub fn detect_syntax_errors(content: &str) -> Vec<SyntaxIssue> {
    let id = FileId::new(RootedPath::new(
        VirtualRoot::Project,
        VirtualPath::new("/audit.typ").expect("static audit path is valid"),
    ));
    let source = Source::new(id, content.to_string());
    // 0.15: `errors()` became `errors_and_warnings()` returning `(errors,
    // warnings)`; we only surface the errors here.
    source
        .root()
        .errors_and_warnings()
        .0
        .into_iter()
        .map(|err| {
            let lines = source.lines();
            let (line, column) = super::diagnostic::diag_span_range(err.span, &source)
                .map(|r| {
                    (
                        lines.byte_to_line(r.start).map(|l| l + 1).unwrap_or(0),
                        lines.byte_to_column(r.start).map(|c| c + 1).unwrap_or(0),
                    )
                })
                .unwrap_or((0, 0));
            SyntaxIssue {
                line,
                column,
                message: err.message.to_string(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_atx_headings() {
        let fixes = detect_md_fixes("# Title\n## Sub\nbody\n");
        assert_eq!(fixes.len(), 2);
        assert_eq!(fixes[0].after, "= Title");
        assert_eq!(fixes[1].after, "== Sub");
        let out = apply_md_fixes("# Title\n## Sub\nbody\n");
        assert_eq!(out, "= Title\n== Sub\nbody\n");
    }

    #[test]
    fn skips_markdown_looking_lines_inside_a_fence() {
        let src = "= Title\n```md\n# Not a heading to fix\n**not bold**\n```\n";
        assert!(
            detect_md_fixes(src).is_empty(),
            "{:?}",
            detect_md_fixes(src)
        );
        assert_eq!(apply_md_fixes(src), src);
    }

    #[test]
    fn skips_a_fence_opened_inside_a_list_item() {
        // Issue #21: a fence after a list marker; its content mustn't be
        // offered as fixes.
        let src = "- item\n  - ```\n# Not a heading to fix\n```\n";
        assert!(
            detect_md_fixes(src).is_empty(),
            "{:?}",
            detect_md_fixes(src)
        );
        assert_eq!(apply_md_fixes(src), src);
    }

    #[test]
    fn leaves_typst_hash_calls_alone() {
        // `#import`, `#note(`, `#let` have no space after `#` → not headings.
        let src = "#import \"/.inkycap/notebox.typ\": *\n#note(title: \"X\")\n#let y = 1\n";
        assert!(detect_md_fixes(src).is_empty());
        assert_eq!(apply_md_fixes(src), src);
    }

    #[test]
    fn converts_links_images_and_bold() {
        let out = apply_md_fixes(
            "See ![a cat](/img/cat.png) and [the docs](https://x.io) in **bold**.\n",
        );
        assert_eq!(
            out,
            "See #image(\"/img/cat.png\", alt: \"a cat\") and #link(\"https://x.io\")[the docs] in *bold*.\n"
        );
    }

    #[test]
    fn skips_fenced_code_blocks() {
        let src = "```md\n# not a heading\n**not bold**\n```\nreal body\n";
        assert!(detect_md_fixes(src).is_empty());
        assert_eq!(apply_md_fixes(src), src);
    }

    #[test]
    fn skips_inline_code_lines_for_inline_fixes() {
        // A line with a backtick is left alone for inline transforms…
        let src = "use `[x](y)` literally\n";
        assert!(detect_md_fixes(src).is_empty());
        // …but a heading on a backtick-free line still converts.
        let out = apply_md_fixes("# Heading\nuse `code` here\n");
        assert_eq!(out, "= Heading\nuse `code` here\n");
    }

    #[test]
    fn preserves_multibyte_content() {
        let out = apply_md_fixes("# Café — résumé\nNaïve **gras** 你好\n");
        assert_eq!(out, "= Café — résumé\nNaïve *gras* 你好\n");
    }

    #[test]
    fn applies_only_accepted_fixes() {
        let src = "# One\n# Two\n# Three\n";
        let all = detect_md_fixes(src);
        assert_eq!(all.len(), 3);
        // Accept the first and third; reject the middle one (keep it "broken").
        let accepted = vec![all[0].clone(), all[2].clone()];
        let out = apply_selected_md_fixes(src, &accepted);
        assert_eq!(out, "= One\n# Two\n= Three\n");
    }

    #[test]
    fn selected_fix_skipped_when_line_drifted() {
        // The recorded `before` no longer matches the live line → not applied.
        let src = "# Changed since audit\n";
        let stale = MdFix {
            line: 1,
            kind: "heading".into(),
            before: "# Different text".into(),
            after: "= Different text".into(),
        };
        assert_eq!(apply_selected_md_fixes(src, &[stale]), src);
    }

    #[test]
    fn detects_unclosed_bracket() {
        let issues = detect_syntax_errors("#strong[unclosed\n");
        assert!(!issues.is_empty(), "expected a syntax error");
    }

    #[test]
    fn clean_source_has_no_syntax_errors() {
        let issues = detect_syntax_errors("= Heading\n\nA paragraph with *emphasis*.\n");
        assert!(issues.is_empty(), "unexpected: {issues:?}");
    }
}
