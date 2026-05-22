//! Reading and writing collaboration **packages** — the portable zip a
//! collaborator sends to share a collection.
//!
//! A package bundles the collection's member notes, its `.collection`
//! file, the shared `.bib`, any referenced attachments, the version
//! sidecar, and a manifest describing the lot. Transport is the user's
//! problem (email, USB, a sync folder); InkyCap only produces and
//! consumes the file.
//!
//! This module is the pure assembly/disassembly layer over
//! [`crate::storage::zip_archive`]. It takes an explicit file list and a
//! manifest and writes a zip; or it reads a zip back into a staging
//! directory and returns the parsed manifest + sidecar. *Which* files
//! belong (filter evaluation, attachment discovery) and *how* accepted
//! changes land in the working notebox (the apply step) are the command
//! layer's job — kept out of here so this stays unit-testable without an
//! `AppState`.
//!
//! Interior layout:
//! ```text
//!   manifest.json            PackageManifest
//!   versions.json            the VersionsFile sidecar
//!   files/<notebox-relpath>  every shared file (notes, .collection, .bib, attachments)
//! ```

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::versions::VersionsFile;
use crate::errors::{InkyCapError, Result};
use crate::storage::zip_archive::{self, ZipBuilder};

/// On-disk package schema version.
pub const PACKAGE_SCHEMA: u32 = 1;

const MANIFEST_ENTRY: &str = "manifest.json";
const VERSIONS_ENTRY: &str = "versions.json";
const FILES_PREFIX: &str = "files/";

/// One member note recorded in the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackagedNote {
    pub collabid: String,
    /// Notebox-relative path (forward slashes).
    pub relpath: String,
}

/// Describes everything a package carries, so the importer can interpret
/// the `files/` payload without guessing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageManifest {
    pub schema: u32,
    pub collection_id: String,
    /// Notebox-relative path of the `.collection` file.
    pub collection_relpath: String,
    /// Notebox-relative path of the shared bibliography, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bibliography_relpath: Option<String>,
    /// Member notes (collabid ↔ path).
    #[serde(default)]
    pub notes: Vec<PackagedNote>,
    /// Notebox-relative paths of referenced attachments.
    #[serde(default)]
    pub attachments: Vec<String>,
}

/// A package after extraction to a staging directory.
#[derive(Debug, Clone)]
pub struct StagedPackage {
    pub manifest: PackageManifest,
    pub versions: VersionsFile,
    /// Directory the `files/` payload was extracted into. A staged file
    /// at notebox-relpath `notes/x.typ` lives at
    /// `staging_dir.join("notes/x.typ")`.
    pub staging_dir: PathBuf,
    /// Notebox-relative paths actually present under `files/`.
    pub file_relpaths: Vec<String>,
}

