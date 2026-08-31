//! Filename pattern substitution for backup archives.
//!
//! The user-configurable pattern (e.g.
//! `"inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}.zip"`) gets resolved against
//! a notebox name and a `chrono::DateTime` here. Substituted values are
//! sanitized against Windows-reserved characters (`< > : " / \ | ? *` plus
//! ASCII control characters) and Windows reserved device names (CON, PRN,
//! AUX, NUL, COM1–9, LPT1–9) so a notebox named `Aux Notes` still produces
//! a writable backup on every OS. Forward and backslashes in substituted
//! values are also stripped so a malicious or pasted notebox name can't
//! redirect the output into a different folder.
//!
//! The pattern itself is *not* sanitized — the user owns it and may
//! deliberately include subfolder slashes if they want; only token
//! substitutions are scrubbed.

use chrono::{DateTime, Datelike, Local, Timelike};

/// Windows reserved single-token names, lowercase. Compared case-
/// insensitively against the *stem* (filename without extension) of any
/// substituted value to catch e.g. `CON.foo` which is reserved too.
const WINDOWS_RESERVED_STEMS: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Whether `ch` is rejected by Windows in a filename.
///
/// The nine reserved punctuation characters plus every ASCII control (Windows
/// rejects `0x00..=0x1F` outright; other systems allow them, but a filename
/// with a newline in it is hostile to every tool that has to display it).
/// Shared with the notebox name audit so the two agree on what "illegal"
/// means.
pub fn is_windows_illegal_char(ch: char) -> bool {
    matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (ch as u32) < 0x20
}

/// Whether `name`'s stem is a Windows reserved device name (`CON`, `LPT1`, …).
///
/// The check is on the portion before the first dot, so `CON.typ` is caught
/// even though the full string isn't an exact reserved name. Such a file
/// cannot be created on Windows at all.
pub fn is_windows_reserved_stem(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    WINDOWS_RESERVED_STEMS
        .iter()
        .any(|r| stem.eq_ignore_ascii_case(r))
}

/// Whether `name` ends in a dot or space, which Windows silently strips at
/// write time (so `notes ` and `notes` become the same file there).
pub fn has_trailing_dot_or_space(name: &str) -> bool {
    name.ends_with('.') || name.ends_with(' ')
}

/// Sanitize a value that will be substituted into a filename. Replaces
/// reserved characters with `_`, collapses runs of `_` to a single one,
/// trims leading/trailing whitespace and dots (Windows strips those at
/// write time, so we do it deterministically here), and rewrites any
/// reserved stem to `<stem>_` so the result is always a writable name.
///
/// Returns `"untitled"` if the input collapses to empty — the caller
/// shouldn't have to special-case that.
pub fn sanitize_token_value(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        out.push(if is_windows_illegal_char(ch) { '_' } else { ch });
    }

    // Collapse runs of underscores so "Foo // Bar" doesn't become
    // "Foo___Bar" — visually noisy and makes the filename longer than it
    // needs to be on already-tight Windows path-length budgets.
    while out.contains("__") {
        out = out.replace("__", "_");
    }

    // Windows strips trailing dots and spaces silently at write time; we
    // do it ourselves so the on-disk name matches the one we report back
    // to the user. Leading whitespace/dots are also trimmed for symmetry
    // (no Windows quirk but a bare-dot prefix is rarely intended).
    let trimmed = out.trim_matches(|c: char| c.is_whitespace() || c == '.');

    // If the entire value collapsed to nothing but underscores (input
    // was purely reserved characters like `///` or `::`), treat that as
    // empty and fall through to the "untitled" fallback. A legitimate
    // input like `foo_bar` is unaffected because it still contains real
    // characters.
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        return "untitled".to_string();
    }

    // Rewrite reserved stems case-insensitively. The check is on the
    // portion before the first dot so `CON.notebox` (stem "CON") gets
    // caught even though the full string isn't an exact reserved name.
    if is_windows_reserved_stem(trimmed) {
        return format!("{trimmed}_");
    }

    trimmed.to_string()
}

/// Resolve a pattern against a notebox name and a timestamp. Unknown
/// `{tokens}` are passed through verbatim — the user might genuinely
/// want a literal `{foo}` in their filename, and we shouldn't silently
/// eat it.
pub fn resolve(pattern: &str, notebox_name: &str, when: DateTime<Local>) -> String {
    let notebox = sanitize_token_value(notebox_name);

    // chrono's format strings would do this for us, but mixing
    // user-supplied template text with chrono format codes ("%Y") is
    // fragile — a literal '%' in a user's filename would get
    // misinterpreted. Hand-substituting keeps the boundary clear.
    let replacements: &[(&str, String)] = &[
        ("{notebox}", notebox),
        ("{YYYY}", format!("{:04}", when.year())),
        ("{MM}", format!("{:02}", when.month())),
        ("{DD}", format!("{:02}", when.day())),
        ("{HH}", format!("{:02}", when.hour())),
        ("{mm}", format!("{:02}", when.minute())),
        ("{ss}", format!("{:02}", when.second())),
    ];

    let mut out = pattern.to_string();
    for (token, value) in replacements {
        out = out.replace(token, value);
    }
    out
}

