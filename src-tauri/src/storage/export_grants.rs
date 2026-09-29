//! Folders outside the notebox that the user has chosen, in a save or folder
//! dialog run by the backend, as places InkyCap may write exports.
//!
//! Export commands receive their destination from the webview. Checking it
//! against this list means that even a compromised webview can only write
//! where the user already pointed a native dialog, never to an arbitrary path
//! such as a startup folder or shell profile.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The per-window list of chosen export folders. Folders are stored in
/// canonical form (symlinks resolved), and a folder allows everything inside
/// it, because batch, site, figure and Pandoc exports write several files
/// beside or below the chosen location.
#[derive(Debug, Default)]
pub struct ExportGrants {
    folders: Mutex<Vec<PathBuf>>,
}

impl ExportGrants {
    /// Allow writing inside `folder` for the rest of this window's session.
    pub fn grant(&self, folder: &Path) {
        let Ok(canonical) = crate::storage::path::canonicalize_root(folder) else {
            return;
        };
        let mut folders = self.folders.lock().unwrap_or_else(|e| e.into_inner());
        if !folders.contains(&canonical) {
            folders.push(canonical);
        }
    }

    /// Whether `destination` (a file or folder, which need not exist yet) lies
    /// inside a granted folder. Resolved through its nearest existing
    /// ancestor, so symlinks can't lead a write out of a granted folder. Any
    /// `..` is refused outright: below a folder that doesn't exist yet it
    /// can't be resolved, and creating that folder would let it climb out.
    pub fn allows(&self, destination: &Path) -> bool {
        if destination
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return false;
        }
        let Some(existing) = destination.ancestors().find(|p| p.exists()) else {
            return false;
        };
        let Ok(canonical) = crate::storage::path::canonicalize_root(existing) else {
            return false;
        };
        let folders = self.folders.lock().unwrap_or_else(|e| e.into_inner());
        folders.iter().any(|f| canonical.starts_with(f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_inside_granted_folders() {
        let dir = tempfile::tempdir().unwrap();
        let granted = dir.path().join("exports");
        let other = dir.path().join("elsewhere");
        std::fs::create_dir_all(&granted).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let grants = ExportGrants::default();
        assert!(!grants.allows(&granted.join("note.pdf")));

        grants.grant(&granted);
        assert!(grants.allows(&granted.join("note.pdf")));
        assert!(grants.allows(&granted.join("figures/fig-1.png")));
        assert!(!grants.allows(&other.join("note.pdf")));
        assert!(!grants.allows(&dir.path().join("note.pdf")));
    }

    #[test]
    fn parent_traversal_does_not_escape() {
        let dir = tempfile::tempdir().unwrap();
        let granted = dir.path().join("exports");
        std::fs::create_dir_all(&granted).unwrap();
        let grants = ExportGrants::default();
        grants.grant(&granted);
        assert!(!grants.allows(&granted.join("..").join("escape.pdf")));
        assert!(!grants.allows(&granted.join("new/../../escape.pdf")));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_a_granted_folder_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let granted = dir.path().join("exports");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&granted).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, granted.join("link")).unwrap();
        let grants = ExportGrants::default();
        grants.grant(&granted);
        assert!(!grants.allows(&granted.join("link").join("x.pdf")));
    }
}
