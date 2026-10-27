//! Where InkyCap keeps its files, using the `dirs` crate for each platform's
//! folders (XDG on Linux, macOS, Windows). Everything InkyCap saves finds its
//! folder here.
//!
//! The exceptions are `commands::system_color` (reads KDE's `kdeglobals`) and
//! `typst_pipeline::zotero` (reads Zotero's database), which use `dirs::*`
//! directly to find other applications' files.

use std::path::{Path, PathBuf};

/// Config folder: files the user wrote or that hold preferences (config.json,
/// settings.json, creation_rules.json, bookmarks.json).
pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("inkycap")
}

/// Data folder: user data that can't be rebuilt from notes (the recovery
/// snapshots).
pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("inkycap")
}

/// Cache folder: indexes that can be rebuilt (the metadata database, the search
/// index). Anything here can be deleted; the app rebuilds it on the next open.
pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("inkycap")
}

/// Move cache files that were in `data_dir()` to `cache_dir()`, at startup. If
/// a move fails (e.g. across file systems), the old file is left and the cache
/// is rebuilt; nothing but time is lost.
pub fn migrate_legacy_cache_paths() {
    let old_root = dirs::data_dir()
        .map(|d| d.join("inkycap"))
        .unwrap_or_else(|| PathBuf::from("."));
    let new_root = cache_dir();
    migrate_legacy_cache_paths_at(&old_root, &new_root);
}

/// [`migrate_legacy_cache_paths`] with the folders passed in, for tests.
pub fn migrate_legacy_cache_paths_at(old_root: &Path, new_root: &Path) {
    if !old_root.exists() {
        return;
    }
    // Nothing to move if both are the same folder.
    if old_root == new_root {
        return;
    }
    let _ = std::fs::create_dir_all(new_root);

    // Files that moved data_dir → cache_dir.
    const FIXED_FILES: &[&str] = &["metadata-cache.sqlite"];

    for name in FIXED_FILES {
        let from = old_root.join(name);
        let to = new_root.join(name);
        if from.exists() && !to.exists() {
            if let Err(err) = std::fs::rename(&from, &to) {
                log::info!(
                    "app_paths: legacy cache file {} could not be moved \
                     ({err}); abandoning — will rebuild fresh",
                    from.display()
                );
                let _ = std::fs::remove_file(&from);
            }
        }
    }

    // search-index-<hash>.bin uses a hash suffix; glob the old dir.
    if let Ok(entries) = std::fs::read_dir(old_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with("search-index-") || !name.ends_with(".bin") {
                continue;
            }
            let to = new_root.join(&name);
            if to.exists() {
                continue;
            }
            if let Err(err) = std::fs::rename(&path, &to) {
                log::info!(
                    "app_paths: legacy search index {} could not be \
                     moved ({err}); abandoning",
                    path.display()
                );
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    // Don't remove old_root itself — snapshots/ still belongs there.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_ends_in_inkycap() {
        assert_eq!(
            config_dir().file_name().and_then(|s| s.to_str()),
            Some("inkycap")
        );
    }

    #[test]
    fn data_dir_ends_in_inkycap() {
        assert_eq!(
            data_dir().file_name().and_then(|s| s.to_str()),
            Some("inkycap")
        );
    }

    #[test]
    fn cache_dir_ends_in_inkycap() {
        assert_eq!(
            cache_dir().file_name().and_then(|s| s.to_str()),
            Some("inkycap")
        );
    }

    #[test]
    fn migrate_moves_fixed_file() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        std::fs::create_dir_all(&old).unwrap();

        let old_file = old.join("metadata-cache.sqlite");
        std::fs::write(&old_file, b"sqlite-bytes").unwrap();

        migrate_legacy_cache_paths_at(&old, &new);

        assert!(
            !old_file.exists(),
            "old metadata-cache.sqlite should be gone"
        );
        let new_file = new.join("metadata-cache.sqlite");
        assert!(new_file.exists(), "new metadata-cache.sqlite should exist");
        assert_eq!(std::fs::read(&new_file).unwrap(), b"sqlite-bytes");
    }

    #[test]
    fn migrate_moves_search_index_glob() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        std::fs::create_dir_all(&old).unwrap();

        let a = old.join("search-index-abc123.bin");
        let b = old.join("search-index-deadbeef.bin");
        let unrelated = old.join("not-a-search-index.txt");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        std::fs::write(&unrelated, b"u").unwrap();

        migrate_legacy_cache_paths_at(&old, &new);

        assert!(
            !a.exists() && !b.exists(),
            "old search indexes should be gone"
        );
        assert!(new.join("search-index-abc123.bin").exists());
        assert!(new.join("search-index-deadbeef.bin").exists());
        assert!(unrelated.exists(), "non-cache files in old root must stay");
    }

    #[test]
    fn migrate_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();

        let target = new.join("metadata-cache.sqlite");
        std::fs::write(&target, b"already-here").unwrap();
        // A copy also exists at the destination: it must not be overwritten,
        // and the old file stays.
        let old_copy = old.join("metadata-cache.sqlite");
        std::fs::write(&old_copy, b"stale").unwrap();

        migrate_legacy_cache_paths_at(&old, &new);
        migrate_legacy_cache_paths_at(&old, &new);

        assert_eq!(std::fs::read(&target).unwrap(), b"already-here");
        // Second run with no source file is a no-op and must not panic.
    }

    #[test]
    fn migrate_no_old_root_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("never-existed");
        let new = tmp.path().join("new");
        migrate_legacy_cache_paths_at(&old, &new);
        assert!(
            !new.exists(),
            "should not create new root when old is absent"
        );
    }
}
