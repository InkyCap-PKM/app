//! Audit and repair foreign `.typ` files in the notebox.
//!
//! Users frequently bring `.typ` files into InkyCap from other tools
//! (Pandoc/typst.app conversion of `.docx`, files copied from another
//! project, tutorials downloaded from the web, etc.). These foreign files
//! compile fine in stock Typst but are missing the small preamble that
//! makes them first-class citizens in InkyCap:
//!
//! 1. The `inkycap-notebox` package import — without it, `#wikilink(...)`,
//!    `#tag(...)`, `#callout(...)`, and other notebox primitives would not
//!    resolve when the user adds them later.
//! 2. A top-level `#note(...)` metadata call — without it, the collection
//!    table has nothing to display for the file (no title/author/date),
//!    and `typst query` against `<inkycap-note>` returns no entries.
//!
//! This module exposes two Tauri commands:
//! - [`audit_typ_files`] — walk the notebox and report which files are
//!   missing each preamble element.
//! - [`repair_typ_files`] — apply non-destructive fixes (prepend the
//!   import, insert a stub `#note()`) to a user-chosen subset.
//!
//! The repairs never overwrite existing content: if a file already has a
//! `#note(...)` call we leave it alone, even if the call is empty or
//! missing fields the user might expect.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::errors::InkyCapError;
use crate::state::{AppState, NoteboxSession};
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter::note_call_span;
use serde::Deserialize;

use crate::typst_pipeline::source_lint::{self, MdFix, SyntaxIssue};

/// Proposed Markdown→Typst fixes for one file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMdFixes {
    pub path: String,
    pub fixes: Vec<MdFix>,
}

/// Typst syntax errors found in one file (reported, never auto-fixed).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSyntaxErrors {
    pub path: String,
    pub errors: Vec<SyntaxIssue>,
}

/// Result of one audit pass over the notebox.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypAuditReport {
    /// Total `.typ` files visited (excluding those under `.inkycap/`).
    pub total_scanned: usize,
    /// Notebox-relative paths of files missing the `inkycap-notebox` import.
    pub missing_import: Vec<String>,
    /// Notebox-relative paths of files missing a `#note(...)` call.
    pub missing_note: Vec<String>,
    /// Files carrying leftover Markdown markup, with the proposed fixes.
    pub markdown_fixes: Vec<FileMdFixes>,
    /// Files with Typst syntax errors (reported for manual repair).
    pub syntax_errors: Vec<FileSyntaxErrors>,
}

