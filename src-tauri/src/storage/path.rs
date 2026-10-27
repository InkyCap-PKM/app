//! Path validation for the notebox. Every path from the frontend (command
//! arguments, drops, watcher events) is checked against the notebox root here
//! before any I/O. It guards against:
//!
//! 1. **Relative traversal** (`../../etc/passwd`): canonicalizing removes `..`,
//!    and the result must start with the canonical root.
//! 2. **Absolute paths** outside the notebox: joined, canonicalized and checked
//!    the same way.
//! 3. **Symlink escapes**: `std::fs::canonicalize` follows symlinks, so a link
//!    to `/tmp` resolves to `/tmp/...` and fails.
//!
//! For paths that don't exist yet (a file about to be created or renamed), the
//! nearest existing ancestor is canonicalized and the rest appended; the rest
//! may not contain `..`.

use std::path::{Component, Path, PathBuf};

use crate::errors::{InkyCapError, Result};

/// A `Path` as a string for the frontend, the same on every OS: without the
/// Windows `\\?\` prefix that `std::fs::canonicalize` adds, and with forward
/// slashes, so `startsWith` and `split("/")` work alike everywhere.
///
/// Every path sent to the frontend (`NoteboxInfo`, `FileTreeNode.path`, watcher
/// events, graph node IDs) goes through this, never
/// `Path::display().to_string()` (see CLAUDE.md). `PathBuf::from` accepts
/// forward slashes on Windows, so paths coming back still work.
pub fn to_frontend_string(path: &Path) -> String {
    let s = path.display().to_string(); // path-stringification-ok: this *is* the canonical-shape helper

    let trimmed = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        // \\?\UNC\server\share\... → \\server\share\...
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    };
    trimmed.replace('\\', "/")
}

/// Canonicalize the notebox root, once. Fails if it doesn't exist or can't be
/// resolved.
///
/// On Windows the `\\?\` prefix is removed: it doesn't affect file access but
/// makes `Path` comparisons differ from the same path without it. Without it,
/// every path derived from the root has one form, so the indexes and
/// `starts_with` checks agree.
pub fn canonicalize_root(root: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(root)
        .map(strip_verbatim_prefix)
        .map_err(|e| {
            InkyCapError::InvalidPath(format!(
                "cannot canonicalize notebox root {}: {}",
                root.display(),
                e
            ))
        })
}

/// Remove the Windows `\\?\` prefix, leaving a normal drive or UNC path. No-op
/// elsewhere.
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Quick check of a path argument from the frontend: rejects null bytes and `..`
/// components. Absolute and relative paths are accepted (most frontend paths are
/// absolute); `LocalNoteboxStorage::resolve_path` does the full containment check.
pub fn sanitize_notebox_arg(path: &str) -> Result<PathBuf> {
    if path.contains('\0') {
        return Err(InkyCapError::InvalidPath(
            "path contains null byte".to_string(),
        ));
    }
    let p = Path::new(path);
    for component in p.components() {
        if matches!(component, Component::ParentDir) {
            return Err(InkyCapError::InvalidPath(format!(
                "path contains traversal: {path}"
            )));
        }
    }
    Ok(PathBuf::from(path))
}

/// Check that `path` (absolute, or relative to the root) resolves inside
/// `canonical_root`, and return the canonical path. `canonical_root` must
/// already be canonical (as stored by [`LocalNoteboxStorage`] from
/// [`canonicalize_root`]); a raw root containing a symlink would break the
/// comparison.
pub fn validate_notebox_path(canonical_root: &Path, path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_root.join(path)
    };

    let resolved = canonicalize_with_nonexistent_tail(&joined)?;

    if !resolved.starts_with(canonical_root) {
        return Err(InkyCapError::InvalidPath(format!(
            "path escapes notebox root: {}",
            path.display()
        )));
    }

    Ok(resolved)
}

/// Canonicalize a path that may not exist yet: canonicalize the nearest
/// existing ancestor and append the rest. The appended part may only contain
/// plain names; `..` or `.` there could escape the notebox from an ancestor
/// inside it.
fn canonicalize_with_nonexistent_tail(path: &Path) -> Result<PathBuf> {
    // Fast path: the target already exists.
    if let Ok(c) = std::fs::canonicalize(path) {
        return Ok(strip_verbatim_prefix(c));
    }

    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut ancestor: &Path = path;
    let canon_ancestor = loop {
        // Try to canonicalize the current ancestor.
        if let Ok(c) = std::fs::canonicalize(ancestor) {
            break strip_verbatim_prefix(c);
        }

        // Move one segment up.
        let file_name = ancestor.file_name().ok_or_else(|| {
            InkyCapError::InvalidPath(format!("cannot resolve path: {}", path.display()))
        })?;
        tail.push(file_name);

        ancestor = ancestor.parent().ok_or_else(|| {
            InkyCapError::InvalidPath(format!("cannot resolve path: {}", path.display()))
        })?;

        if ancestor.as_os_str().is_empty() {
            return Err(InkyCapError::InvalidPath(format!(
                "cannot resolve path: {}",
                path.display()
            )));
        }
    };

    // Reject `..` and `.` in the appended part (e.g.
    // `<ancestor>/a/../../../etc/passwd`).
    let mut resolved = canon_ancestor;
    for segment in tail.iter().rev() {
        let seg_path = Path::new(segment);
        for component in seg_path.components() {
            match component {
                Component::Normal(os) => resolved.push(os),
                _ => {
                    return Err(InkyCapError::InvalidPath(format!(
                        "path contains disallowed component: {}",
                        path.display()
                    )));
                }
            }
        }
    }

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn accepts_relative_inside_root() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/note.md"), "x").unwrap();

        let ok = validate_notebox_path(&root, Path::new("sub/note.md")).unwrap();
        assert!(ok.starts_with(&root));
        assert!(ok.ends_with("note.md"));
    }

    #[test]
    fn accepts_absolute_inside_root() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        fs::write(root.join("note.md"), "x").unwrap();

        let abs = root.join("note.md");
        let ok = validate_notebox_path(&root, &abs).unwrap();
        assert_eq!(ok, abs);
    }

    #[test]
    fn rejects_parent_traversal() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        let err = validate_notebox_path(&root, Path::new("../etc/passwd"));
        assert!(err.is_err(), "expected traversal to be rejected");
    }

    #[test]
    fn rejects_absolute_outside_root() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        let err = validate_notebox_path(&root, Path::new("/etc/passwd"));
        assert!(err.is_err());
    }

    #[test]
    fn allows_nonexistent_file_for_create() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        // New file inside existing root — should validate even though it
        // doesn't exist yet.
        let ok = validate_notebox_path(&root, Path::new("new-note.md")).unwrap();
        assert!(ok.starts_with(&root));
    }

    #[test]
    fn rejects_traversal_in_nonexistent_tail() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        // Ancestor exists (root), tail contains `..` — must be rejected.
        let err = validate_notebox_path(&root, Path::new("a/../../escape.md"));
        assert!(err.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let tmp_notebox = tmpdir();
        let tmp_outside = tmpdir();
        let root = canonicalize_root(tmp_notebox.path()).unwrap();
        fs::write(tmp_outside.path().join("secret.md"), "secret").unwrap();

        // Symlink inside the notebox pointing outside.
        symlink(tmp_outside.path(), root.join("link")).unwrap();

        let err = validate_notebox_path(&root, Path::new("link/secret.md"));
        assert!(err.is_err(), "symlink escape must be rejected");
    }
}
