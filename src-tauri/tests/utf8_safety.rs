//! Fails CI if UTF-8-unsafe patterns appear in the source. `u8 as char` casts a
//! byte to a Latin-1 character, which breaks every multi-byte character
//! (dashes, smart quotes, accents, CJK, …); Clippy doesn't flag it, so this
//! searches for it. Add other unsafe patterns here.
//!
//! Scans `src-tauri/src/`; this file isn't scanned, so it can name the
//! patterns.

use std::path::Path;

/// (description, pattern, allowlist of substrings that exempt a matching line).
/// Keep patterns conservative, since a false positive blocks the build; real
/// exceptions go in the allowlist with a reason.
struct ForbiddenPattern {
    description: &'static str,
    needle: &'static str,
    /// Substrings that, when present on the offending line, allow it
    /// through. Used for the rare case of a deliberate, audited use.
    line_allowlist: &'static [&'static str],
}

const FORBIDDEN: &[ForbiddenPattern] = &[ForbiddenPattern {
    description: "byte-cast to char (corrupts multi-byte UTF-8). \
                      Use `push_str(&s[a..b])` for slices, or stay in `Vec<u8>` \
                      until reassembling via `String::from_utf8` / `from_utf8_lossy`.",
    // Any `as char`, such as `bytes[i] as char` or `b as char`. A legitimate
    // use opts out with `// utf8-safe: <reason>`.
    needle: " as char",
    line_allowlist: &["utf8-safe:"],
}];

/// Files (relative to `src/`) not scanned at all. Keep it empty unless a safe
/// construct can't be written any other way.
const FILE_ALLOWLIST: &[&str] = &[];

#[test]
fn no_forbidden_utf8_patterns_in_source() {
    // Find the crate root (where Cargo.toml lives), then scan `src/`.
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let src_dir = crate_root.join("src");
    assert!(
        src_dir.is_dir(),
        "expected source directory at {}",
        src_dir.display()
    );

    let mut violations: Vec<String> = Vec::new();

    for entry in walkdir::WalkDir::new(&src_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let rel = path.strip_prefix(&src_dir).unwrap();
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if FILE_ALLOWLIST.iter().any(|f| *f == rel_str) {
            continue;
        }

        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (line_no, raw_line) in content.lines().enumerate() {
            // Drop a trailing comment before searching, so a comment mentioning
            // `as char` isn't flagged. The opt-out marker is in the comment, so
            // it's checked on the raw line.
            let scan_target = match raw_line.find("//") {
                Some(idx) => &raw_line[..idx],
                None => raw_line,
            };

            for pat in FORBIDDEN {
                if !scan_target.contains(pat.needle) {
                    continue;
                }
                if pat
                    .line_allowlist
                    .iter()
                    .any(|allow| raw_line.contains(allow))
                {
                    continue;
                }
                violations.push(format!(
                    "{}:{}: forbidden pattern `{}`\n    line: {}\n    why : {}",
                    rel_str,
                    line_no + 1,
                    pat.needle.trim(),
                    raw_line.trim(),
                    pat.description,
                ));
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "UTF-8 safety check failed — {} violation(s) found:\n\n{}\n\n\
             If a use is genuinely safe (e.g. you've already verified the \
             byte is ASCII), append `// utf8-safe: <one-line reason>` to the \
             line. Otherwise, refactor to operate on `&str` slices, on \
             `chars()` / `char_indices()`, or on `Vec<u8>` reassembled \
             through `String::from_utf8`.",
            violations.len(),
            violations.join("\n\n"),
        );
    }
}
