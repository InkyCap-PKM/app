//! File names for backup archives from the user's pattern (e.g.
//! `"inkycap-{notebox}-{YYYY}{MM}{DD}-{HH}{mm}.zip"`), a notebox name and a
//! time. Substituted values are made safe for every OS: Windows-reserved
//! characters (`< > : " / \ | ? *` and controls) and device names (CON, PRN,
//! AUX, NUL, COM1–9, LPT1–9) are handled, so `Aux Notes` still gives a valid
//! name, and slashes are removed so a notebox name can't redirect the output.
//! The pattern itself isn't changed; it may contain subfolders on purpose.

use chrono::{DateTime, Datelike, Local, Timelike};

/// Windows reserved names, lowercase, compared case-insensitively with the stem
/// (before the first dot), since `CON.foo` is reserved too.
const WINDOWS_RESERVED_STEMS: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Whether Windows rejects `ch` in a file name: the nine reserved punctuation
/// characters and every ASCII control (other systems allow controls, but a
/// newline in a name breaks every tool showing it). Shared with the name audit.
pub fn is_windows_illegal_char(ch: char) -> bool {
    matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (ch as u32) < 0x20
}

/// Whether `name`'s stem (before the first dot) is a Windows device name
/// (`CON`, `LPT1`, …), so `CON.typ` counts. Windows can't create such a file.
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

/// Make a substituted value safe for a file name: reserved characters become
/// `_` (runs collapsed), leading and trailing whitespace and dots are trimmed
/// (Windows strips trailing ones on write), and a reserved stem becomes
/// `<stem>_`. `"untitled"` if nothing is left.
pub fn sanitize_token_value(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        out.push(if is_windows_illegal_char(ch) { '_' } else { ch });
    }

    // Collapse `_` runs, so "Foo // Bar" doesn't become "Foo___Bar".
    while out.contains("__") {
        out = out.replace("__", "_");
    }

    // Windows drops trailing dots and spaces on write; trim them so the name on
    // disk matches the one reported. Leading ones too, for symmetry.
    let trimmed = out.trim_matches(|c: char| c.is_whitespace() || c == '.');

    // Only underscores left (the input was all reserved characters): use
    // "untitled".
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        return "untitled".to_string();
    }

    // Reserved stems, checked before the first dot (`CON.notebox` → "CON").
    if is_windows_reserved_stem(trimmed) {
        return format!("{trimmed}_");
    }

    trimmed.to_string()
}

/// Fill in a pattern for a notebox name and time. Unknown `{tokens}` are kept
/// as written.
pub fn resolve(pattern: &str, notebox_name: &str, when: DateTime<Local>) -> String {
    let notebox = sanitize_token_value(notebox_name);

    // Substituted by hand rather than with chrono format codes, so a `%` in the
    // user's pattern isn't misread.
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

/// Whether a file name came from `pattern`, so retention pruning only touches
/// backups. Every `{token}` (known or not) is a wildcard, so files from before
/// a pattern change still match.
pub fn matches_pattern(pattern: &str, candidate: &str) -> bool {
    // Split at `{...}` runs: text outside is literal, each run a wildcard
    // matching as little as possible.
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

    // Match each literal in order, with anything between them, anchored at both
    // ends.
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
        // An unknown `{quarter}` stays in the name, and `matches_pattern` still
        // matches it as a wildcard.
        let resolved = resolve("inkycap-{quarter}-{YYYY}.zip", "n", ts());
        assert_eq!(resolved, "inkycap-{quarter}-2026.zip");
        assert!(matches_pattern("inkycap-{quarter}-{YYYY}.zip", &resolved));
    }
}
