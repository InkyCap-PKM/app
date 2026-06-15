//! Detect (and, where safe, repair) common problems in a `.typ` file's source
//! — leftover Markdown markup and Typst syntax errors. Powers the cleanup pass
//! of the "Audit .typ files for InkyCap compatibility" tool.
//!
//! Two concerns, both Typst-first:
//!
//! 1. **Markdown leftovers** — files dragged in from another tool (or pasted
//!    from Markdown) often carry `# heading`, `[text](url)`, `![alt](url)`, and
//!    `**bold**` markup. None of that means anything in Typst (a leading `# ` is
//!    a code-mode expression that errors; `**` and `[](…)` render as literal
//!    junk), so it's safe to rewrite into the Typst equivalents. The transforms
//!    are deliberately conservative: they skip fenced code blocks entirely, and
//!    the inline ones skip any line containing a backtick (an inline-code span)
//!    rather than risk rewriting code. Every change is surfaced for review
//!    before it's applied.
//!
//! 2. **Syntax errors** — a missing bracket or a typo is a genuine syntax
//!    error. We can *find* these with `typst::syntax` (the same parser the
//!    compiler uses) and report them with a line/column, but we do **not**
//!    auto-fix them: there's no reliable way to guess the intended repair, and
//!    a wrong guess corrupts the user's content. They're listed for the user.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};

// ── Markdown leftovers ─────────────────────────────────────────────────────

/// An ATX Markdown heading: one-to-six leading `#` then a space then text.
/// `#import`/`#note(`/`#let` etc. have no space after the `#`, so they never
/// match (they're valid Typst code, not headings).
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

/// A proposed Markdown→Typst fix on one source line. Round-trips to the
/// frontend and back (the user can accept/reject each before applying), so it
/// is both `Serialize` and `Deserialize`.
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

/// Apply the inline Markdown transforms (image → link → bold) to a line that is
/// known to be free of inline-code spans. Returns the rewritten line and the
/// list of transform kinds that fired.
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

/// Transform one line, returning the rewritten line + the kinds that applied,
/// or `None` if nothing changed. The heading transform always runs (it's
/// anchored at line start, never inside an inline-code span); the inline
/// transforms run only when the line has no backtick, so an inline-code span
/// like `` `[x](y)` `` is left untouched.
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

/// True for a fenced-code-block delimiter line (``` ``` ``` ``` or longer,
/// optionally with an info string). Toggling on these keeps us from rewriting
/// Markdown-looking text that is actually code.
fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// Walk a file's lines and collect every proposed Markdown→Typst fix. Lines
/// inside fenced code blocks are skipped.
pub fn detect_md_fixes(content: &str) -> Vec<MdFix> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for (idx, line) in content.lines().enumerate() {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
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

/// Apply every Markdown→Typst fix to a file's source, preserving the original
/// line endings' structure (operates line-by-line; re-joins with `\n` and
/// restores a trailing newline if the input had one). Returns the input
/// unchanged when there's nothing to fix.
pub fn apply_md_fixes(content: &str) -> String {
    if detect_md_fixes(content).is_empty() {
        return content.to_string();
    }
    let had_trailing_newline = content.ends_with('\n');
    let mut lines_out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in content.lines() {
        if is_fence(line) {
            in_fence = !in_fence;
            lines_out.push(line.to_string());
            continue;
        }
        if in_fence {
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

/// Apply only the `accepted` fixes (the user may have rejected some so they can
/// keep a line "broken" on purpose, or because the tool misread it). Each fix
/// is matched by its 1-based `line`, and applied only when that line still
/// reads exactly as the fix's `before` — a guard against the file having
/// changed since the audit. Every fix is a same-line replacement, so line
/// numbers don't shift and one fix maps to one line. Returns the input
/// unchanged when nothing applies.
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

/// Parse the source with `typst::syntax` and report any syntax errors with
/// their location. Purely syntactic — it doesn't evaluate, so unresolved
/// `#wikilink(...)` etc. are not flagged (those parse fine); only genuine
/// structural errors (unclosed brackets, stray tokens) surface here.
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
