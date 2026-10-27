//! Audit and repair `.typ` files from other tools (Pandoc or typst.app
//! conversions, files from other projects, downloads). They compile in Typst
//! but lack what InkyCap expects:
//!
//! 1. The `inkycap-notebox` import, without which `#wikilink(...)`,
//!    `#tag(...)`, `#callout(...)` and the other notebox functions won't
//!    resolve when added later.
//! 2. A top-level `#note(...)` call, without which collections show nothing for
//!    the file and `<inkycap-note>` queries find nothing.
//!
//! Commands:
//! - [`audit_typ_files`]: report which files lack either.
//! - [`repair_typ_files`]: add the import and an empty `#note()` to the chosen
//!   files.
//! - [`note_missing_notebox_import`] / [`add_notebox_import`]: the single-file
//!   check and fix run when a note opens.
//!
//! Repairs never overwrite content; an existing `#note(...)` is left as is,
//! even if empty.

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

/// Report the notebox's `.typ` files that lack the `inkycap-notebox` import or
/// a `#note(...)` call. Files under `.inkycap/` aren't notes and are skipped.
#[tauri::command]
pub async fn audit_typ_files(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TypAuditReport, InkyCapError> {
    let session = state.session(window.label()).await;
    Ok(collect_audit(&session).await?.0)
}

/// The scan shared by [`audit_typ_files`] and [`save_audit_report`], with the
/// notebox root (needed for writing the report).
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
        // Notebox-relative path, for display and for skipping `.inkycap/`
        // (checked again here even though `list_files` skips most hidden
        // folders).
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

/// Write the audit to a note at the notebox root and return its path, so the
/// user can work through it in a tab (the audit dialog can't stay open).
/// Re-running replaces it.
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

/// The audit report as a note. Paths are in inline code so markup characters
/// stay literal. Grouped by concern, with one `===` heading per file, so the
/// outline works as a checklist.
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

/// A `#wikilink("<note name>")` for `rel_path`. Every scanned `.typ` is
/// indexed, even if it doesn't compile, so these resolve.
pub(crate) fn wikilink(rel_path: &str) -> String {
    let stem = note_stem(rel_path)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("#wikilink(\"{stem}\")")
}

/// Text in inline code, so markup characters (`*`, `_`, `#`, `@`) are literal.
/// Backticks are dropped to keep the span valid.
pub(crate) fn code_span(text: &str) -> String {
    format!("`{}`", text.replace('`', ""))
}

/// Apply the preamble fixes to the given files and return the notebox-relative
/// paths changed. Files already fixed (e.g. edited since the audit) are
/// skipped.
#[tauri::command]
pub async fn repair_typ_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<TypRepairSummary, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;

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

        let repaired = apply_preamble_fixes(&original);
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

/// The notebox-relative path of `path` if the import check applies: a `.typ` in
/// the open notebox, outside `.inkycap/`, not in the read-only documentation
/// notebox. Otherwise `None`.
async fn user_note_rel_path(
    session: &NoteboxSession,
    path: &str,
) -> Result<Option<PathBuf>, InkyCapError> {
    if session.is_documentation() {
        return Ok(None);
    }
    let storage = session.get_storage().await?;
    let arg = crate::storage::path::sanitize_notebox_arg(path)?;
    let rel = crate::commands::file_ops::notebox_relative_path(&arg, &storage);
    let is_typ = rel.extension().is_some_and(|e| e == "typ");
    let is_internal = rel
        .components()
        .next()
        .is_some_and(|c| c.as_os_str() == ".inkycap");
    // Absolute paths that didn't strip to a relative one are outside the
    // notebox; storage would refuse them anyway.
    if !is_typ || is_internal || rel.is_absolute() {
        return Ok(None);
    }
    Ok(Some(rel))
}

/// True when `path` is a user note (see [`user_note_rel_path`]) without the
/// `inkycap-notebox` import. The editor calls this before loading a note, to
/// add the import or ask first.
#[tauri::command]
pub async fn note_missing_notebox_import(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<bool, InkyCapError> {
    let session = state.session(window.label()).await;
    let Some(rel) = user_note_rel_path(&session, &path).await? else {
        return Ok(false);
    };
    let content = session.get_storage().await?.read_file(&rel).await?;
    Ok(!has_notebox_import(&content))
}

/// Add the `inkycap-notebox` import to the note at `path` if missing. Unlike
/// [`repair_typ_files`], adds no `#note()`, so opening changes as little as
/// possible. `true` if the file was rewritten.
#[tauri::command]
pub async fn add_notebox_import(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<bool, InkyCapError> {
    let session = state.session(window.label()).await;
    let Some(rel) = user_note_rel_path(&session, &path).await? else {
        return Ok(false);
    };
    let storage = session.get_storage().await?;
    let original = storage.read_file(&rel).await?;
    let fixed = crate::notebox_package::ensure_import(&original);
    if fixed == original {
        return Ok(false);
    }
    storage.write_file(&rel, &fixed).await?;
    Ok(true)
}

/// The Markdown fixes the user accepted for one file: a subset of the audit's
/// `markdown_fixes[*]`, with rejected ones left out.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMdEdits {
    pub path: String,
    pub fixes: Vec<MdFix>,
}

/// Apply the accepted Markdown-to-Typst fixes. These change content, so unlike
/// the preamble repair the user chooses each fix. Files with no resulting
/// change are skipped.
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

/// Result of a repair: `repaired` are the files rewritten, `errors` messages
/// for failures. Both empty when nothing changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypRepairSummary {
    pub repaired: Vec<String>,
    pub errors: Vec<String>,
}

// ── Helpers ──────────────────────────────────────────────────────────────

/// Whether the file imports the notebox library, by the current path or the
/// older versioned package path, including non-glob imports (`#import
/// "...notebox.typ": tag, wikilink`).
fn has_notebox_import(content: &str) -> bool {
    content
        .lines()
        .any(crate::notebox_package::is_notebox_import_line)
}

/// The fixed source for one file: add the `#import` line if missing, and an
/// empty `#note()` after the imports if there is no `#note(...)`. Never removes
/// content; unchanged when both are present.
fn apply_preamble_fixes(source: &str) -> String {
    // 1. Ensure the notebox-package import is present, prepended if absent.
    let with_import = crate::notebox_package::ensure_import(source);

    // 2. Add `#note()` after the import line if there is no `#note(...)`,
    //    finding the import in `with_import` whether it was just added or
    //    already there.
    if note_call_span(&with_import).is_some() {
        return with_import;
    }

    // Put `#note()` on the line after the import; if the import isn't found (an
    // unusual form), put it at the top.
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
        Some(idx) => format!("{}#note()\n{}", &with_import[..idx], &with_import[idx..]),
        None => format!("#note()\n{}", with_import),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_report_is_valid_typst() {
        // The report must be valid Typst even with markup characters in names
        // and snippets.
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
        let out = apply_preamble_fixes(src);
        assert!(has_notebox_import(&out));
        assert!(note_call_span(&out).is_some());
        assert!(out.ends_with("= Body\nText.\n"));
    }

    #[test]
    fn repair_only_adds_note_when_import_present() {
        let src = "#import \"/.inkycap/notebox.typ\": *\n= Body\n";
        let out = apply_preamble_fixes(src);
        // Import line not duplicated.
        assert_eq!(out.matches("/.inkycap/notebox.typ").count(), 1);
        assert!(note_call_span(&out).is_some());
        // Stub note inserted directly after the import line.
        assert!(out.starts_with("#import \"/.inkycap/notebox.typ\": *\n#note()\n"));
    }

    #[test]
    fn repair_only_adds_import_when_note_present() {
        let src = "#note(collection: (\"X\",))\n= Body\n";
        let out = apply_preamble_fixes(src);
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
        let out = apply_preamble_fixes(src);
        assert_eq!(out, src);
    }

    #[test]
    fn repair_preserves_unicode_body() {
        // Multi-byte content must come through the repair byte for byte.
        let src = "= Café — résumé\nNaïve coöperate. 你好 شكرا 👨‍👩‍👧‍👦\n";
        let out = apply_preamble_fixes(src);
        assert!(out.contains("Café — résumé"));
        assert!(out.contains("Naïve coöperate. 你好 شكرا 👨‍👩‍👧‍👦"));
    }
}
