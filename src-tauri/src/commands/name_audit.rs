//! Audit notebox entry names for cross-platform portability and link clarity.
//!
//! A notebox is a plain folder of files, and users move them between machines:
//! copied to a USB drive, pushed through the git collaboration transport,
//! zipped and handed to someone else. Linux filesystems allow names that
//! Windows and macOS cannot represent, and the damage is done *during the
//! copy*, before InkyCap is ever launched on the other machine. By then a
//! folder has been merged or a note silently overwritten.
//!
//! This module walks the notebox and reports names that will not survive the
//! trip, plus one InkyCap-specific hazard:
//!
//! 1. **Case-only collisions among siblings.** `Dogs/` and `dogs/`, or
//!    `Notes.typ` and `notes.typ`, in the same folder. Windows and macOS
//!    (by default) treat these as one name, so copying merges the folders or
//!    overwrites the file.
//! 2. **Windows reserved device names.** `CON`, `PRN`, `LPT1`, and friends
//!    cannot be created on Windows at all, extension or not.
//! 3. **Characters Windows rejects.** `< > : " | ? *` and ASCII controls.
//!    `Chapter 1: Intro.typ` is a perfectly ordinary Linux filename and an
//!    impossible Windows one.
//! 4. **Trailing dots or spaces.** Windows strips them at write time, so
//!    `notes .typ` and `notes.typ` collapse into one file there.
//! 5. **Accent-encoding collisions.** `café` written with a single `é`
//!    codepoint and `café` written as `e` plus a combining acute are
//!    different byte sequences, so Linux and Windows hold both as separate
//!    files. macOS does not: HFS+ normalizes filenames on write, and while
//!    APFS itself stores a bag of bytes, macOS layers normalization above it.
//!    So these merge on a Mac the way case variants do. Unlike every other
//!    finding here, this one is macOS-specific rather than Windows-specific.
//! 6. **Duplicate note names anywhere in the notebox.** Wikilinks resolve by
//!    filename across the whole notebox, ignoring folders, so
//!    `Projects/Ideas.typ` and `Archive/Ideas.typ` make `[[Ideas]]`
//!    ambiguous. InkyCap prevents this at creation time; these entries
//!    arrive by import from tools that don't (an Obsidian vault, say), by
//!    git merge, or by editing the folder outside the app.
//!
//! Report-only, by design. There is no repair command and there should not be
//! one: which of two colliding notes keeps the name is a judgement about their
//! contents, and renaming a note changes its wikilink identity, so inbound
//! links would need rewriting too. The `.typ` audit sets the same precedent
//! for syntax errors.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::backup::filename::{
    has_trailing_dot_or_space, is_windows_illegal_char, is_windows_reserved_stem,
};
use icu_normalizer::ComposingNormalizer;

use crate::errors::InkyCapError;
use crate::sort::compare_name;
use crate::state::{AppState, NoteboxSession};
use crate::storage::traits::{FileTreeNode, NoteboxStorage};

/// Sibling entries in one folder whose names differ only in case.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameCollision {
    /// Notebox-relative folder holding them; empty string for the root.
    pub folder: String,
    /// The colliding names exactly as they appear on disk.
    pub names: Vec<String>,
}

/// One entry whose name carries characters Windows will not accept.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameIssue {
    /// Notebox-relative path.
    pub path: String,
    /// The offending characters, space-separated, controls as `U+XXXX`.
    pub detail: String,
}

/// One note in a duplicate-name group, carrying both path shapes because the
/// two consumers need different ones: the report note prints the relative path,
/// while the dialog opens a tab and needs the absolute one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateNotePath {
    /// Notebox-relative, for display.
    pub rel: String,
    /// Absolute and frontend-shaped, for `openTab`.
    pub abs: String,
}

/// Notes sharing one wikilink name across different folders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateNoteName {
    /// The shared note name, in the casing of the first path listed.
    pub name: String,
    /// Every note claiming the name.
    pub paths: Vec<DuplicateNotePath>,
}

