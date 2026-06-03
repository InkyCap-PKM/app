//! Static-analysis guards that fail CI if forbidden UTF-8-unsafe patterns
//! reappear in the source tree. The motivating bug:
//! [`book_wrapper::strip_bibliography_call`] used to do `out.push(bytes[i]
//! as char)`, which casts a UTF-8 continuation byte to a Latin-1 codepoint,
//! shredding any multi-byte character (em-dashes, smart quotes, CJK,
//! accented Latin, RTL scripts, etc.) into garbage. The garbage then
//! produced spurious "unclosed delimiter" errors when the corrupted output
//! was fed back to the Typst compiler.
//!
//! Clippy doesn't lint `u8 as char` (it's a legal Rust cast — just usually
//! wrong when the byte came out of a UTF-8 string), so we enforce the rule
//! ourselves by grep. Add new patterns here as we identify other UTF-8
//! footguns.
//!
//! The check runs against `src-tauri/src/`; this integration-test file is
//! itself excluded so the rule descriptions can mention the patterns
//! without tripping their own check.

use std::path::Path;

/// (description, regex pattern, allowlist of substrings that, if present
/// on the matching line, exempt it). Keep the patterns conservative: false
/// positives here block the build, so any legitimate exception belongs in
/// the allowlist with a comment explaining the rationale.
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
    // Catches `bytes[i] as char`, `b as char`, and similar single-byte
    // -> char casts. We deliberately don't try to be clever — the rule
    // is "no `as char` from a u8 expression", and any legitimate
    // exception can opt out via `// utf8-safe: <reason>`.
    needle: " as char",
    line_allowlist: &["utf8-safe:"],
}];

/// Files (relative to `src/`) that are exempt from the scan entirely.
/// Empty for now — keep it that way unless a genuinely safe construct
/// can't be expressed any other way.
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
            // Strip line-comment text from the search target so that a
            // `// note: don't do `x as char` here` doc comment is not
            // flagged as a violation. The allowlist marker, however, lives
            // *inside* a comment, so we test it against the raw line.
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
