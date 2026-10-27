//! Offline package handoff: collaborate without a git server.
//!
//! [`export`] writes a notebox's `.git` folder into one zip (optionally
//! AES-256-encrypted); [`extract_to_temp`] unpacks a received package into a
//! temporary repository that `git2` can clone or fetch from by path. The
//! package carries the full history, including the merge base, so import uses
//! the same 3-way merge as a server Sync (`run_sync` in
//! [`crate::commands::git`]).
//!
//! **Only `.git` is packaged.** The working files are rebuilt on import, and
//! per-machine files the collaborative `.gitignore` excludes
//! (`.inkycap/incoming`, `.inkycap/local.json`) are never committed. Notes,
//! attachments, the `inkycap-notebox` library and `.inkycap/settings.json` are
//! committed, so they come along.

use std::path::{Component, Path, PathBuf};

use crate::errors::{InkyCapError, Result};
use crate::storage::zip_archive::{self, ZipBuilder};

/// Folder the repository is stored under in a package zip; any other entry is
/// rejected on import.
const GIT_PREFIX: &str = ".git/";

/// What an [`export`] wrote, for the success report.
#[derive(Debug, Clone, Default)]
pub struct PackageSummary {
    pub file_count: u64,
    pub uncompressed_bytes: u64,
}

/// Zip the notebox's `.git` folder into `dest`, AES-256-encrypted when
/// `password` is `Some`. `root` must be a git repository. The caller commits
/// pending edits first; this writes what `.git` holds.
pub fn export(root: &Path, dest: &Path, password: Option<&str>) -> Result<PackageSummary> {
    let git_dir = root.join(".git");
    if !git_dir.is_dir() {
        return Err(InkyCapError::BadRequest(
            "notebox is not a git repository".into(),
        ));
    }
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let mut builder = ZipBuilder::create(dest, password.map(str::to_string))?;
    let mut summary = PackageSummary::default();
    for entry in walkdir::WalkDir::new(&git_dir).follow_links(true) {
        let entry = entry.map_err(|e| InkyCapError::ExportFailed(format!("walking .git: {e}")))?;
        let path = entry.path();
        let rel = path.strip_prefix(&git_dir).map_err(|e| {
            InkyCapError::ExportFailed(format!("relativising {}: {e}", path.display()))
        })?;
        // The walk's first item is `.git` itself (empty rel) — skip it.
        if rel.as_os_str().is_empty() {
            continue;
        }
        let interior = format!("{GIT_PREFIX}{}", interior_path(rel));
        let ft = entry.file_type();
        if ft.is_dir() {
            // Record empty folders only (others are implied by their files);
            // git keeps a few (e.g. `refs/tags`).
            let empty = std::fs::read_dir(path)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false);
            if empty {
                builder.add_directory(&interior)?;
            }
        } else if ft.is_file() {
            let n = builder.add_file(&interior, path, None)?;
            summary.file_count += 1;
            summary.uncompressed_bytes += n;
        }
        // `.git` has no sockets/fifos; anything else is ignored.
    }
    builder.finish()?;
    Ok(summary)
}

