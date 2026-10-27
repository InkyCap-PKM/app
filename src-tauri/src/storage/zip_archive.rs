//! Reading and writing single zip entries, for backups and collaboration
//! packages.
//!
//! This writes one entry (bytes or a streamed file) or reads one, with optional
//! AES-256 and cancellation. Walking folders, exclusions, prefixes and
//! conflicts are left to callers, since a backup (a whole notebox) and a
//! package (a set of files) need different handling.
//!
//! Paths inside a zip always use `/`, not the OS separator.
//!
//! Archives can come from other people, so every read of entry contents goes
//! through an [`ExtractBudget`], which stops archives built to expand
//! enormously from filling the disk or memory.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use zip::write::{SimpleFileOptions, ZipWriter};
use zip::{AesMode, CompressionMethod, ZipArchive};

use crate::errors::{InkyCapError, Result};

/// Streaming chunk size for file entries.
const CHUNK: usize = 64 * 1024;

/// Options for one entry: Deflate, `0644`, AES-256 with a password. Built per
/// entry because the zip crate takes them by value each time; they borrow
/// `password`.
pub fn entry_options(password: Option<&str>) -> zip::write::FileOptions<'_, ()> {
    let opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    match password {
        Some(pw) => opts.with_aes_encryption(AesMode::Aes256, pw),
        None => opts,
    }
}

/// Writes entries into a zip file. The caller chooses the entries and names;
/// this handles AES, chunked streaming and cancellation.
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
        // Direct field access (not a `&self` helper) so the borrow checker sees
        // `self.password` and `self.zip` borrowed separately.
        let opts = entry_options(self.password.as_deref());
        self.zip
            .start_file(interior, opts)
            .map_err(|e| InkyCapError::ExportFailed(format!("start_file {interior}: {e}")))?;
        self.zip.write_all(data)?;
        Ok(())
    }

    /// Add a file from disk, streamed in chunks. Returns the uncompressed bytes
    /// written. `cancel` is checked before opening and between chunks, so a
    /// large file can be cancelled mid-way.
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

/// List a zip's entries. Entry metadata isn't encrypted, so this works on AES
/// archives without a password.
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

/// How many times its own size an archive may expand to when unpacked.
/// Notes and attachments compress far less than this; archives built to fill
/// the disk ("zip bombs") compress far more.
const MAX_EXPANSION_RATIO: u64 = 100;

/// Every archive may unpack to at least this much, so a small archive of
/// highly compressible text is never refused.
const MIN_EXPANSION_ALLOWANCE: u64 = 1024 * 1024 * 1024;

const TOO_LARGE: &str =
    "the archive unpacks to far more data than expected; it may be damaged or built to fill the disk";

/// A running limit on how much data may be unpacked from one archive. Create
/// one per archive and pass it to every entry read from that archive.
#[derive(Debug)]
pub struct ExtractBudget {
    remaining: u64,
}

impl ExtractBudget {
    /// A budget for the archive file at `archive`, sized from its length.
    pub fn for_archive(archive: &Path) -> Result<Self> {
        Ok(Self::for_archive_size(std::fs::metadata(archive)?.len()))
    }

    /// A budget for an archive that is `archive_size` bytes long.
    pub fn for_archive_size(archive_size: u64) -> Self {
        Self {
            remaining: archive_size
                .saturating_mul(MAX_EXPANSION_RATIO)
                .max(MIN_EXPANSION_ALLOWANCE),
        }
    }

    /// Wrap one entry's reader. Reading fails once the entry produces more
    /// than its declared size, or once the archive's budget runs out.
    pub fn limit<R: Read>(&mut self, reader: R, declared_size: u64) -> LimitedEntry<'_, R> {
        LimitedEntry {
            inner: reader,
            budget: self,
            entry_left: declared_size,
        }
    }
}

/// An entry reader bounded by an [`ExtractBudget`]; see [`ExtractBudget::limit`].
pub struct LimitedEntry<'a, R> {
    inner: R,
    budget: &'a mut ExtractBudget,
    entry_left: u64,
}

impl<R: Read> Read for LimitedEntry<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        let n64 = n as u64;
        if n64 > self.entry_left || n64 > self.budget.remaining {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                TOO_LARGE,
            ));
        }
        self.entry_left -= n64;
        self.budget.remaining -= n64;
        Ok(n)
    }
}

/// Stream one entry into `writer`. With a password, routes through AES
/// decryption. Returns bytes written.
pub fn read_entry_to_writer(
    zip: &mut ZipArchive<std::fs::File>,
    name: &str,
    password: Option<&str>,
    budget: &mut ExtractBudget,
    writer: &mut impl Write,
) -> Result<u64> {
    let entry = match password {
        Some(pw) => zip
            .by_name_decrypt(name, pw.as_bytes())
            .map_err(|e| InkyCapError::ExportFailed(format!("decrypt {name}: {e}")))?,
        None => zip
            .by_name(name)
            .map_err(|e| InkyCapError::ExportFailed(format!("read {name}: {e}")))?,
    };
    let declared = entry.size();
    let n = std::io::copy(&mut budget.limit(entry, declared), writer)?;
    Ok(n)
}

/// Read one entry's full contents into memory.
pub fn read_entry_bytes(
    zip: &mut ZipArchive<std::fs::File>,
    name: &str,
    password: Option<&str>,
    budget: &mut ExtractBudget,
) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    read_entry_to_writer(zip, name, password, budget, &mut buf)?;
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
        let mut budget = ExtractBudget::for_archive(&archive).unwrap();
        assert_eq!(
            read_entry_bytes(&mut zip, "manifest.json", None, &mut budget).unwrap(),
            b"{\"k\":1}"
        );
        assert_eq!(
            read_entry_bytes(&mut zip, "notes/note.typ", None, &mut budget).unwrap(),
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
        let mut budget = ExtractBudget::for_archive(&archive).unwrap();
        assert_eq!(
            read_entry_bytes(&mut zip, "secret.txt", Some(pw), &mut budget).unwrap(),
            b"classified"
        );
    }

    #[test]
    fn budget_stops_entries_that_exceed_their_declared_size() {
        let data = [0u8; 100];
        let mut budget = ExtractBudget::for_archive_size(1);
        let mut out = Vec::new();
        let err = std::io::copy(&mut budget.limit(&data[..], 10), &mut out).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn budget_stops_archives_that_expand_too_far() {
        let mut budget = ExtractBudget { remaining: 150 };
        let data = [0u8; 100];
        std::io::copy(&mut budget.limit(&data[..], 100), &mut std::io::sink()).unwrap();
        let err =
            std::io::copy(&mut budget.limit(&data[..], 100), &mut std::io::sink()).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn small_archives_get_the_minimum_allowance() {
        assert_eq!(
            ExtractBudget::for_archive_size(10).remaining,
            MIN_EXPANSION_ALLOWANCE
        );
        assert_eq!(
            ExtractBudget::for_archive_size(100 * MIN_EXPANSION_ALLOWANCE).remaining,
            100 * MIN_EXPANSION_ALLOWANCE * MAX_EXPANSION_RATIO
        );
    }
}
