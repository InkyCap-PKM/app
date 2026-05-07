//! Vault-scoped path validation.
//!
//! Every path that enters the backend from the frontend — whether via an IPC
//! command argument, a clipboard drop, or a file-watcher event — must be
//! validated against the vault root before it is used for I/O. This module is
//! the single source of truth for that check.
//!
//! The validator defends against three classes of escape:
//!
//! 1. **Relative traversal** (`../../etc/passwd`): canonicalization collapses
//!    `..` components, and the result is then compared against the canonical
//!    vault root with `starts_with`.
//! 2. **Absolute paths** pointing outside the vault: treated the same as
//!    relative paths — join, canonicalize, verify containment.
//! 3. **Symlink escapes**: `std::fs::canonicalize` follows symlinks, so a
//!    symlink inside the vault that targets `/tmp` will canonicalize to
//!    `/tmp/...` and fail the containment check.
//!
//! For paths whose target does not yet exist (e.g. a file about to be created
//! or renamed into place), we walk up to the nearest existing ancestor,
//! canonicalize that, and then re-append the non-existent tail. The tail
//! components are validated to contain no `..`, so the rebuilt path cannot
//! escape.

use std::path::{Component, Path, PathBuf};

use crate::errors::{InkyCapError, Result};

/// Canonicalize the vault root once, up-front. Fails if the root does not
/// exist or cannot be resolved (e.g. permission denied).
pub fn canonicalize_root(root: &Path) -> Result<PathBuf> {
    std::fs::canonicalize(root).map_err(|e| {
        InkyCapError::InvalidPath(format!(
            "cannot canonicalize vault root {}: {}",
            root.display(),
            e
        ))
    })
}

/// Validate that `path` — absolute or relative — resolves to a location inside
/// `canonical_root`, and return the canonical resolved path.
///
/// `canonical_root` MUST already be canonicalized (typically via
/// [`canonicalize_root`] stored on [`LocalVaultStorage`]). Passing a raw root
/// would break the `starts_with` comparison when the root itself contains a
/// symlink.
///
/// The `path` argument may be relative (joined to root) or absolute (used as
/// given). Either way, the final resolved path must live under the root.
pub fn validate_vault_path(canonical_root: &Path, path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_root.join(path)
    };

    let resolved = canonicalize_with_nonexistent_tail(&joined)?;

    if !resolved.starts_with(canonical_root) {
        return Err(InkyCapError::InvalidPath(format!(
            "path escapes vault root: {}",
            path.display()
        )));
    }

    Ok(resolved)
}

/// Canonicalize a path whose target may not yet exist.
///
/// Walks upward until an existing ancestor is found, canonicalizes it, then
/// re-appends the non-existent tail. Tail components are restricted to plain
/// `Normal` components — `..` and `.` in the tail are rejected, otherwise a
/// create-new-file operation could escape the vault even though the ancestor
/// is safely inside it.
fn canonicalize_with_nonexistent_tail(path: &Path) -> Result<PathBuf> {
    // Fast path: the target already exists.
    if let Ok(c) = std::fs::canonicalize(path) {
        return Ok(c);
    }

    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut ancestor: &Path = path;
    let canon_ancestor = loop {
        // Try to canonicalize the current ancestor.
        if let Ok(c) = std::fs::canonicalize(ancestor) {
            break c;
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

    // Reject `..` / `.` in the non-existent tail so an attacker can't craft a
    // path like `<canon_ancestor>/a/../../../etc/passwd` where the tail cancels
    // out earlier components.
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

        let ok = validate_vault_path(&root, Path::new("sub/note.md")).unwrap();
        assert!(ok.starts_with(&root));
        assert!(ok.ends_with("note.md"));
    }

    #[test]
    fn accepts_absolute_inside_root() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        fs::write(root.join("note.md"), "x").unwrap();

        let abs = root.join("note.md");
        let ok = validate_vault_path(&root, &abs).unwrap();
        assert_eq!(ok, abs);
    }

    #[test]
    fn rejects_parent_traversal() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        let err = validate_vault_path(&root, Path::new("../etc/passwd"));
        assert!(err.is_err(), "expected traversal to be rejected");
    }

    #[test]
    fn rejects_absolute_outside_root() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        let err = validate_vault_path(&root, Path::new("/etc/passwd"));
        assert!(err.is_err());
    }

    #[test]
    fn allows_nonexistent_file_for_create() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        // New file inside existing root — should validate even though it
        // doesn't exist yet.
        let ok = validate_vault_path(&root, Path::new("new-note.md")).unwrap();
        assert!(ok.starts_with(&root));
    }

    #[test]
    fn rejects_traversal_in_nonexistent_tail() {
        let tmp = tmpdir();
        let root = canonicalize_root(tmp.path()).unwrap();
        // Ancestor exists (root), tail contains `..` — must be rejected.
        let err = validate_vault_path(&root, Path::new("a/../../escape.md"));
        assert!(err.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let tmp_vault = tmpdir();
        let tmp_outside = tmpdir();
        let root = canonicalize_root(tmp_vault.path()).unwrap();
        fs::write(tmp_outside.path().join("secret.md"), "secret").unwrap();

        // Symlink inside the vault pointing outside.
        symlink(tmp_outside.path(), root.join("link")).unwrap();

        let err = validate_vault_path(&root, Path::new("link/secret.md"));
        assert!(err.is_err(), "symlink escape must be rejected");
    }
}
