//! Fails CI if a path reaches the frontend in an OS-native form. On Windows:
//!
//!   - `std::fs::canonicalize` adds a `\\?\` prefix, so frontend comparisons
//!     like `tab.path === node.path` fail against paths without it.
//!   - `Path::display()` keeps `\` separators, while the frontend's string
//!     handling (`split("/")`, `startsWith(... + "/")`) assumes `/`.
//!
//! Paths sent to the frontend go through
//! [`crate::storage::to_frontend_string`], which removes the prefix and uses
//! forward slashes on every OS.
//!
//! This test searches the source for `path.display().to_string()`. A legitimate
//! use (an error message, a subprocess argument) opts out with `//
//! path-stringification-ok: <one-line reason>` on the line.
//!
//! Works like [`utf8_safety.rs`].

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

        // Skip lines inside `#[cfg(test)]` blocks: tests use made-up
        // forward-slash paths and never cross IPC. The check is line-based: on
        // at `#[cfg(test)]` (or `#[test]`), off when its braces close.
        let mut in_test_block = false;
        let mut test_brace_depth: i32 = 0;

        for (line_no, raw_line) in content.lines().enumerate() {
            let trimmed = raw_line.trim_start();

            // The attribute is always on its own line (rustfmt puts it there).
            if !in_test_block
                && (trimmed.starts_with("#[cfg(test)]") || trimmed.starts_with("#[test]"))
            {
                in_test_block = true;
                test_brace_depth = 0;
            }

            if in_test_block {
                // Braces in string literals are counted too; at worst that
                // extends the skipped region, never shortens it.
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

            // Drop a trailing `// …` comment before searching, so a comment
            // mentioning `.display().to_string()` doesn't count. The opt-out
            // marker is in the comment, so it's checked on the raw line.
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