/// Reject interior paths that would escape the extraction root (zip-slip)
/// — package contents are attacker-controllable when the file arrives
/// from outside.
fn is_safe_relpath(rel: &str) -> bool {
    !PathBuf::from(rel)
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

/// Write a package to `dest`.
///
/// - `files`: `(notebox-relpath, absolute source path)` for every shared
///   file. Streamed from disk, so attachments don't load fully into RAM.
/// - `versions`: the sidecar to embed.
/// - `password`: optional AES-256.
pub fn write_package(
    dest: &Path,
    manifest: &PackageManifest,
    versions: &VersionsFile,
    files: &[(String, PathBuf)],
    password: Option<String>,
) -> Result<()> {
    let mut builder = ZipBuilder::create(dest, password)?;

    let manifest_json = serde_json::to_vec_pretty(manifest)?;
    builder.add_bytes(MANIFEST_ENTRY, &manifest_json)?;

    let versions_json = serde_json::to_vec_pretty(versions)?;
    builder.add_bytes(VERSIONS_ENTRY, &versions_json)?;

    for (relpath, src) in files {
        if !is_safe_relpath(relpath) {
            return Err(InkyCapError::InvalidPath(format!(
                "refusing to package unsafe path: {relpath}"
            )));
        }
        // Normalize to forward slashes for the interior name.
        let interior = format!("{FILES_PREFIX}{}", relpath.replace('\\', "/"));
        builder.add_file(&interior, src, None)?;
    }

    builder.finish()
}

/// Read just the manifest from a package, without extracting the payload.
/// Used to peek at what collection a package is for before deciding where
/// to import it.
pub fn read_manifest(src: &Path, password: Option<&str>) -> Result<PackageManifest> {
    let mut zip = zip_archive::open(src)?;
    let bytes = zip_archive::read_entry_bytes(&mut zip, MANIFEST_ENTRY, password)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Read one packaged file's bytes by its notebox-relative path, without
/// extracting the whole payload. Used to pull the bundled `.collection`
/// file when creating a collection on import.
pub fn read_packaged_file(src: &Path, relpath: &str, password: Option<&str>) -> Result<Vec<u8>> {
    let mut zip = zip_archive::open(src)?;
    let interior = format!("{FILES_PREFIX}{}", relpath.replace('\\', "/"));
    zip_archive::read_entry_bytes(&mut zip, &interior, password)
}

/// Extract a package into `staging_dir` and return its parsed manifest +
/// sidecar. The `files/` payload lands under `staging_dir` at each
/// entry's notebox-relative path. `password` is required for an
/// AES-encrypted package.
pub fn read_package(src: &Path, staging_dir: &Path, password: Option<&str>) -> Result<StagedPackage> {
    std::fs::create_dir_all(staging_dir)?;

    let entries = zip_archive::list_entries(src)?;
    let mut zip = zip_archive::open(src)?;

    // Manifest + sidecar first.
    let manifest: PackageManifest = {
        let bytes = zip_archive::read_entry_bytes(&mut zip, MANIFEST_ENTRY, password)?;
        serde_json::from_slice(&bytes)?
    };
    if manifest.schema != PACKAGE_SCHEMA {
        return Err(InkyCapError::BadRequest(format!(
            "unsupported package schema {} (expected {PACKAGE_SCHEMA})",
            manifest.schema
        )));
    }
    let versions: VersionsFile = {
        let bytes = zip_archive::read_entry_bytes(&mut zip, VERSIONS_ENTRY, password)?;
        serde_json::from_slice(&bytes)?
    };

    // Extract the file payload.
    let mut file_relpaths = Vec::new();
    for entry in &entries {
        if entry.is_dir {
            continue;
        }
        let Some(rel) = entry.name.strip_prefix(FILES_PREFIX) else {
            continue; // manifest.json / versions.json / anything else
        };
        if rel.is_empty() {
            continue;
        }
        if !is_safe_relpath(rel) {
            return Err(InkyCapError::InvalidPath(format!(
                "package entry has unsafe path: {}",
                entry.name
            )));
        }
        let dest = staging_dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&dest)?;
        zip_archive::read_entry_to_writer(&mut zip, &entry.name, password, &mut out)?;
        file_relpaths.push(rel.to_string());
    }

    Ok(StagedPackage {
        manifest,
        versions,
        staging_dir: staging_dir.to_path_buf(),
        file_relpaths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collab::content_hash;

    fn write_file(dir: &Path, rel: &str, body: &str) -> PathBuf {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn write_then_read_round_trip() {
        let work = tempfile::tempdir().unwrap();
        let notebox = work.path().join("notebox");
        std::fs::create_dir_all(&notebox).unwrap();

        // Source files on disk.
        let note_abs = write_file(&notebox, "notes/intro.typ", "= Intro\nbody");
        let bib_abs = write_file(&notebox, "refs.bib", "@article{a, title={A}}");
        let col_abs = write_file(&notebox, ".inkycap/collections/p.collection", "views: []");
        let img_abs = write_file(&notebox, "Assets/fig.txt", "pretend-png-bytes");

        // Sidecar + manifest.
        let mut versions = VersionsFile::new("col-1");
        versions.record_edit("zid-alice", "alice", "notes/intro.typ", content_hash("= Intro\nbody"));
        let manifest = PackageManifest {
            schema: PACKAGE_SCHEMA,
            collection_id: "col-1".into(),
            collection_relpath: ".inkycap/collections/p.collection".into(),
            bibliography_relpath: Some("refs.bib".into()),
            notes: vec![PackagedNote {
                collabid: "zid-alice".into(),
                relpath: "notes/intro.typ".into(),
            }],
            attachments: vec!["Assets/fig.txt".into()],
        };

        let files = vec![
            ("notes/intro.typ".to_string(), note_abs),
            ("refs.bib".to_string(), bib_abs),
            (".inkycap/collections/p.collection".to_string(), col_abs),
            ("Assets/fig.txt".to_string(), img_abs),
        ];

        let pkg_path = work.path().join("p.inkycap-pkg.zip");
        write_package(&pkg_path, &manifest, &versions, &files, None).unwrap();
        assert!(pkg_path.exists());

        // Read it back into a fresh staging dir.
        let staging = work.path().join("staging");
        let staged = read_package(&pkg_path, &staging, None).unwrap();

        assert_eq!(staged.manifest, manifest);
        assert_eq!(staged.versions, versions);
        assert_eq!(staged.file_relpaths.len(), 4);

        // Extracted contents match the originals at their relpaths.
        assert_eq!(
            std::fs::read_to_string(staging.join("notes/intro.typ")).unwrap(),
            "= Intro\nbody"
        );
        assert_eq!(
            std::fs::read_to_string(staging.join("Assets/fig.txt")).unwrap(),
            "pretend-png-bytes"
        );
    }

    #[test]
    fn read_manifest_and_packaged_file_without_full_extract() {
        let work = tempfile::tempdir().unwrap();
        let note_abs = write_file(work.path(), "notes/x.typ", "body-x");
        let col_abs = write_file(work.path(), "c.collection", "views: []\nfilters:\n  and: []");
        let manifest = PackageManifest {
            schema: PACKAGE_SCHEMA,
            collection_id: "cid".into(),
            collection_relpath: "c.collection".into(),
            bibliography_relpath: None,
            notes: vec![PackagedNote { collabid: "z-a".into(), relpath: "notes/x.typ".into() }],
            attachments: vec![],
        };
        let versions = VersionsFile::new("cid");
        let files = vec![
            ("notes/x.typ".to_string(), note_abs),
            ("c.collection".to_string(), col_abs),
        ];
        let pkg = work.path().join("p.zip");
        write_package(&pkg, &manifest, &versions, &files, None).unwrap();

        // Manifest peek matches.
        assert_eq!(read_manifest(&pkg, None).unwrap(), manifest);
        // Bundled collection file readable by relpath.
        let bytes = read_packaged_file(&pkg, "c.collection", None).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "views: []\nfilters:\n  and: []");
    }

    #[test]
    fn encrypted_package_round_trips() {
        let work = tempfile::tempdir().unwrap();
        let note_abs = write_file(work.path(), "n.typ", "secret note");
        let manifest = PackageManifest {
            schema: PACKAGE_SCHEMA,
            collection_id: "c".into(),
            collection_relpath: "c.collection".into(),
            bibliography_relpath: None,
            notes: vec![PackagedNote { collabid: "z-a".into(), relpath: "n.typ".into() }],
            attachments: vec![],
        };
        let versions = VersionsFile::new("c");
        let files = vec![("n.typ".to_string(), note_abs)];
        let pkg = work.path().join("enc.zip");
        write_package(&pkg, &manifest, &versions, &files, Some("pw".into())).unwrap();

        let staging = work.path().join("st");
        let staged = read_package(&pkg, &staging, Some("pw")).unwrap();
        assert_eq!(staged.manifest.collection_id, "c");
        assert_eq!(std::fs::read_to_string(staging.join("n.typ")).unwrap(), "secret note");
    }

    #[test]
    fn refuses_unsafe_relpath_on_write() {
        let work = tempfile::tempdir().unwrap();
        let f = write_file(work.path(), "ok.typ", "x");
        let manifest = PackageManifest {
            schema: PACKAGE_SCHEMA,
            collection_id: "c".into(),
            collection_relpath: "c.collection".into(),
            bibliography_relpath: None,
            notes: vec![],
            attachments: vec![],
        };
        let versions = VersionsFile::new("c");
        let files = vec![("../escape.typ".to_string(), f)];
        let pkg = work.path().join("p.zip");
        assert!(write_package(&pkg, &manifest, &versions, &files, None).is_err());
    }

    #[test]
    fn schema_mismatch_is_rejected() {
        let work = tempfile::tempdir().unwrap();
        let manifest = PackageManifest {
            schema: 999,
            collection_id: "c".into(),
            collection_relpath: "c.collection".into(),
            bibliography_relpath: None,
            notes: vec![],
            attachments: vec![],
        };
        let versions = VersionsFile::new("c");
        let pkg = work.path().join("p.zip");
        write_package(&pkg, &manifest, &versions, &[], None).unwrap();
        let staging = work.path().join("st");
        assert!(read_package(&pkg, &staging, None).is_err());
    }
}
