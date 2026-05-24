//! Package-handoff collaboration.
//!
//! Collaborators exchange zip packages of a collection (over any
//! transport) rather than connecting to a git remote. Each note carries a
//! composite identity ([`identity::make_collabid`]); a per-collection
//! sidecar ([`versions::VersionsFile`]) tracks a vector clock
//! ([`clock::VectorClock`]) per note. Comparing the incoming sidecar
//! against the local one classifies every note as a clean fast-forward or
//! a concurrent edit that needs review.
//!
//! This module is the engine — pure logic and small filesystem helpers,
//! no Tauri/IPC surface. The review/package/command layers build on top.

pub mod apply;
pub mod attachments;
pub mod bibliography;
pub mod clock;
pub mod identity;
pub mod package;
pub mod review;
pub mod versions;

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Lowercase hex encoding of a byte slice.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Stable id for a collaborative collection, derived from its path
/// relative to the notebox root.
///
/// Path components are normalized to a forward-slash join before hashing
/// so the id is byte-identical across platforms (Windows `\` vs POSIX
/// `/`) — collaborators on different OSes must agree on the id, since it
/// keys the sidecar that travels in the package.
///
/// Note: this is path-derived, so renaming a collection changes its id.
/// The sidecar self-describes its `collection_id`, so a rename is a
/// directory-migration concern handled at the lifecycle layer (a later
/// slice), not a correctness problem for the engine.
pub fn collection_id(notebox_root: &Path, collection_path: &Path) -> String {
    let rel = collection_path
        .strip_prefix(notebox_root)
        .unwrap_or(collection_path);
    let normalized = rel
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    let digest = Sha256::digest(normalized.as_bytes());
    hex_encode(&digest)[..16].to_string()
}

/// Content hash of a note body, in `"sha256:<hex>"` form. Stored in the
/// sidecar so the importer can collapse no-op fast-forwards and
/// auto-resolve byte-identical concurrent edits.
pub fn content_hash(content: &str) -> String {
    content_hash_bytes(content.as_bytes())
}

/// Content hash of arbitrary bytes (a binary attachment), in `"sha256:<hex>"`
/// form. The bytes-level sibling of [`content_hash`] — attachments are
/// versioned by the same scheme as notes so the importer can tell a one-sided
/// change from a true two-sided conflict.
pub fn content_hash_bytes(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    format!("sha256:{}", hex_encode(&digest))
}

/// Directory holding one collaborative collection's local state:
/// `<notebox>/.inkycap/collab/<collection-id>/`. Under `.inkycap/`, which
/// the watcher already ignores.
pub fn collab_dir(notebox_root: &Path, collection_id: &str) -> PathBuf {
    notebox_root
        .join(".inkycap")
        .join("collab")
        .join(collection_id)
}

/// Path to a collection's version sidecar.
pub fn versions_path(notebox_root: &Path, collection_id: &str) -> PathBuf {
    collab_dir(notebox_root, collection_id).join("versions.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_id_is_deterministic() {
        let root = Path::new("/home/u/notebox");
        let col = Path::new("/home/u/notebox/.inkycap/collections/paper.collection");
        let a = collection_id(root, col);
        let b = collection_id(root, col);
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn collection_id_differs_per_collection() {
        let root = Path::new("/home/u/notebox");
        let a = collection_id(root, Path::new("/home/u/notebox/a.collection"));
        let b = collection_id(root, Path::new("/home/u/notebox/b.collection"));
        assert_ne!(a, b);
    }

    #[test]
    fn content_hash_is_prefixed_and_stable() {
        let h = content_hash("hello");
        assert!(h.starts_with("sha256:"));
        assert_eq!(h, content_hash("hello"));
        assert_ne!(h, content_hash("world"));
    }

    #[test]
    fn collab_paths_live_under_inkycap() {
        let root = Path::new("/n");
        let dir = collab_dir(root, "abcd1234");
        assert!(dir.ends_with("collab/abcd1234"));
        assert!(dir.starts_with("/n/.inkycap"));
        assert_eq!(
            versions_path(root, "abcd1234"),
            dir.join("versions.json")
        );
    }
}
