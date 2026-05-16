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
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter::note_call_span;

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
}

/// Walk the notebox for `.typ` files and report which ones are missing
/// either the `inkycap-notebox` import line or a `#note(...)` metadata
/// call. Files under `.inkycap/` (the notebox's internal package and
/// scaffold storage) are skipped — they are not user notes.
#[tauri::command]
pub async fn audit_typ_files(
    state: State<'_, AppState>,
) -> Result<TypAuditReport, InkyCapError> {
    let storage = state.get_storage().await?;
    let notebox_root_guard = state.notebox_root.read().await;
    let notebox_root = notebox_root_guard
        .as_ref()
        .cloned()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    drop(notebox_root_guard);

    let abs_paths = storage
        .list_files(&PathBuf::from(""), "*.typ")
        .await?;

    let mut report = TypAuditReport {
        total_scanned: 0,
        missing_import: Vec::new(),
        missing_note: Vec::new(),
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
        if note_call_span(&content).is_none() {
            report.missing_note.push(rel_str);
        }
    }

    report.missing_import.sort();
    report.missing_note.sort();
    Ok(report)
}

/// Apply the non-destructive preamble fixes to the given files. Each
/// repaired file is added to the returned list with its notebox-relative
/// path. Files that turn out to already be in good shape (e.g. another
/// process patched them between audit and repair) are silently skipped.
#[tauri::command]
pub async fn repair_typ_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<TypRepairSummary, InkyCapError> {
    let storage = state.get_storage().await?;

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
                summary.errors.push(format!("{}: read failed: {}", rel_str, e));
                continue;
            }
        };

        let repaired = apply_preamble_fixes(&original, &import_line);
        if repaired == original {
            // Already conformant — nothing to do.
            continue;
        }

        if let Err(e) = storage.write_file(&rel_path, &repaired).await {
            summary.errors.push(format!("{}: write failed: {}", rel_str, e));
            continue;
        }
        summary.repaired.push(rel_str);
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
    content.lines().any(crate::notebox_package::is_notebox_import_line)
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
    fn detects_missing_notebox_import() {
        let src = "= Hello\nbody\n";
        assert!(!has_notebox_import(src));
    }

    #[test]
    fn detects_present_notebox_import() {
        let src = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n= Hello\n";
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
        let src = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n= Body\n";
        let out = apply_preamble_fixes(src, &import_line());
        // Import line not duplicated.
        assert_eq!(out.matches("inkycap-notebox").count(), 1);
        assert!(note_call_span(&out).is_some());
        // Stub note inserted directly after the import line.
        assert!(out.starts_with(
            "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n#note()\n"
        ));
    }

    #[test]
    fn repair_only_adds_import_when_note_present() {
        let src = "#note(collection: (\"X\",))\n= Body\n";
        let out = apply_preamble_fixes(src, &import_line());
        assert!(has_notebox_import(&out));
        assert_eq!(note_call_span(&out).is_some(), true);
        // The user's existing #note() must be preserved verbatim.
        assert!(out.contains("#note(collection: (\"X\",))"));
        // Import comes first (canonical version-less path).
        assert!(out.starts_with("#import \"/.inkycap/notebox.typ\""));
    }

    #[test]
    fn repair_idempotent_on_conformant_file() {
        let src = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n#note(title: \"X\")\n= Body\n";
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
