//! Entry-level zip read/write primitives, shared by the backup feature
//! and package-handoff collaboration.
//!
//! This layer is deliberately thin: it knows how to put one entry (bytes
//! or a streamed file) into a zip, and how to read one entry back out,
//! with optional AES-256 and optional cancellation. It does *not* walk
//! trees, apply exclusion rules, strip prefixes, or resolve conflicts —
//! that orchestration belongs to each caller, because backup (archive a
//! whole notebox tree) and collab (package a specific file set) need
//! very different orchestration on top of the same mechanics.
//!
//! Interior paths always use forward slashes (the zip spec convention),
//! so callers building interior names must join with `/`, not the OS
//! separator.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use zip::write::{SimpleFileOptions, ZipWriter};
use zip::{AesMode, CompressionMethod, ZipArchive};

use crate::errors::{InkyCapError, Result};

/// Streaming chunk size for file entries.
const CHUNK: usize = 64 * 1024;

/// Per-entry options: Deflate, `0644`, AES-256 when a password is
/// supplied. Rebuilt for every entry because the zip crate consumes the
/// options by value on each `start_file` / `add_directory`. The returned
/// options borrow `password`, hence the explicit lifetime.
pub fn entry_options(password: Option<&str>) -> zip::write::FileOptions<'_, ()> {
    let opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    match password {
        Some(pw) => opts.with_aes_encryption(AesMode::Aes256, pw),
        None => opts,
    }
}

/// Writes individual entries into a zip file. The caller decides which
/// entries exist and what they're named; this handles the per-entry
/// mechanics (optional AES, chunked streaming, cancellation).
pub struct ZipBuilder {
    zip: ZipWriter<std::fs::File>,
    password: Option<String>,
}

impl ZipBuilder {
    /// Create a new archive at `dest`. Caller pre-creates the parent
    /// directory. `password` enables AES-256 on every entry.
    pub fn create(dest: &Path, password: Option<String>) -> Result<Self> {
        let file = std::fs::File::create(dest)?;
        Ok(Self {
            zip: ZipWriter::new(file),
            password,
        })
    }

    /// Add an in-memory entry (e.g. a generated manifest or sidecar).
    pub fn add_bytes(&mut self, interior: &str, data: &[u8]) -> Result<()> {
        // `entry_options` borrows `self.password`; `start_file` borrows
        // `self.zip`. Keeping them as direct field accesses (rather than a
        // `&self` helper) lets the borrow checker see them as disjoint.
        let opts = entry_options(self.password.as_deref());
        self.zip
            .start_file(interior, opts)
            .map_err(|e| InkyCapError::ExportFailed(format!("start_file {interior}: {e}")))?;
        self.zip.write_all(data)?;
        Ok(())
    }

    /// Add a file from disk, streamed in chunks. Returns the number of
    /// uncompressed bytes written. When `cancel` is set, it is polled
    /// before the file opens and between chunks, so cancelling during a
    /// very large file doesn't wait for the next file boundary.
    pub fn add_file(
        &mut self,
        interior: &str,
        src: &Path,
        cancel: Option<&Arc<AtomicBool>>,
    ) -> Result<u64> {
        let check_cancel = |c: Option<&Arc<AtomicBool>>| -> Result<()> {
            if let Some(flag) = c {
                if flag.load(Ordering::Acquire) {
                    return Err(InkyCapError::Cancelled);
                }
            }
            Ok(())
        };

        check_cancel(cancel)?;
        let opts = entry_options(self.password.as_deref());
        self.zip
            .start_file(interior, opts)
            .map_err(|e| InkyCapError::ExportFailed(format!("start_file {interior}: {e}")))?;

        let mut f = std::fs::File::open(src)?;
        let mut buf = [0u8; CHUNK];
        let mut total = 0u64;
        loop {
            check_cancel(cancel)?;
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            self.zip.write_all(&buf[..n])?;
            total += n as u64;
        }
        Ok(total)
    }

    /// Add an explicit (empty) directory entry.
    pub fn add_directory(&mut self, interior: &str) -> Result<()> {
        let opts = entry_options(self.password.as_deref());
        self.zip
            .add_directory(interior, opts)
            .map_err(|e| InkyCapError::ExportFailed(format!("add_directory {interior}: {e}")))?;
        Ok(())
    }

