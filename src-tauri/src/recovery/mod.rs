// File recovery / snapshot system.
// Stores compressed snapshots of note content in $DATA_DIR/inkycap/snapshots/.
// Each file gets up to MAX_SNAPSHOTS_PER_FILE snapshots, oldest pruned first.

use std::io::{Read, Write};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_SNAPSHOTS_PER_FILE: usize = 50;

/// A single snapshot entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    /// SHA-256 hash of the content (hex string).
    pub hash: String,
    /// Timestamp when the snapshot was taken.
    pub timestamp: DateTime<Utc>,
    /// Size of the original (uncompressed) content in bytes.
    pub size: usize,
}

/// Metadata for all snapshots of a single file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshots {
    /// Notebox-relative path of the original file.
    pub file_path: String,
    /// Ordered list of snapshots (oldest first).
    pub snapshots: Vec<Snapshot>,
}

/// Manages file recovery snapshots.
pub struct SnapshotManager {
    /// Directory where snapshots are stored (e.g. $DATA_DIR/inkycap/snapshots/).
    base_dir: PathBuf,
}

impl SnapshotManager {
    pub fn new() -> Self {
        let base_dir = crate::app_paths::data_dir().join("snapshots");

        // Ensure the snapshots directory exists
        let _ = std::fs::create_dir_all(&base_dir);

        Self { base_dir }
    }

    /// Create a snapshot of `content` for the given notebox-relative `file_path`.
    /// Returns true if a new snapshot was created, false if content hasn't changed.
    pub fn create_snapshot(&self, file_path: &str, content: &str) -> crate::errors::Result<bool> {
        let hash = Self::content_hash(content);

        // Load existing metadata
        let mut meta = self.load_metadata(file_path)?;

        // Skip if the latest snapshot has the same hash (content unchanged)
        if let Some(latest) = meta.snapshots.last() {
            if latest.hash == hash {
                return Ok(false);
            }
        }

        // Compress and write the snapshot data
        let snapshot_file = self.snapshot_data_path(file_path, &hash);
        if let Some(parent) = snapshot_file.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(content.as_bytes())?;
        let compressed = encoder.finish()?;
        std::fs::write(&snapshot_file, &compressed)?;

        // Add snapshot entry
        let snapshot = Snapshot {
            hash,
            timestamp: Utc::now(),
            size: content.len(),
        };
        meta.snapshots.push(snapshot);

        // Prune oldest if over limit
        while meta.snapshots.len() > MAX_SNAPSHOTS_PER_FILE {
            let removed = meta.snapshots.remove(0);
            let old_file = self.snapshot_data_path(file_path, &removed.hash);
            let _ = std::fs::remove_file(old_file);
        }

        // Save updated metadata
        self.save_metadata(file_path, &meta)?;

        Ok(true)
    }

    /// List all snapshots for a given file.
    pub fn list_snapshots(&self, file_path: &str) -> crate::errors::Result<Vec<Snapshot>> {
        let meta = self.load_metadata(file_path)?;
        Ok(meta.snapshots)
    }

    /// Restore content from a specific snapshot (identified by hash).
    pub fn restore_snapshot(&self, file_path: &str, hash: &str) -> crate::errors::Result<String> {
        let snapshot_file = self.snapshot_data_path(file_path, hash);
        if !snapshot_file.exists() {
            return Err(crate::errors::InkyCapError::FileNotFound(format!(
                "Snapshot not found: {} ({})",
                file_path, hash
            )));
        }

        let compressed = std::fs::read(&snapshot_file)?;
        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut content = String::new();
        decoder
            .read_to_string(&mut content)
            .map_err(|e| crate::errors::InkyCapError::Io(e))?;

        Ok(content)
    }

    /// Get a preview of a snapshot's content (first N characters).
    pub fn preview_snapshot(
        &self,
        file_path: &str,
        hash: &str,
        max_chars: usize,
    ) -> crate::errors::Result<String> {
        let content = self.restore_snapshot(file_path, hash)?;

        let body = crate::notebox_package::strip_note_preamble(&content);
        let preview: String = body.chars().take(max_chars).collect();
        Ok(preview)
    }

