//! The bundled user manual.
//!
//! The manuals (English and translations) are in
//! `documentation/manual/<notebox>/` and embedded in the binary with
//! [`include_dir!`], which avoids resource-path lookup at runtime and keeps the
//! docs matched to the app version. The documentation window opens a working
//! copy in the config folder; this module creates and refreshes it.
//!
//! In-app edits to the working copy are never saved (see
//! `NoteboxSession::is_documentation`), so replacing it loses nothing. It is
//! refreshed when the fingerprint stored in `.inkycap/.docs-version` differs
//! from the embedded manual's, which also removes notes that were renamed or
//! deleted.

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

/// The embedded manual for a documentation folder name (from
/// `docs_notebox_dir_name`). `None` if no manual is bundled for it; callers
/// then pass the English name.
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

/// Create or refresh the working copy at `dest_root` from the manual for
/// `dir_name`.
///
/// `Ok(false)` when it already matches the embedded fingerprint, or no manual
/// is bundled for `dir_name`. Otherwise everything except `.inkycap/` is
/// removed, the manual is written, and `Ok(true)` is returned.
pub fn seed_if_stale(dir_name: &str, dest_root: &Path) -> std::io::Result<bool> {
    let Some(manual) = embedded_manual(dir_name) else {
        return Ok(false);
    };

    let fingerprint = manual_fingerprint(manual);
    let marker_path = dest_root.join(".inkycap").join(VERSION_MARKER);

    if std::fs::read_to_string(&marker_path).ok().as_deref() == Some(fingerprint.as_str()) {
        return Ok(false);
    }

    // Keep `.inkycap/` (the package scaffold and per-machine state); remove
    // everything else so renamed or deleted notes don't linger.
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

/// Fingerprint of the embedded manual: SHA-256 of every file's path and bytes,
/// sorted by path.
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

/// Working folder the app creates when the manual's source folder is opened as
/// a notebox (to edit it or export a book). It holds caches and per-machine
/// state, so the fingerprint ignores it and it isn't copied.
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