/// Walk the notebox for `.typ` files and report which ones are missing
/// either the `inkycap-notebox` import line or a `#note(...)` metadata
/// call. Files under `.inkycap/` (the notebox's internal package and
/// scaffold storage) are skipped — they are not user notes.
#[tauri::command]
pub async fn audit_typ_files(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TypAuditReport, InkyCapError> {
    let session = state.session(window.label()).await;
    Ok(collect_audit(&session).await?.0)
}

/// The audit scan, shared by [`audit_typ_files`] and [`save_audit_report`].
/// Returns the report plus the notebox root (the latter only needed when
/// writing the report file).
async fn collect_audit(
    session: &NoteboxSession,
) -> Result<(TypAuditReport, PathBuf), InkyCapError> {
    let storage = session.get_storage().await?;
    let notebox_root_guard = session.notebox_root.read().await;
    let notebox_root = notebox_root_guard
        .as_ref()
        .cloned()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    drop(notebox_root_guard);

    let abs_paths = storage.list_files(&PathBuf::from(""), "*.typ").await?;

    let mut report = TypAuditReport {
        total_scanned: 0,
        missing_import: Vec::new(),
        missing_note: Vec::new(),
        markdown_fixes: Vec::new(),
        syntax_errors: Vec::new(),
    };

    for abs in abs_paths {
        // Resolve to a notebox-relative path for both display and skipping
        // the notebox's internal `.inkycap/` tree. `list_files` skips most
        // hidden dirs but defensively re-check here so the audit stays
        // correct even if that policy changes.
        let rel = match abs.strip_prefix(&notebox_root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with(".inkycap/") || rel_str.starts_with(".inkycap\\") {
            continue;
        }

        let content = match storage.read_file(&rel).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        report.total_scanned += 1;

        if !has_notebox_import(&content) {
            report.missing_import.push(rel_str.clone());
        }
        let needs_note = note_call_span(&content).is_none();

        // Cleanup pass: leftover Markdown (auto-fixable) + syntax errors
        // (reported only). Both are independent of the preamble checks.
        let md = source_lint::detect_md_fixes(&content);
        if !md.is_empty() {
            report.markdown_fixes.push(FileMdFixes {
                path: rel_str.clone(),
                fixes: md,
            });
        }
        let syn = source_lint::detect_syntax_errors(&content);
        if !syn.is_empty() {
            report.syntax_errors.push(FileSyntaxErrors {
                path: rel_str.clone(),
                errors: syn,
            });
        }

        if needs_note {
            report.missing_note.push(rel_str);
        }
    }

    report.missing_import.sort();
    report.missing_note.sort();
    report.markdown_fixes.sort_by(|a, b| a.path.cmp(&b.path));
    report.syntax_errors.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((report, notebox_root))
}

/// Filename of the audit report written at the notebox root.
const REPORT_NAME: &str = "InkyCap Audit Report.typ";

/// Write the audit results to a note at the notebox root and return its
/// absolute (frontend-shaped) path, so the user can open it in a tab and work
/// through the findings while editing files in other tabs — the full-screen
/// audit dialog can't be open at the same time. Re-running regenerates it.
#[tauri::command]
pub async fn save_audit_report(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let (report, notebox_root) = collect_audit(&session).await?;
    let content = format_audit_report(&report);
    let rel = PathBuf::from(REPORT_NAME);
    let storage = session.get_storage().await?;
    storage.write_file(&rel, &content).await?;
    Ok(crate::storage::path::to_frontend_string(
        &notebox_root.join(&rel),
    ))
}

/// Render the audit report as an InkyCap note. Paths go in inline-code spans so
/// markup characters in filenames are inert; messages are plain text. Grouped
/// by concern, with one `===` sub-heading per file in the detailed sections so
/// the report's own outline doubles as a worklist.
fn format_audit_report(report: &TypAuditReport) -> String {
    use std::fmt::Write as _;
    let today = chrono::Local::now().date_naive().format("%Y-%m-%d");
    let mut s = String::new();
    s.push_str(&crate::notebox_package::import_line());
    s.push('\n');
    s.push_str("#note(title: \"InkyCap Audit Report\")\n\n");
    s.push_str("= InkyCap audit report\n\n");
    let _ = writeln!(
        s,
        "Generated {today}. Scanned {} .typ file(s). Keep this note open for \
         reference while you fix each file in its own tab; re-run \"Audit .typ \
         files\" and Save again to refresh.\n",
        report.total_scanned
    );

    if !report.syntax_errors.is_empty() {
        let _ = writeln!(
            s,
            "== Typst syntax errors ({} files)\n",
            report.syntax_errors.len()
        );
        s.push_str(
            "A syntax error (a missing bracket, a stray token, a typo). InkyCap \
             can't safely auto-fix these — open each file and fix it at the line \
             shown.\n\n",
        );
        for f in &report.syntax_errors {
            let _ = writeln!(s, "=== {}", code_span(&f.path));
            let _ = writeln!(s, "\n{}\n", wikilink(&f.path));
            for e in &f.errors {
                let _ = writeln!(s, "- L{}:{} — {}", e.line, e.column, e.message);
            }
            s.push('\n');
        }
    }

    if !report.markdown_fixes.is_empty() {
        let _ = writeln!(
            s,
            "== Leftover Markdown ({} files)\n",
            report.markdown_fixes.len()
        );
        s.push_str(
            "These look like leftover Markdown. The audit dialog's \"Fix \
             Markdown\" button can rewrite them to Typst (review each first), or \
             fix them by hand.\n\n",
        );
        for f in &report.markdown_fixes {
            let _ = writeln!(s, "=== {}", code_span(&f.path));
            let _ = writeln!(s, "\n{}\n", wikilink(&f.path));
            for fx in &f.fixes {
                let _ = writeln!(
                    s,
                    "- L{} ({}): {} → {}",
                    fx.line,
                    fx.kind,
                    code_span(&fx.before),
                    code_span(&fx.after)
                );
            }
            s.push('\n');
        }
    }

    if !report.missing_import.is_empty() {
        let _ = writeln!(
            s,
            "== Missing inkycap-notebox import ({} files)\n",
            report.missing_import.len()
        );
        for p in &report.missing_import {
            let _ = writeln!(s, "- {} {}", wikilink(p), code_span(p));
        }
        s.push('\n');
    }

    if !report.missing_note.is_empty() {
        // `#note(...)` is wrapped in a code span — bare in markup it parses as a
        // Typst function call (with an empty spread), which is a syntax error.
        let _ = writeln!(
            s,
            "== Missing {} metadata ({} files)\n",
            code_span("#note(...)"),
            report.missing_note.len()
        );
        for p in &report.missing_note {
            let _ = writeln!(s, "- {} {}", wikilink(p), code_span(p));
        }
        s.push('\n');
    }

    s
}

/// The note name for a notebox-relative path (filename minus `.typ`) — what
/// `resolve_wikilink` matches a `#wikilink(...)` target against.
fn note_stem(rel_path: &str) -> &str {
    let file = rel_path.rsplit('/').next().unwrap_or(rel_path);
    file.strip_suffix(".typ").unwrap_or(file)
}

/// A `#wikilink("<note name>")` for the given path — clickable in the editor to
/// open that note. Every scanned `.typ` is in the index (even ones that fail to
/// compile), so these resolve rather than offering to create a new note.
pub(crate) fn wikilink(rel_path: &str) -> String {
    let stem = note_stem(rel_path)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("#wikilink(\"{stem}\")")
}

/// Wrap text in a Typst inline-code span, so paths/snippets with markup
/// characters (`*`, `_`, `#`, `@`, …) render literally. A backtick in the text
/// (vanishingly rare in a path) is dropped to keep the span well-formed.
pub(crate) fn code_span(text: &str) -> String {
    format!("`{}`", text.replace('`', ""))
}

/// Apply the non-destructive preamble fixes to the given files. Each
/// repaired file is added to the returned list with its notebox-relative
/// path. Files that turn out to already be in good shape (e.g. another
/// process patched them between audit and repair) are silently skipped.
#[tauri::command]
pub async fn repair_typ_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TypRepairSummary, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;

    let import_line = crate::notebox_package::import_line();
    let mut summary = TypRepairSummary {
        repaired: Vec::new(),
        errors: Vec::new(),
    };

    for rel_str in paths {
        let rel_path = PathBuf::from(&rel_str);
        let original = match storage.read_file(&rel_path).await {
            Ok(c) => c,
            Err(e) => {
                summary
                    .errors
                    .push(format!("{}: read failed: {}", rel_str, e));
                continue;
            }
        };

        let repaired = apply_preamble_fixes(&original, &import_line);
        if repaired == original {
            // Already conformant — nothing to do.
            continue;
        }

        if let Err(e) = storage.write_file(&rel_path, &repaired).await {
            summary
                .errors
                .push(format!("{}: write failed: {}", rel_str, e));
            continue;
        }
        summary.repaired.push(rel_str);
    }

    Ok(summary)
}

/// The Markdown fixes the user accepted for one file. A subset of the audit's
/// `markdown_fixes[*]` for that path — rejected changes are simply left out, so
/// the user can keep a line as-is if the tool misread it (or they want it that
/// way).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMdEdits {
    pub path: String,
    pub fixes: Vec<MdFix>,
}