    /// Delete all snapshots for a file (e.g. when the file is deleted).
    pub fn delete_all_snapshots(&self, file_path: &str) -> crate::errors::Result<()> {
        let dir = self.file_snapshot_dir(file_path);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    // ── Internal helpers ──

    /// Compute SHA-256 hash of content, returning hex string.
    fn content_hash(content: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    /// Directory for a specific file's snapshots.
    /// Uses a hex-encoded hash of the file path to create a flat directory structure.
    fn file_snapshot_dir(&self, file_path: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(file_path.as_bytes());
        let dir_name = format!("{:x}", hasher.finalize());
        // Use first 16 hex chars to keep directory names reasonable
        self.base_dir.join(&dir_name[..16])
    }

    /// Path for the compressed snapshot data file.
    fn snapshot_data_path(&self, file_path: &str, hash: &str) -> PathBuf {
        // Use first 16 chars of hash for the filename
        self.file_snapshot_dir(file_path)
            .join(format!("{}.gz", &hash[..16.min(hash.len())]))
    }

    /// Path for the metadata JSON file for a given source file.
    fn metadata_path(&self, file_path: &str) -> PathBuf {
        self.file_snapshot_dir(file_path).join("meta.json")
    }

    /// Load metadata for a file. Returns empty metadata if none exists.
    fn load_metadata(&self, file_path: &str) -> crate::errors::Result<FileSnapshots> {
        let meta_path = self.metadata_path(file_path);
        if meta_path.exists() {
            let data = std::fs::read_to_string(&meta_path)?;
            let meta: FileSnapshots = serde_json::from_str(&data)?;
            Ok(meta)
        } else {
            Ok(FileSnapshots {
                file_path: file_path.to_string(),
                snapshots: Vec::new(),
            })
        }
    }

    /// Save metadata for a file.
    fn save_metadata(&self, file_path: &str, meta: &FileSnapshots) -> crate::errors::Result<()> {
        let meta_path = self.metadata_path(file_path);
        if let Some(parent) = meta_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(meta)?;
        std::fs::write(&meta_path, data)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_manager(dir: &std::path::Path) -> SnapshotManager {
        SnapshotManager {
            base_dir: dir.to_path_buf(),
        }
    }

    #[test]
    fn test_create_and_restore_snapshot() {
        let tmp = TempDir::new().unwrap();
        let mgr = test_manager(tmp.path());

        let content = "---\ntitle: Test\n---\n\n# Hello\n\nSome content here.";
        let created = mgr.create_snapshot("notes/test.md", content).unwrap();
        assert!(created);

        let snapshots = mgr.list_snapshots("notes/test.md").unwrap();
        assert_eq!(snapshots.len(), 1);

        let restored = mgr
            .restore_snapshot("notes/test.md", &snapshots[0].hash)
            .unwrap();
        assert_eq!(restored, content);
    }

    #[test]
    fn test_skip_unchanged_content() {
        let tmp = TempDir::new().unwrap();
        let mgr = test_manager(tmp.path());

        let content = "# Same content";
        mgr.create_snapshot("notes/same.md", content).unwrap();
        let created = mgr.create_snapshot("notes/same.md", content).unwrap();
        assert!(!created);

        let snapshots = mgr.list_snapshots("notes/same.md").unwrap();
        assert_eq!(snapshots.len(), 1);
    }

    #[test]
    fn test_multiple_versions() {
        let tmp = TempDir::new().unwrap();
        let mgr = test_manager(tmp.path());

        for i in 0..5 {
            let content = format!("Version {}", i);
            mgr.create_snapshot("notes/multi.md", &content).unwrap();
        }

        let snapshots = mgr.list_snapshots("notes/multi.md").unwrap();
        assert_eq!(snapshots.len(), 5);

        // Restore oldest
        let oldest = mgr
            .restore_snapshot("notes/multi.md", &snapshots[0].hash)
            .unwrap();
        assert_eq!(oldest, "Version 0");

        // Restore newest
        let newest = mgr
            .restore_snapshot("notes/multi.md", &snapshots[4].hash)
            .unwrap();
        assert_eq!(newest, "Version 4");
    }

    #[test]
    fn test_preview_strips_preamble() {
        let tmp = TempDir::new().unwrap();
        let mgr = test_manager(tmp.path());

        let content = "#import \"/.inkycap/packages/inkycap-notebox/0.1.0/lib.typ\": *\n#note(\n  title: \"Preview Test\",\n)\n\nThis is the body text.";
        mgr.create_snapshot("notes/preview.typ", content).unwrap();

        let snapshots = mgr.list_snapshots("notes/preview.typ").unwrap();
        let preview = mgr
            .preview_snapshot("notes/preview.typ", &snapshots[0].hash, 50)
            .unwrap();
        assert!(preview.starts_with("This is the body"));
    }

    #[test]
    fn test_prune_old_snapshots() {
        let tmp = TempDir::new().unwrap();
        let mgr = test_manager(tmp.path());

        // Create more than MAX_SNAPSHOTS_PER_FILE
        for i in 0..(MAX_SNAPSHOTS_PER_FILE + 5) {
            let content = format!("Content version {}", i);
            mgr.create_snapshot("notes/prune.md", &content).unwrap();
        }

        let snapshots = mgr.list_snapshots("notes/prune.md").unwrap();
        assert_eq!(snapshots.len(), MAX_SNAPSHOTS_PER_FILE);

        // Newest should still be restorable
        let newest = mgr
            .restore_snapshot("notes/prune.md", &snapshots.last().unwrap().hash)
            .unwrap();
        assert_eq!(
            newest,
            format!("Content version {}", MAX_SNAPSHOTS_PER_FILE + 4)
        );
    }

    #[test]
    fn test_delete_all_snapshots() {
        let tmp = TempDir::new().unwrap();
        let mgr = test_manager(tmp.path());

        mgr.create_snapshot("notes/delete.md", "content").unwrap();
        assert_eq!(mgr.list_snapshots("notes/delete.md").unwrap().len(), 1);

        mgr.delete_all_snapshots("notes/delete.md").unwrap();
        assert_eq!(mgr.list_snapshots("notes/delete.md").unwrap().len(), 0);
    }
}
