//! Bundled InkyCap user manual.
//!
//! The English and translated user manuals live in the repository under
//! `documentation/manual/<notebox>/` and are embedded into the binary at
//! compile time via [`include_dir!`]. The documentation window opens a writable
//! working copy under the per-platform config dir; this module seeds and
//! refreshes that copy from the embedded source.
//!
//! Why embed rather than ship as Tauri `bundle.resources`: embedding needs no
//! runtime resource-path resolution (which CLAUDE.md flags as a recurring
//! cross-platform path-handling hazard), keeps the docs version atomic with the
//! app binary, and matches the existing `include_bytes!` embedding of the
//! notebox package in [`crate::notebox_package`].
//!
//! The working copy is read-only/ephemeral at the app level — in-app edits
//! never reach disk (see `NoteboxSession::is_documentation`) — so re-seeding
//! never destroys user data. Re-seeding is gated by a content fingerprint
//! stored at `.inkycap/.docs-version`: any change to the embedded manual,
//! including a developer rebuild, produces a new fingerprint and refreshes the
//! working copy (dropping notes that were renamed or removed upstream).

use std::path::Path;

use include_dir::{include_dir, Dir, File};
use sha2::{Digest, Sha256};

/// English manual — the base manual and the universal fallback.
static MANUAL_EN: Dir<'static> =
    include_dir!("$CARGO_MANIFEST_DIR/../documentation/manual/InkyCap-Documentation");

/// French (Québec) manual.
static MANUAL_FR_CA: Dir<'static> =
    include_dir!("$CARGO_MANIFEST_DIR/../documentation/manual/InkyCap-Documentation-fr-CA");

/// File under the working copy's `.inkycap/` recording the fingerprint of the
/// embedded manual it was last seeded from.
const VERSION_MARKER: &str = ".docs-version";

/// Resolve the embedded manual for a documentation-notebox folder name (the
/// names produced by `docs_notebox_dir_name`). `None` for any name we don't
/// bundle a manual for — callers fall back to English by passing the English
/// folder name.
fn embedded_manual(dir_name: &str) -> Option<&'static Dir<'static>> {
    match dir_name {
        "InkyCap-Documentation" => Some(&MANUAL_EN),
        "InkyCap-Documentation-fr-CA" => Some(&MANUAL_FR_CA),
        _ => None,
    }
}

/// Whether a documentation manual is bundled for the given folder name.
pub fn has_embedded_manual(dir_name: &str) -> bool {
    embedded_manual(dir_name).is_some()
}

/// Seed or refresh the documentation working copy at `dest_root` from the
/// embedded manual identified by `dir_name`.
///
/// No-op (returns `Ok(false)`) when the working copy already matches the
/// embedded fingerprint, or when no manual is bundled for `dir_name`. When the
/// content differs, everything in `dest_root` except `.inkycap/` is removed and
/// the embedded tree is written fresh; returns `Ok(true)`.
pub fn seed_if_stale(dir_name: &str, dest_root: &Path) -> std::io::Result<bool> {
    let Some(manual) = embedded_manual(dir_name) else {
        return Ok(false);
    };

    let fingerprint = manual_fingerprint(manual);
    let marker_path = dest_root.join(".inkycap").join(VERSION_MARKER);

    if std::fs::read_to_string(&marker_path).ok().as_deref() == Some(fingerprint.as_str()) {
        return Ok(false);
    }

    // Replace the managed content. `.inkycap/` (the notebox package scaffold and
    // per-machine state) is preserved; everything else is removed first so that
    // notes renamed or deleted upstream don't linger. Safe because the working
    // copy is ephemeral — in-app edits never persist.
    clear_except_inkycap(dest_root)?;
    std::fs::create_dir_all(dest_root)?;
    extract_manual(manual, dest_root)?;

    std::fs::create_dir_all(dest_root.join(".inkycap"))?;
    std::fs::write(&marker_path, fingerprint)?;
    Ok(true)
}

/// Remove every top-level entry in `root` except the `.inkycap/` working
/// directory. A missing `root` is treated as already clear.
fn clear_except_inkycap(root: &Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name() == ".inkycap" {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Content fingerprint over the embedded manual: SHA-256 of every file's path
/// and bytes, in a stable path-sorted order. Changes whenever any file is
/// added, removed, renamed, or edited.
fn manual_fingerprint(dir: &Dir<'static>) -> String {
    let mut files: Vec<&File> = Vec::new();
    collect_files(dir, &mut files);
    files.sort_by(|a, b| a.path().cmp(b.path()));

    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.path().to_string_lossy().as_bytes());
        hasher.update([0u8]);
        hasher.update(file.contents());
        hasher.update([0u8]);
    }
    format!("{:x}", hasher.finalize())
}