    /// Finalize the central directory and flush.
    pub fn finish(self) -> Result<()> {
        self.zip
            .finish()
            .map_err(|e| InkyCapError::ExportFailed(format!("finalising zip: {e}")))?;
        Ok(())
    }
}

/// Metadata for one entry, read from the central directory (no
/// decryption needed).
#[derive(Debug, Clone)]
pub struct ZipEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub encrypted: bool,
}

/// Open an archive for reading.
pub fn open(archive: &Path) -> Result<ZipArchive<std::fs::File>> {
    let file = std::fs::File::open(archive)
        .map_err(|e| InkyCapError::FileNotFound(format!("{}: {e}", archive.display())))?;
    ZipArchive::new(file).map_err(|e| InkyCapError::BadRequest(format!("not a valid zip: {e}")))
}

/// List a zip's entries from its central directory. Does not decrypt —
/// entry metadata is never encrypted — so this works on AES archives
/// without a password.
pub fn list_entries(archive: &Path) -> Result<Vec<ZipEntryInfo>> {
    let mut zip = open(archive)?;
    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        match zip.by_index_raw(i) {
            Ok(e) => out.push(ZipEntryInfo {
                name: e.name().to_string(),
                is_dir: e.is_dir(),
                size: e.size(),
                encrypted: e.encrypted(),
            }),
            Err(e) => log::warn!("list_entries: skipping entry {i}: {e}"),
        }
    }
    Ok(out)
}

/// Stream one entry into `writer`. With a password, routes through AES
/// decryption. Returns bytes written.
pub fn read_entry_to_writer(
    zip: &mut ZipArchive<std::fs::File>,
    name: &str,
    password: Option<&str>,
    writer: &mut impl Write,
) -> Result<u64> {
    let mut entry = match password {
        Some(pw) => zip
            .by_name_decrypt(name, pw.as_bytes())
            .map_err(|e| InkyCapError::ExportFailed(format!("decrypt {name}: {e}")))?,
        None => zip
            .by_name(name)
            .map_err(|e| InkyCapError::ExportFailed(format!("read {name}: {e}")))?,
    };
    let n = std::io::copy(&mut entry, writer)?;
    Ok(n)
}

/// Read one entry's full contents into memory.
pub fn read_entry_bytes(
    zip: &mut ZipArchive<std::fs::File>,
    name: &str,
    password: Option<&str>,
) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    read_entry_to_writer(zip, name, password, &mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_bytes_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.zip");
        let src = dir.path().join("note.typ");
        std::fs::write(&src, "file body").unwrap();

        let mut b = ZipBuilder::create(&archive, None).unwrap();
        b.add_bytes("manifest.json", b"{\"k\":1}").unwrap();
        let n = b.add_file("notes/note.typ", &src, None).unwrap();
        assert_eq!(n, "file body".len() as u64);
        b.finish().unwrap();

        let entries = list_entries(&archive).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"manifest.json"));
        assert!(names.contains(&"notes/note.typ"));
        assert!(entries.iter().all(|e| !e.encrypted));

        let mut zip = open(&archive).unwrap();
        assert_eq!(read_entry_bytes(&mut zip, "manifest.json", None).unwrap(), b"{\"k\":1}");
        assert_eq!(
            read_entry_bytes(&mut zip, "notes/note.typ", None).unwrap(),
            b"file body"
        );
    }

    #[test]
    fn aes_round_trip_and_metadata_listable_without_password() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("enc.zip");
        let pw = "correct-horse";

        let mut b = ZipBuilder::create(&archive, Some(pw.to_string())).unwrap();
        b.add_bytes("secret.txt", b"classified").unwrap();
        b.finish().unwrap();

        // Listing works without the password (central directory is plain).
        let entries = list_entries(&archive).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].encrypted);

        // Decryption returns the original bytes.
        let mut zip = open(&archive).unwrap();
        assert_eq!(read_entry_bytes(&mut zip, "secret.txt", Some(pw)).unwrap(), b"classified");
    }
}