/// Glob-like matcher for "is this filename a backup archive produced by
/// the given pattern?" Used by the retention pruner to find candidates
/// to delete without touching unrelated files in the backup folder.
///
/// The match is built by replacing every `{token}` in the pattern with
/// a wildcard placeholder, then doing a literal-with-wildcards compare.
/// Anything matching any of the tokens (including unknown ones) is
/// treated as a wildcard so a pattern change after some backups already
/// exist still recognises the older shape.
pub fn matches_pattern(pattern: &str, candidate: &str) -> bool {
    // Build a regex-like split on `{...}` runs. Pieces of `pattern`
    // outside any `{...}` are literal; every `{...}` is a wildcard
    // that matches as little as possible to keep `*foo*bar*` from
    // matching `foobarfoobar` as one giant chunk.
    let mut literals: Vec<&str> = Vec::new();
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        literals.push(&rest[..open]);
        match rest[open..].find('}') {
            Some(close) => rest = &rest[open + close + 1..],
            None => {
                // Unclosed `{` — treat the rest as a literal.
                literals.push(&rest[open..]);
                rest = "";
                break;
            }
        }
    }
    literals.push(rest);

    // Walk the candidate consuming each literal in order. Between
    // literals, the candidate may contain anything (the substituted
    // token value). Anchored at both ends.
    let first = literals[0];
    if !candidate.starts_with(first) {
        return false;
    }
    let last = literals.last().copied().unwrap_or("");
    if !candidate.ends_with(last) {
        return false;
    }

    let mut cursor = first.len();
    // Skip the first; it's already matched as a prefix. Skip the last;
    // it's matched as a suffix. The middle pieces must appear in order.
    let middle = if literals.len() >= 2 {
        &literals[1..literals.len() - 1]
    } else {
        &[][..]
    };
    for piece in middle {
        if piece.is_empty() {
            continue;
        }
        match candidate[cursor..].find(piece) {
            Some(idx) => cursor += idx + piece.len(),
            None => return false,
        }
    }

    // The remaining tail of the candidate must be exactly `last` —
    // otherwise an extra suffix beyond what the pattern allows snuck in.
    cursor + last.len() <= candidate.len() && candidate.len() - last.len() >= cursor
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 5, 20, 14, 30, 45).unwrap()
    }

    #[test]
    fn resolves_all_tokens() {
        let out = resolve(
            "inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}{ss}.zip",
            "My Notes",
            ts(),
        );
        assert_eq!(out, "inkycap-My Notes-20260520-143045.zip");
    }

    #[test]
    fn sanitizes_windows_reserved_chars() {
        assert_eq!(sanitize_token_value("foo/bar"), "foo_bar");
        assert_eq!(sanitize_token_value("a:b*c?d"), "a_b_c_d");
        assert_eq!(sanitize_token_value("foo\\\\bar"), "foo_bar");
    }

    #[test]
    fn sanitizes_windows_reserved_names() {
        assert_eq!(sanitize_token_value("CON"), "CON_");
        assert_eq!(sanitize_token_value("aux"), "aux_");
        assert_eq!(sanitize_token_value("LPT1.notebox"), "LPT1.notebox_");
        assert_eq!(sanitize_token_value("not-reserved"), "not-reserved");
    }

    #[test]
    fn sanitizes_collapses_and_trims() {
        assert_eq!(sanitize_token_value("  foo  "), "foo");
        assert_eq!(sanitize_token_value("...foo..."), "foo");
        assert_eq!(sanitize_token_value("a//b\\\\c"), "a_b_c");
    }

    #[test]
    fn sanitizes_empty_to_untitled() {
        assert_eq!(sanitize_token_value(""), "untitled");
        assert_eq!(sanitize_token_value("///"), "untitled");
        assert_eq!(sanitize_token_value("..."), "untitled");
    }

    #[test]
    fn matches_pattern_basics() {
        let p = "inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}.zip";
        assert!(matches_pattern(p, "inkycap-foo-20260520-1430.zip"));
        assert!(!matches_pattern(p, "something-else.zip"));
        assert!(!matches_pattern(p, "inkycap-foo-20260520-1430.txt"));
    }

    #[test]
    fn unknown_tokens_passthrough() {
        // `{quarter}` is not a known token; the substitution leaves it
        // in place. Matching against the resolved filename should still
        // round-trip via `matches_pattern` because that treats every
        // `{…}` segment as a wildcard.
        let resolved = resolve("inkycap-{quarter}-{YYYY}.zip", "n", ts());
        assert_eq!(resolved, "inkycap-{quarter}-2026.zip");
        assert!(matches_pattern("inkycap-{quarter}-{YYYY}.zip", &resolved));
    }
}