/// Name of the per-notebox working folder that the app creates when the manual
/// source folder is opened as an ordinary notebox (for editing or book export).
/// It holds caches and per-machine state, so it is never part of the manual:
/// the fingerprint ignores it and it is never copied to the working copy.
const WORKING_DIR_NAME: &str = ".inkycap";

/// Whether an embedded directory is a working folder to leave out.
fn is_working_dir(dir: &Dir<'_>) -> bool {
    dir.path().file_name().and_then(|n| n.to_str()) == Some(WORKING_DIR_NAME)
}

/// Write every embedded file under `dest_root`, skipping any `.inkycap/`
/// folder captured from the source tree.
fn extract_manual(dir: &Dir<'static>, dest_root: &Path) -> std::io::Result<()> {
    for file in dir.files() {
        let target = dest_root.join(file.path());
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(target, file.contents())?;
    }
    for sub in dir.dirs() {
        if is_working_dir(sub) {
            continue;
        }
        extract_manual(sub, dest_root)?;
    }
    Ok(())
}

/// Collect every file in `dir`, recursing into subdirectories but skipping
/// any `.inkycap/` working folder.
fn collect_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<&'a File<'a>>) {
    for file in dir.files() {
        out.push(file);
    }
    for sub in dir.dirs() {
        if is_working_dir(sub) {
            continue;
        }
        collect_files(sub, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_manuals_are_embedded_and_non_empty() {
        assert!(has_embedded_manual("InkyCap-Documentation"));
        assert!(has_embedded_manual("InkyCap-Documentation-fr-CA"));
        assert!(!has_embedded_manual("InkyCap-Documentation-xx-YY"));

        let mut en = Vec::new();
        collect_files(&MANUAL_EN, &mut en);
        assert!(en.len() > 20, "EN manual should hold the full note set");

        let mut fr = Vec::new();
        collect_files(&MANUAL_FR_CA, &mut fr);
        assert!(fr.len() > 20, "FR manual should hold the full note set");
    }

    #[test]
    fn seed_extracts_then_skips_when_current() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("InkyCap-Documentation");

        // First open: seeds, reports a write.
        let seeded = seed_if_stale("InkyCap-Documentation", &root).unwrap();
        assert!(seeded);
        assert!(root.join("0 - Index.typ").exists());
        assert!(root.join("Assets").is_dir());
        assert!(root.join(".inkycap").join(VERSION_MARKER).exists());

        // Second open with unchanged content: no-op.
        let seeded_again = seed_if_stale("InkyCap-Documentation", &root).unwrap();
        assert!(!seeded_again);
    }

    #[test]
    fn embedded_working_folder_is_never_seeded() {
        // The source tree may carry a `.inkycap/` folder from being opened as a
        // notebox; neither the fingerprint nor the seeded copy may include it.
        let mut files = Vec::new();
        collect_files(&MANUAL_EN, &mut files);
        assert!(files
            .iter()
            .all(|f| !f.path().starts_with(WORKING_DIR_NAME)));

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("InkyCap-Documentation");
        seed_if_stale("InkyCap-Documentation", &root).unwrap();
        assert!(!root.join(WORKING_DIR_NAME).join("notebox.typ").exists());
    }

    #[test]
    fn seed_preserves_inkycap_and_drops_stale_notes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("InkyCap-Documentation");

        seed_if_stale("InkyCap-Documentation", &root).unwrap();

        // Simulate per-machine state in .inkycap and a stale upstream note.
        std::fs::write(root.join(".inkycap").join("local.json"), b"{}").unwrap();
        std::fs::write(root.join("stale-note.typ"), b"old").unwrap();
        // Force a re-seed by clobbering the fingerprint marker.
        std::fs::write(root.join(".inkycap").join(VERSION_MARKER), b"stale").unwrap();

        let reseeded = seed_if_stale("InkyCap-Documentation", &root).unwrap();
        assert!(reseeded);
        assert!(
            !root.join("stale-note.typ").exists(),
            "re-seed drops notes no longer in the embedded manual"
        );
        assert!(
            root.join(".inkycap").join("local.json").exists(),
            "re-seed preserves per-machine .inkycap state"
        );
    }

    #[test]
    fn unknown_locale_folder_is_not_seeded() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("InkyCap-Documentation-xx-YY");
        let seeded = seed_if_stale("InkyCap-Documentation-xx-YY", &root).unwrap();
        assert!(!seeded);
    }
}