/// Join a notebox-relative path's components with forward slashes — the zip
/// interior-path convention, independent of the OS separator.
fn interior_path(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

/// Extract a received package into a new temporary folder holding a complete
/// `.git` repository, which `git2` can clone or fetch from via
/// [`tempfile::TempDir::path`]. Keep the `TempDir` for the import; it is
/// deleted on drop.
///
/// Guards against a malicious package: every entry must be under `.git/` and
/// land inside the folder (no `..` or absolute parts), and entries are always
/// written as regular files and folders, never symlinks.
pub fn extract_to_temp(archive: &Path, password: Option<&str>) -> Result<tempfile::TempDir> {
    let entries = zip_archive::list_entries(archive)?;
    let staging = tempfile::tempdir()?;
    let root = staging.path();

    let mut zip = zip_archive::open(archive)?;
    let mut budget = zip_archive::ExtractBudget::for_archive(archive)?;
    let mut wrote_git = false;
    for info in &entries {
        let name = info.name.as_str();
        // The bare repo-root directory entry; its children create it implicitly.
        if name == ".git" || name == GIT_PREFIX {
            continue;
        }
        if !name.starts_with(GIT_PREFIX) {
            return Err(InkyCapError::BadRequest(format!(
                "package entry outside .git/: {name}"
            )));
        }
        let dest = safe_join(root, name)?;

        if info.is_dir {
            std::fs::create_dir_all(&dest)?;
            wrote_git = true;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(&dest)?;
        zip_archive::read_entry_to_writer(&mut zip, name, password, &mut budget, &mut f)?;
        wrote_git = true;
    }

    if !wrote_git {
        return Err(InkyCapError::BadRequest(
            "package contains no .git repository".into(),
        ));
    }
    Ok(staging)
}

/// Join a zip path (with `/`) onto `root`, rejecting empty, `.`, `..` and other
/// non-plain parts (absolute paths, Windows prefixes), so the result stays
/// inside `root`.
fn safe_join(root: &Path, interior: &str) -> Result<PathBuf> {
    let mut out = root.to_path_buf();
    for part in interior.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(InkyCapError::BadRequest(format!(
                "package entry escapes staging dir: {interior}"
            )));
        }
        let comp = Path::new(part);
        let mut comps = comp.components();
        match (comps.next(), comps.next()) {
            (Some(Component::Normal(_)), None) => out.push(part),
            _ => {
                return Err(InkyCapError::BadRequest(format!(
                    "package entry has an unsafe component: {interior}"
                )))
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::backend::GitBackend;

    /// Init a repo at `dir`, commit `files`, and return the head OID.
    fn seed_repo(dir: &Path, files: &[(&str, &str)]) -> git2::Oid {
        let backend = GitBackend::open_or_init(dir).unwrap();
        backend.ensure_initial_branch("main").unwrap();
        for (name, content) in files {
            std::fs::write(dir.join(name), content).unwrap();
        }
        backend.stage_all().unwrap();
        let sig = git2::Signature::now("Packer", "pack@example.com").unwrap();
        backend.commit("seed", &sig).unwrap()
    }

    /// Export → extract reproduces the exact repository: the extracted staging
    /// dir opens as a git repo with the same HEAD and the same blob content.
    #[test]
    fn export_then_extract_round_trips_repo() {
        let src = tempfile::tempdir().unwrap();
        let head = seed_repo(src.path(), &[("note.typ", "hello\n")]);

        let pkg = tempfile::tempdir().unwrap();
        let archive = pkg.path().join("notebox.inkypkg");
        let summary = export(src.path(), &archive, None).unwrap();
        assert!(
            summary.file_count > 0,
            "wrote at least HEAD + a loose object"
        );

        let staging = extract_to_temp(&archive, None).unwrap();
        let restored = GitBackend::open(staging.path()).unwrap();
        let (_, restored_head) = restored.current_head().unwrap().unwrap();
        assert_eq!(restored_head, head, "HEAD commit survives the round trip");
        let blob = restored
            .read_blob_at(restored_head, Path::new("note.typ"))
            .unwrap()
            .unwrap();
        assert_eq!(blob, b"hello\n");
    }

    /// An AES-encrypted package decrypts with the right password and fails with
    /// the wrong one.
    #[test]
    fn encrypted_round_trip_and_wrong_password_fails() {
        let src = tempfile::tempdir().unwrap();
        let head = seed_repo(src.path(), &[("n.typ", "secret\n")]);

        let pkg = tempfile::tempdir().unwrap();
        let archive = pkg.path().join("enc.inkypkg");
        export(src.path(), &archive, Some("hunter2")).unwrap();

        assert!(
            extract_to_temp(&archive, Some("wrong")).is_err(),
            "wrong password is rejected"
        );

        let staging = extract_to_temp(&archive, Some("hunter2")).unwrap();
        let restored = GitBackend::open(staging.path()).unwrap();
        assert_eq!(restored.current_head().unwrap().unwrap().1, head);
    }

    /// A package whose entries are not under `.git/` is rejected (a foreign or
    /// tampered archive).
    #[test]
    fn extract_rejects_entry_outside_git() {
        let pkg = tempfile::tempdir().unwrap();
        let archive = pkg.path().join("bad.inkypkg");
        let mut b = ZipBuilder::create(&archive, None).unwrap();
        b.add_bytes("notes/evil.typ", b"nope").unwrap();
        b.finish().unwrap();

        assert!(extract_to_temp(&archive, None).is_err());
    }

    /// A traversal component in an interior path is rejected.
    #[test]
    fn extract_rejects_traversal() {
        let pkg = tempfile::tempdir().unwrap();
        let archive = pkg.path().join("evil.inkypkg");
        let mut b = ZipBuilder::create(&archive, None).unwrap();
        // Starts with `.git/` (passes the prefix gate) but escapes via `..`.
        b.add_bytes(".git/../escaped.txt", b"nope").unwrap();
        b.finish().unwrap();

        assert!(extract_to_temp(&archive, None).is_err());
    }
}
