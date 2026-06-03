//! Static-analysis guard that fails CI when paths reach the frontend in an
//! OS-native shape. The motivating bug (and a long tail of likely future
//! ones) was Windows-only:
//!
//!   - `std::fs::canonicalize` prepends a `\\?\` UNC verbatim prefix on
//!     Windows. Frontend equality checks like `tab.path === node.path` and
//!     `tab.path.startsWith(root + "/")` then silently fail because no
//!     other path source carries the prefix.
//!   - `Path::display()` preserves OS-native separators. The frontend's
//!     string operations (`split("/")`, `startsWith(... + "/")`, etc.)
//!     assume forward slashes.
//!
//! Outbound paths therefore flow through
//! [`crate::storage::to_frontend_string`], which strips the verbatim prefix
//! and normalizes to forward slashes — a single canonical shape that's the
//! same on every OS.
//!
//! This test enforces that invariant by grepping the source tree for
//! `path.display().to_string()`. Legitimate exceptions (error messages
//! that never cross the IPC boundary, subprocess argv paths, etc.) can opt
//! out by appending `// path-stringification-ok: <one-line reason>` to the
//! offending line. The reason is required so the next reader understands
//! why this particular site was waved through.
//!
//! Same shape as [`utf8_safety.rs`] — see that file for the broader
//! "grep-based forbidden patterns" rationale.

use std::path::Path;

struct ForbiddenPattern {
    description: &'static str,
    needle: &'static str,
    line_allowlist: &'static [&'static str],
}

const FORBIDDEN: &[ForbiddenPattern] = &[ForbiddenPattern {
    description: "path stringified with `.display().to_string()`. \
                      Outbound IPC paths must flow through \
                      `crate::storage::to_frontend_string`, which strips \
                      the Windows `\\\\?\\` UNC prefix and normalizes \
                      separators. If this site is an error message, log \
                      line, or subprocess argv that never reaches the \
                      frontend or a path-equality check, append \
                      `// path-stringification-ok: <reason>`.",
    needle: ".display().to_string()",
    line_allowlist: &["path-stringification-ok:"],
}];

/// Files (relative to `src/`) exempt from the scan. Kept empty so every
/// exception has to justify itself per-line with the inline marker.
const FILE_ALLOWLIST: &[&str] = &[];

#[test]
fn no_raw_path_display_to_string_in_source() {
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

        // Skip lines that live inside a `#[cfg(test)]` block. Tests use
        // synthetic forward-slash paths and don't cross any IPC boundary,
        // so blanket-allowing them keeps the rule focused on production code.
        // The detector is intentionally line-level rather than syntactic:
        // we toggle on `#[cfg(test)]` and off when we leave the matching
        // braces. A `#[test]` attribute follows the same pattern.
        let mut in_test_block = false;
        let mut test_brace_depth: i32 = 0;

        for (line_no, raw_line) in content.lines().enumerate() {
            let trimmed = raw_line.trim_start();

            // Enter test scope when we see the attribute on its own line.
            // (We never see it in the middle of an expression because rustfmt
            // would split it out.)
            if !in_test_block
                && (trimmed.starts_with("#[cfg(test)]") || trimmed.starts_with("#[test]"))
            {
                in_test_block = true;
                test_brace_depth = 0;
            }

            if in_test_block {
                // Track braces *outside* string literals naively — string
                // literals containing `{` or `}` aren't common in test
                // setups, and a false positive here just over-extends the
                // exclusion, never under-extends.
                for c in raw_line.chars() {
                    match c {
                        '{' => test_brace_depth += 1,
                        '}' => {
                            test_brace_depth -= 1;
                            if test_brace_depth <= 0 {
                                in_test_block = false;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                // Skip the line itself once we know we're inside test code.
                continue;
            }

            // Strip the trailing `// …` comment from the search target so a
            // doc comment that *mentions* `.display().to_string()` doesn't
            // count as a violation. The allowlist marker sits inside the
            // comment, so we test it against the raw line.
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
            "Path-safety check failed — {} violation(s) found:\n\n{}\n\n\
             Outbound paths must use `crate::storage::to_frontend_string`. \
             For non-IPC uses (error messages, subprocess argv, etc.), \
             append `// path-stringification-ok: <one-line reason>` to the \
             offending line so the next reader knows why it was waved \
             through.",
            violations.len(),
            violations.join("\n\n"),
        );
    }
}