/// Apply the user-accepted Markdown→Typst fixes. Content-changing, so it's a
/// distinct action from the additive preamble repair — the caller opts in
/// explicitly and chooses which fixes to apply per file. Files whose accepted
/// set produces no change are silently skipped.
#[tauri::command]
pub async fn repair_markdown_files(
    edits: Vec<FileMdEdits>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TypRepairSummary, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let mut summary = TypRepairSummary {
        repaired: Vec::new(),
        errors: Vec::new(),
    };

    for file in edits {
        if file.fixes.is_empty() {
            continue;
        }
        let rel_path = PathBuf::from(&file.path);
        let original = match storage.read_file(&rel_path).await {
            Ok(c) => c,
            Err(e) => {
                summary
                    .errors
                    .push(format!("{}: read failed: {}", file.path, e));
                continue;
            }
        };

        let fixed = source_lint::apply_selected_md_fixes(&original, &file.fixes);
        if fixed == original {
            continue;
        }

        if let Err(e) = storage.write_file(&rel_path, &fixed).await {
            summary
                .errors
                .push(format!("{}: write failed: {}", file.path, e));
            continue;
        }
        summary.repaired.push(file.path);
    }

    Ok(summary)
}

/// Outcome of a repair run. `repaired` carries the files actually
/// rewritten; `errors` carries human-readable messages for any failure
/// (read, write, etc.). A successful run with zero changes returns both
/// vectors empty.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypRepairSummary {
    pub repaired: Vec<String>,
    pub errors: Vec<String>,
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Detect whether the file already pulls in the inkycap-notebox library.
/// Accepts both the canonical version-less import path and the legacy
/// versioned package path, including non-glob variants
/// (`#import "...notebox.typ": tag, wikilink`).
fn has_notebox_import(content: &str) -> bool {
    content
        .lines()
        .any(crate::notebox_package::is_notebox_import_line)
}