/// Result of one name audit over the notebox.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NameAuditReport {
    /// Total entries visited, files and folders together.
    pub total_scanned: usize,
    pub case_collisions: Vec<NameCollision>,
    /// Sibling names that are byte-different but identical once accents are
    /// normalized. macOS-only; Windows and Linux keep these separate.
    pub normalization_collisions: Vec<NameCollision>,
    /// Notebox-relative paths whose stem is a Windows reserved device name.
    pub reserved_names: Vec<String>,
    pub illegal_characters: Vec<NameIssue>,
    /// Notebox-relative paths ending in a dot or a space.
    pub trailing_dots_or_spaces: Vec<String>,
    pub duplicate_note_names: Vec<DuplicateNoteName>,
}

impl NameAuditReport {
    /// Whether the audit found anything worth showing the user.
    pub fn has_findings(&self) -> bool {
        !self.case_collisions.is_empty()
            || !self.normalization_collisions.is_empty()
            || !self.reserved_names.is_empty()
            || !self.illegal_characters.is_empty()
            || !self.trailing_dots_or_spaces.is_empty()
            || !self.duplicate_note_names.is_empty()
    }
}

/// Walk the notebox and report names that break on other platforms or make a
/// wikilink ambiguous. Never opens a file, so this stays fast on large
/// noteboxes: it is a tree walk plus hashing, with no I/O beyond the listing.
#[tauri::command]
pub async fn audit_notebox_names(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<NameAuditReport, InkyCapError> {
    let session = state.session(window.label()).await;
    Ok(collect_name_audit(&session).await?.0)
}

/// The scan, shared by [`audit_notebox_names`] and [`save_name_audit_report`].
/// Returns the report plus the notebox root, the latter only needed when
/// writing the report note.
async fn collect_name_audit(
    session: &NoteboxSession,
) -> Result<(NameAuditReport, PathBuf), InkyCapError> {
    let storage = session.get_storage().await?;
    let notebox_root = session
        .notebox_root
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    // `get_file_tree` already omits dot-directories (so `.inkycap/` and its
    // bundled package never appear) and `node_modules`.
    let tree = storage.get_file_tree().await?;

    let mut report = NameAuditReport::default();
    // Lowercased note name -> the paths claiming it, for the duplicate check.
    let mut note_names: HashMap<String, Vec<String>> = HashMap::new();
    scan_level(&tree, "", &mut report, &mut note_names);
    finalize(&mut report, note_names, &notebox_root);

    Ok((report, notebox_root))
}

/// Resolve the collected note names into duplicate groups and put every list
/// in display order. Split out from [`collect_name_audit`] so the scan can be
/// exercised end-to-end in tests without touching a filesystem.
fn finalize(
    report: &mut NameAuditReport,
    note_names: HashMap<String, Vec<String>>,
    notebox_root: &Path,
) {
    report.duplicate_note_names = note_names
        .into_values()
        .filter(|paths| paths.len() > 1)
        .map(|mut rels| {
            rels.sort_by(|a, b| compare_name(a, b));
            let name = crate::link_index::note_stem(Path::new(&rels[0]));
            let paths = rels
                .into_iter()
                .map(|rel| DuplicateNotePath {
                    abs: crate::storage::path::to_frontend_string(&notebox_root.join(&rel)),
                    rel,
                })
                .collect();
            DuplicateNoteName { name, paths }
        })
        .collect();

    report
        .case_collisions
        .sort_by(|a, b| compare_name(&a.folder, &b.folder));
    report
        .normalization_collisions
        .sort_by(|a, b| compare_name(&a.folder, &b.folder));
    report.reserved_names.sort_by(|a, b| compare_name(a, b));
    report
        .illegal_characters
        .sort_by(|a, b| compare_name(&a.path, &b.path));
    report
        .trailing_dots_or_spaces
        .sort_by(|a, b| compare_name(a, b));
    report
        .duplicate_note_names
        .sort_by(|a, b| compare_name(&a.name, &b.name));
}

/// Check one directory level, then recurse. `folder` is the notebox-relative
/// path of the directory holding `nodes` (empty at the root).
fn scan_level(
    nodes: &[FileTreeNode],
    folder: &str,
    report: &mut NameAuditReport,
    note_names: &mut HashMap<String, Vec<String>>,
) {
    // Both collision kinds are a property of one directory: `Dogs/` and
    // `archive/dogs/` are fine because they have different parents. So group
    // siblings, never the whole tree.
    //
    // Two folds, because the platforms differ in what they merge:
    //   * Windows (and macOS) fold case      -> `windows_key`
    //   * macOS additionally folds accent encoding -> `macos_key`
    // Every case collision is therefore also a macOS collision, so the
    // normalization group only reports what case folding alone does *not*
    // already explain.
    let mut by_case: HashMap<String, Vec<String>> = HashMap::new();
    let mut by_normalized: HashMap<String, Vec<String>> = HashMap::new();
    for n in nodes {
        by_case
            .entry(windows_key(&n.name))
            .or_default()
            .push(n.name.clone());
        by_normalized
            .entry(macos_key(&n.name))
            .or_default()
            .push(n.name.clone());
    }
    for (_, mut names) in by_case {
        if names.len() > 1 {
            names.sort_by(|a, b| compare_name(a, b));
            report.case_collisions.push(NameCollision {
                folder: folder.to_string(),
                names,
            });
        }
    }
    for (_, mut names) in by_normalized {
        // Skip groups whose members already share a case-folded key: those are
        // plain case collisions, reported above, and repeating them here would
        // just be noise.
        let unified_by_case_alone = names
            .windows(2)
            .all(|w| windows_key(&w[0]) == windows_key(&w[1]));
        if names.len() > 1 && !unified_by_case_alone {
            names.sort_by(|a, b| compare_name(a, b));
            report.normalization_collisions.push(NameCollision {
                folder: folder.to_string(),
                names,
            });
        }
    }

    for n in nodes {
        report.total_scanned += 1;
        let rel = if folder.is_empty() {
            n.name.clone()
        } else {
            format!("{folder}/{}", n.name)
        };

        if is_windows_reserved_stem(&n.name) {
            report.reserved_names.push(rel.clone());
        }
        let bad = illegal_chars_in(&n.name);
        if !bad.is_empty() {
            report.illegal_characters.push(NameIssue {
                path: rel.clone(),
                detail: bad,
            });
        }
        if has_trailing_dot_or_space(&n.name) {
            report.trailing_dots_or_spaces.push(rel.clone());
        }

        if n.is_dir {
            if let Some(children) = &n.children {
                scan_level(children, &rel, report, note_names);
            }
        } else if n.name.to_ascii_lowercase().ends_with(".typ") {
            // Like `resolve_wikilink`, match on the note stem case-folded — but
            // fold accent encoding too, which resolution does not. That makes
            // this check deliberately *coarser* than the resolver: two notes
            // named `café` with different accent encodings are distinct to the
            // resolver, yet identical to the reader, so `[[café]]` silently
            // lands on whichever one matches the encoding the user's keyboard
            // produced. An invisible near-miss is worth reporting even though
            // it is not an ambiguity in the strict sense. Do not "fix" this
            // back to a byte-exact key.
            let stem = crate::link_index::note_stem(Path::new(&n.name));
            note_names
                .entry(fold_case_and_accents(&stem))
                .or_default()
                .push(rel);
        }
    }
}

/// NFC normalizer. `new_nfc` is a `const fn` over baked-in data, so this costs
/// nothing to hold and needs no lazy initialization.
const NFC: icu_normalizer::ComposingNormalizerBorrowed<'static> = ComposingNormalizer::new_nfc();

/// Fold away both the differences a human reader cannot see in a filename:
/// letter case, and whether an accent is one codepoint or a base letter plus a
/// combining mark.
fn fold_case_and_accents(name: &str) -> String {
    NFC.normalize(name).to_lowercase()
}

/// The name as Windows sees it for collision purposes: case folded, bytes
/// otherwise untouched. NTFS does not normalize accents, so `café` written two
/// ways stays two files there.
fn windows_key(name: &str) -> String {
    name.to_lowercase()
}

/// The name as macOS sees it: case folded *and* accent-encoding folded, since
/// macOS normalizes filenames on top of the filesystem.
fn macos_key(name: &str) -> String {
    fold_case_and_accents(name)
}

/// The distinct Windows-illegal characters in `name`, in order of first
/// appearance, space-separated. Controls render as `U+XXXX` so the report
/// doesn't try to print an unprintable byte.
fn illegal_chars_in(name: &str) -> String {
    let mut seen: Vec<char> = Vec::new();
    for ch in name.chars() {
        if is_windows_illegal_char(ch) && !seen.contains(&ch) {
            seen.push(ch);
        }
    }
    seen.iter()
        .map(|c| {
            if (*c as u32) < 0x20 {
                format!("U+{:04X}", *c as u32)
            } else {
                c.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Filename of the name report written at the notebox root. Kept separate
/// from the `.typ` audit's report so the two features don't overwrite each
/// other's output.
const REPORT_NAME: &str = "InkyCap Name Report.typ";

/// Write the name audit to a note at the notebox root and return its absolute
/// (frontend-shaped) path, so the user can work through the findings in a tab
/// while the dialog is closed. Re-running regenerates it.
#[tauri::command]
pub async fn save_name_audit_report(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let (report, notebox_root) = collect_name_audit(&session).await?;
    let content = format_name_report(&report);
    let rel = PathBuf::from(REPORT_NAME);
    let storage = session.get_storage().await?;
    storage.write_file(&rel, &content).await?;
    Ok(crate::storage::path::to_frontend_string(
        &notebox_root.join(&rel),
    ))
}

/// Render the report as an InkyCap note. Paths go in inline-code spans so
/// markup characters in filenames stay inert; note names additionally get a
/// `#wikilink(...)` so the report doubles as a worklist.
fn format_name_report(report: &NameAuditReport) -> String {
    use std::fmt::Write as _;
    use crate::commands::typ_audit::code_span;

    let today = chrono::Local::now().date_naive().format("%Y-%m-%d");
    let mut s = String::new();
    s.push_str(&crate::notebox_package::import_line());
    s.push('\n');
    s.push_str("#note(title: \"InkyCap Name Report\")\n\n");
    s.push_str("= InkyCap name report\n\n");
    let _ = writeln!(
        s,
        "Generated {today}. Scanned {} entries. Each finding below is a name \
         that either breaks when this notebox is copied to Windows or macOS, \
         or makes a wikilink ambiguous.\n",
        report.total_scanned
    );

    if !report.has_findings() {
        s.push_str("No problems found.\n");
        return s;
    }

    if !report.case_collisions.is_empty() {
        s.push_str("== Names differing only in case\n\n");
        s.push_str(
            "Windows and macOS treat these as one name. Copying this notebox \
             there merges the folders, or overwrites one file with the other.\n\n",
        );
        for c in &report.case_collisions {
            let folder = if c.folder.is_empty() {
                "notebox root".to_string()
            } else {
                code_span(&c.folder)
            };
            let _ = writeln!(s, "=== In {folder}\n");
            for n in &c.names {
                let _ = writeln!(s, "- {}", code_span(n));
            }
            s.push('\n');
        }
    }

    if !report.normalization_collisions.is_empty() {
        s.push_str("== Names differing only in accent encoding\n\n");
        s.push_str(
            "These look identical on screen but hold different bytes. Linux and \
             Windows keep them as separate files; macOS treats them as one, so \
             copying there merges or overwrites them.\n\n",
        );
        for c in &report.normalization_collisions {
            let folder = if c.folder.is_empty() {
                "notebox root".to_string()
            } else {
                code_span(&c.folder)
            };
            let _ = writeln!(s, "=== In {folder}\n");
            for n in &c.names {
                let _ = writeln!(s, "- {}", code_span(n));
            }
            s.push('\n');
        }
    }

    if !report.duplicate_note_names.is_empty() {
        s.push_str("== Duplicate note names\n\n");
        s.push_str(
            "Wikilinks resolve by note name across the whole notebox, ignoring \
             folders, so a link to one of these names is ambiguous.\n\n",
        );
        for d in &report.duplicate_note_names {
            // Plain text, not a `#wikilink`: every note in this group shares the
            // name, so a wikilink here would resolve to whichever has the
            // shortest path and quietly misrepresent the other rows. The dialog
            // is where you click through to a specific one.
            let _ = writeln!(s, "=== {}\n", d.name);
            for p in &d.paths {
                let _ = writeln!(s, "- {}", code_span(&p.rel));
            }
            s.push('\n');
        }
    }

    if !report.reserved_names.is_empty() {
        s.push_str("== Windows reserved names\n\n");
        s.push_str("These names cannot be created on Windows at all.\n\n");
        for p in &report.reserved_names {
            let _ = writeln!(s, "- {}", code_span(p));
        }
        s.push('\n');
    }

    if !report.illegal_characters.is_empty() {
        s.push_str("== Characters Windows rejects\n\n");
        for i in &report.illegal_characters {
            let _ = writeln!(s, "- {} ({})", code_span(&i.path), code_span(&i.detail));
        }
        s.push('\n');
    }

    if !report.trailing_dots_or_spaces.is_empty() {
        s.push_str("== Trailing dots or spaces\n\n");
        s.push_str("Windows strips these at write time, collapsing the name.\n\n");
        for p in &report.trailing_dots_or_spaces {
            let _ = writeln!(s, "- {}", code_span(p));
        }
        s.push('\n');
    }

    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> FileTreeNode {
        FileTreeNode {
            name: name.to_string(),
            path: format!("/notebox/{name}"),
            is_dir: false,
            children: None,
            modified_time: 0,
            created_time: 0,
            zid: None,
        }
    }

    fn dir(name: &str, children: Vec<FileTreeNode>) -> FileTreeNode {
        FileTreeNode {
            name: name.to_string(),
            path: format!("/notebox/{name}"),
            is_dir: true,
            children: Some(children),
            modified_time: 0,
            created_time: 0,
            zid: None,
        }
    }

    /// Run the scan over a synthetic tree through the same post-pass
    /// `collect_name_audit` uses, so tests see exactly the finished report the
    /// frontend would receive, ordering included.
    fn scan(tree: &[FileTreeNode]) -> NameAuditReport {
        let mut report = NameAuditReport::default();
        let mut names: HashMap<String, Vec<String>> = HashMap::new();
        scan_level(tree, "", &mut report, &mut names);
        finalize(&mut report, names, Path::new("/notebox"));
        report
    }

    #[test]
    fn flags_case_only_collisions_among_siblings() {
        let r = scan(&[dir("Dogs", vec![]), dir("dogs", vec![]), file("cats.typ")]);
        assert_eq!(r.case_collisions.len(), 1);
        assert_eq!(r.case_collisions[0].folder, "");
        assert_eq!(r.case_collisions[0].names, vec!["dogs", "Dogs"]);
    }

    #[test]
    fn ignores_case_variants_in_different_folders() {
        // `Dogs/` and `archive/dogs/` have different parents, so Windows can
        // represent both. Not a collision.
        let r = scan(&[dir("Dogs", vec![]), dir("archive", vec![dir("dogs", vec![])])]);
        assert!(r.case_collisions.is_empty());
    }

    #[test]
    fn reports_the_folder_a_nested_collision_lives_in() {
        let r = scan(&[dir(
            "Projects",
            vec![file("Notes.typ"), file("notes.typ")],
        )]);
        assert_eq!(r.case_collisions.len(), 1);
        assert_eq!(r.case_collisions[0].folder, "Projects");
    }

    #[test]
    fn flags_duplicate_note_names_across_folders() {
        let r = scan(&[
            dir("Projects", vec![file("Ideas.typ")]),
            dir("Archive", vec![file("Ideas.typ")]),
        ]);
        assert_eq!(r.duplicate_note_names.len(), 1);
        assert_eq!(r.duplicate_note_names[0].name, "Ideas");
        let rels: Vec<&str> = r.duplicate_note_names[0]
            .paths
            .iter()
            .map(|p| p.rel.as_str())
            .collect();
        assert_eq!(rels, vec!["Archive/Ideas.typ", "Projects/Ideas.typ"]);
        // The absolute form is what the dialog opens a tab with.
        assert_eq!(
            r.duplicate_note_names[0].paths[0].abs,
            "/notebox/Archive/Ideas.typ"
        );
    }

    #[test]
    fn duplicate_note_names_are_case_insensitive_like_link_resolution() {
        let r = scan(&[
            dir("a", vec![file("Ideas.typ")]),
            dir("b", vec![file("ideas.typ")]),
        ]);
        assert_eq!(r.duplicate_note_names.len(), 1);
    }

    #[test]
    fn non_typ_files_never_count_as_duplicate_note_names() {
        // Two attachments sharing a name in different folders are fine —
        // wikilinks don't resolve to them.
        let r = scan(&[
            dir("a", vec![file("photo.png")]),
            dir("b", vec![file("photo.png")]),
        ]);
        assert!(r.duplicate_note_names.is_empty());
    }

    #[test]
    fn flags_windows_reserved_names_with_and_without_extension() {
        let r = scan(&[file("CON.typ"), file("aux"), file("console.typ")]);
        assert_eq!(r.reserved_names, vec!["aux", "CON.typ"]);
    }

    #[test]
    fn flags_characters_windows_rejects() {
        let r = scan(&[file("Chapter 1: Intro.typ"), file("What?.typ"), file("fine.typ")]);
        let paths: Vec<&str> = r.illegal_characters.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(paths, vec!["Chapter 1: Intro.typ", "What?.typ"]);
        assert_eq!(r.illegal_characters[0].detail, ":");
    }

    #[test]
    fn lists_each_offending_character_once() {
        let r = scan(&[file("a:b:c|d.typ")]);
        assert_eq!(r.illegal_characters[0].detail, ": |");
    }

    #[test]
    fn flags_trailing_dots_and_spaces() {
        let r = scan(&[file("notes .typ"), file("draft."), file("ok.typ")]);
        assert_eq!(r.trailing_dots_or_spaces, vec!["draft."]);
    }

    #[test]
    fn counts_every_entry_including_folders() {
        let r = scan(&[dir("a", vec![file("one.typ"), file("two.typ")]), file("three.typ")]);
        assert_eq!(r.total_scanned, 4);
    }

    #[test]
    fn a_clean_notebox_reports_nothing() {
        let r = scan(&[
            dir("Projects", vec![file("Ideas.typ")]),
            dir("Archive", vec![file("Older.typ")]),
            file("Index.typ"),
        ]);
        assert!(!r.has_findings());
    }

    /// `café` with a precomposed `é` (U+00E9).
    const CAFE_NFC: &str = "caf\u{e9}.typ";
    /// `café` with `e` + combining acute (U+0065 U+0301) — same on screen,
    /// different bytes, and the same file on macOS.
    const CAFE_NFD: &str = "cafe\u{301}.typ";

    #[test]
    fn flags_accent_encoding_collisions() {
        let r = scan(&[file(CAFE_NFC), file(CAFE_NFD)]);
        assert_eq!(r.normalization_collisions.len(), 1);
        assert_eq!(r.normalization_collisions[0].names.len(), 2);
        // Not a case collision — the two names have identical casing.
        assert!(r.case_collisions.is_empty());
    }

    #[test]
    fn identical_accent_encoding_is_not_a_collision() {
        let r = scan(&[file(CAFE_NFC), file("the\u{e9}.typ")]);
        assert!(r.normalization_collisions.is_empty());
    }

    #[test]
    fn a_plain_case_collision_is_not_reported_twice() {
        // `Notes.typ` / `notes.typ` fold together on case alone, so the
        // normalization section must stay quiet about them.
        let r = scan(&[file("Notes.typ"), file("notes.typ")]);
        assert_eq!(r.case_collisions.len(), 1);
        assert!(r.normalization_collisions.is_empty());
    }

    #[test]
    fn case_plus_accent_difference_is_reported_as_normalization() {
        // `Café.typ` (NFC) and `café.typ` (NFD) survive as separate files on
        // both Linux and Windows — Windows folds case but not accents — and
        // merge only on macOS. So it belongs in the normalization group.
        let r = scan(&[file("Caf\u{e9}.typ"), file(CAFE_NFD)]);
        assert!(r.case_collisions.is_empty());
        assert_eq!(r.normalization_collisions.len(), 1);
    }

    #[test]
    fn accent_collisions_are_scoped_to_one_folder() {
        let r = scan(&[
            dir("a", vec![file(CAFE_NFC)]),
            dir("b", vec![file(CAFE_NFD)]),
        ]);
        assert!(r.normalization_collisions.is_empty());
        // They do still share a note name, which is a separate finding.
        assert_eq!(r.duplicate_note_names.len(), 1);
    }

    #[test]
    fn handles_multibyte_names() {
        let r = scan(&[dir("Étude", vec![]), dir("étude", vec![])]);
        assert_eq!(r.case_collisions.len(), 1);
        assert_eq!(r.case_collisions[0].names, vec!["étude", "Étude"]);
    }
}