/// Build the corrected source for a single file. Two independent
/// fixes are applied; either or both may be needed:
/// - prepend the inkycap-notebox `#import` line if missing,
/// - insert an empty `#note()` stub directly after the import block if
///   no `#note(...)` call is present anywhere in the file.
///
/// The function never deletes content. If the source already satisfies
/// both invariants, it is returned unchanged.
fn apply_preamble_fixes(source: &str, import_line: &str) -> String {
    let mut out = String::with_capacity(source.len() + import_line.len() + 16);

    // 1. Ensure the notebox-package import is present, prepended if absent.
    let with_import = if has_notebox_import(source) {
        source.to_string()
    } else {
        // Preserve the user's leading whitespace structure: insert the
        // import at the very top, followed by a single newline. Don't
        // collapse blank lines that already exist below.
        format!("{}\n{}", import_line, source)
    };

    // 2. Ensure a `#note(...)` call exists. If not, insert `#note()`
    //    right after the trailing newline of the inkycap-notebox import
    //    line. We re-detect the import position from `with_import` so
    //    this works whether we just prepended it or it was already
    //    present higher up in the file.
    if note_call_span(&with_import).is_some() {
        return with_import;
    }

    // Locate the notebox-library import line and insert `#note()` on the
    // line directly below it. If the marker is absent for some reason
    // (e.g. an unusual import variant we didn't match earlier), fall
    // back to prepending the stub.
    let insert_at = {
        let mut cursor = 0usize;
        let mut found: Option<usize> = None;
        for line in with_import.split_inclusive('\n') {
            let body = line.strip_suffix('\n').unwrap_or(line);
            if crate::notebox_package::is_notebox_import_line(body) {
                found = Some(cursor + line.len());
                break;
            }
            cursor += line.len();
        }
        found
    };

    match insert_at {
        Some(idx) => {
            out.push_str(&with_import[..idx]);
            out.push_str("#note()\n");
            out.push_str(&with_import[idx..]);
            out
        }
        None => format!("#note()\n{}", with_import),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import_line() -> String {
        crate::notebox_package::import_line()
    }

    #[test]
    fn audit_report_is_valid_typst() {
        // The generated report must itself be syntactically valid Typst — even
        // when file names / fix snippets contain markup-active characters,
        // which `code_span` neutralises by wrapping in inline code.
        let report = TypAuditReport {
            total_scanned: 3,
            missing_import: vec!["Notebox/foreign *star*.typ".into()],
            missing_note: vec!["Indexes/no _meta_ here.typ".into()],
            markdown_fixes: vec![FileMdFixes {
                path: "Ephemera/notes #1.typ".into(),
                fixes: vec![MdFix {
                    line: 1,
                    kind: "heading".into(),
                    before: "# Title".into(),
                    after: "= Title".into(),
                }],
            }],
            syntax_errors: vec![FileSyntaxErrors {
                path: "Indexes/People/David Secko.typ".into(),
                errors: vec![SyntaxIssue {
                    line: 21,
                    column: 154,
                    message: "unclosed delimiter".into(),
                }],
            }],
        };
        let content = format_audit_report(&report);
        assert!(content.contains("InkyCap audit report"));
        assert!(content.contains("Typst syntax errors (1 files)"));
        // Each file gets a clickable wikilink (by note name, not path).
        assert!(
            content.contains("#wikilink(\"David Secko\")"),
            "missing wikilink:\n{content}"
        );
        assert!(
            content.contains("#wikilink(\"notes #1\")"),
            "missing wikilink:\n{content}"
        );
        let errs = source_lint::detect_syntax_errors(&content);
        assert!(
            errs.is_empty(),
            "generated report is not valid Typst: {errs:?}\n---\n{content}"
        );
    }

    #[test]
    fn detects_missing_notebox_import() {
        let src = "= Hello\nbody\n";
        assert!(!has_notebox_import(src));
    }

    #[test]
    fn detects_present_notebox_import() {
        let src = "#import \"/.inkycap/notebox.typ\": *\n= Hello\n";
        assert!(has_notebox_import(src));
    }

    #[test]
    fn repair_adds_both_when_missing() {
        let src = "= Body\nText.\n";
        let out = apply_preamble_fixes(src, &import_line());
        assert!(has_notebox_import(&out));
        assert!(note_call_span(&out).is_some());
        assert!(out.ends_with("= Body\nText.\n"));
    }

    #[test]
    fn repair_only_adds_note_when_import_present() {
        let src = "#import \"/.inkycap/notebox.typ\": *\n= Body\n";
        let out = apply_preamble_fixes(src, &import_line());
        // Import line not duplicated.
        assert_eq!(out.matches("/.inkycap/notebox.typ").count(), 1);
        assert!(note_call_span(&out).is_some());
        // Stub note inserted directly after the import line.
        assert!(out.starts_with("#import \"/.inkycap/notebox.typ\": *\n#note()\n"));
    }

    #[test]
    fn repair_only_adds_import_when_note_present() {
        let src = "#note(collection: (\"X\",))\n= Body\n";
        let out = apply_preamble_fixes(src, &import_line());
        assert!(has_notebox_import(&out));
        assert!(note_call_span(&out).is_some());
        // The user's existing #note() must be preserved verbatim.
        assert!(out.contains("#note(collection: (\"X\",))"));
        // Import comes first (canonical version-less path).
        assert!(out.starts_with("#import \"/.inkycap/notebox.typ\""));
    }

    #[test]
    fn repair_idempotent_on_conformant_file() {
        let src = "#import \"/.inkycap/notebox.typ\": *\n#note(title: \"X\")\n= Body\n";
        let out = apply_preamble_fixes(src, &import_line());
        assert_eq!(out, src);
    }

    #[test]
    fn repair_preserves_unicode_body() {
        // Multi-byte content must round-trip byte-identical through the
        // repair. Same hazard category as the strip_bibliography_call
        // bug — keep this test in lockstep.
        let src = "= Café — résumé\nNaïve coöperate. 你好 شكرا 👨‍👩‍👧‍👦\n";
        let out = apply_preamble_fixes(src, &import_line());
        assert!(out.contains("Café — résumé"));
        assert!(out.contains("Naïve coöperate. 你好 شكرا 👨‍👩‍👧‍👦"));
    }
}
