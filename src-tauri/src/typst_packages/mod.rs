//! Typst package management: install packages from the Typst Universe
//! (<https://typst.app/universe>) or from a local `.tar.gz` archive.
//!
//! Universe packages live at predictable URLs:
//!
//!   https://packages.typst.org/<namespace>/<name>-<version>.tar.gz
//!
//! After extraction, InkyCap's package resolver looks them up at:
//!
//!   <notebox>/.inkycap/packages/<namespace>/<name>/<version>/
//!
//! Tarball entries are sandboxed to the target directory at extraction time —
//! any entry whose normalized path escapes the target is skipped (defense
//! against path-traversal in a malicious archive). Size caps protect against
//! decompression-bomb archives.
//!
//! This module is intentionally small. It exists because two separate
//! features both need `.tar.gz` handling: Universe install (here) and the
//! markdown notebox importer (which accepts `.tar.gz` as an alternate input
//! shape alongside `.zip`). See [`extract_tar_gz`] for the shared path.
//!
//! Per CLAUDE.md's Typst-first principle: this module is unavoidable Rust
//! glue. Typst itself has no package-fetching logic — every editor (Tinymist,
//! typst-cli, etc.) ships its own. The Typst side here is just "lay files out
//! where the existing world.rs resolver already looks."

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};

/// Cap individual extracted file size at 256 MiB. Universe packages are
/// typically well under 1 MiB; anything larger is suspicious. We bail out
/// on the file, not the whole archive, so a single bad entry doesn't lose
/// the rest of a legitimate package.
const MAX_ENTRY_SIZE: u64 = 256 * 1024 * 1024;

/// Cap total extracted size per archive. Same threshold, applied
/// cumulatively to catch decompression-bomb shapes where many small entries
/// add up.
const MAX_TOTAL_SIZE: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PackageSpec {
    pub namespace: String,
    pub name: String,
    pub version: String,
}

impl PackageSpec {
    /// Parse a Typst-style spec, e.g. `@preview/cetz:0.2.0`.
    /// Returns `None` for malformed input. Leading `@` is required (this is
    /// the user-facing canonical form); the namespace defaults to `preview`
    /// if no `@<ns>/` prefix is present.
    pub fn parse(input: &str) -> Option<Self> {
        Self::parse_with_default_ns(input, "preview")
    }

    /// Like [`parse`] but defaults to `@local/` when no namespace is given,
    /// and to `0.1.0` when no `:version` suffix is present. Used by the
    /// local-package authoring path where bare names like `letter-layout`
    /// expand to `@local/letter-layout:0.1.0`.
    pub fn parse_local_default(input: &str) -> Option<Self> {
        let trimmed = input.trim();
        // Append default version if missing (only when there's no ':' at all).
        let with_version: String = if trimmed.contains(':') {
            trimmed.to_string()
        } else {
            format!("{}:0.1.0", trimmed)
        };
        Self::parse_with_default_ns(&with_version, "local")
    }

    fn parse_with_default_ns(input: &str, default_ns: &str) -> Option<Self> {
        let trimmed = input.trim();
        let (body, had_at) = match trimmed.strip_prefix('@') {
            Some(rest) => (rest, true),
            None => (trimmed, false),
        };
        let (ns_part, rest) = match body.split_once('/') {
            Some((ns, rest)) if had_at => (ns.to_string(), rest),
            // A leading "/" without "@" isn't valid; treat the whole as name.
            _ => (default_ns.to_string(), body),
        };
        let (name, version) = rest.split_once(':')?;
        if ns_part.is_empty() || name.is_empty() || version.is_empty() {
            return None;
        }
        if !is_safe_segment(&ns_part) || !is_safe_segment(name) || !is_safe_version(version) {
            return None;
        }
        Some(Self {
            namespace: ns_part,
            name: name.to_string(),
            version: version.to_string(),
        })
    }

    pub fn canonical(&self) -> String {
        format!("@{}/{}:{}", self.namespace, self.name, self.version)
    }

    pub fn install_dir(&self, notebox_root: &Path) -> PathBuf {
        notebox_root
            .join(".inkycap")
            .join("packages")
            .join(&self.namespace)
            .join(&self.name)
            .join(&self.version)
    }

    pub fn download_url(&self) -> String {
        // Universe convention. Non-preview namespaces would need a
        // different host; in practice users install from @preview/* and
        // the local-tarball path covers everything else.
        format!(
            "https://packages.typst.org/{}/{}-{}.tar.gz",
            self.namespace, self.name, self.version
        )
    }
}

fn is_safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn is_safe_version(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
}

/// Extract a `.tar.gz` byte stream into `target_dir`. Sandboxed: entries
/// whose normalized path escapes the target are skipped silently. Symlinks
/// are skipped entirely (no symlink expansion = no symlink-traversal).
///
/// On success returns the number of entries written.
pub fn extract_tar_gz<R: Read>(reader: R, target_dir: &Path) -> io::Result<usize> {
    fs::create_dir_all(target_dir)?;
    let canonical_target = fs::canonicalize(target_dir)?;
    let gz = GzDecoder::new(reader);
    let mut archive = tar::Archive::new(gz);
    let mut written = 0usize;
    let mut total_bytes: u64 = 0;

    for entry in archive.entries()? {
        let mut entry = entry?;
        let header = entry.header().clone();
        let entry_type = header.entry_type();

        // Skip symlinks, hard links, and other non-file/dir entries.
        if !(entry_type.is_file() || entry_type.is_dir()) {
            continue;
        }

        let entry_path = entry.path()?.into_owned();
        let safe_rel = match sanitize_relative(&entry_path) {
            Some(p) => p,
            None => continue, // path-traversal attempt; skip
        };
        let dest = canonical_target.join(&safe_rel);

        // Defense in depth: confirm dest is under canonical_target even
        // after join (handles edge cases with Windows path semantics).
        if !dest.starts_with(&canonical_target) {
            continue;
        }

        if entry_type.is_dir() {
            fs::create_dir_all(&dest)?;
            continue;
        }

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }

        let size = header.size().unwrap_or(0);
        if size > MAX_ENTRY_SIZE {
            log::warn!(
                "tarball entry {} exceeds size cap; skipping",
                safe_rel.display()
            );
            continue;
        }
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_TOTAL_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "tarball cumulative size exceeds cap",
            ));
        }

        entry.unpack(&dest)?;
        written += 1;
    }

    Ok(written)
}

/// Normalize a tar entry path: reject absolute, parent-traversal, and
/// drive-letter shapes. Returns the path stripped of leading "./" if safe,
/// or None if the path is unsafe.
fn sanitize_relative(p: &Path) -> Option<PathBuf> {
    if p.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => continue,
            // ParentDir, RootDir, Prefix are all unsafe.
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

/// Inspect an extracted package's typst.toml and return the declared
/// package spec, if any. Used when the user installs a local tarball and
/// we don't know the namespace/name/version up-front.
pub fn read_package_manifest(dir: &Path) -> Option<PackageSpec> {
    let toml_path = dir.join("typst.toml");
    let content = fs::read_to_string(&toml_path).ok()?;
    let name = toml_string_field(&content, "name")?;
    let version = toml_string_field(&content, "version")?;
    // Namespace isn't in typst.toml — Universe packages are all `preview`
    // by convention. If the archive turns out to be from elsewhere, the
    // caller can override.
    if !is_safe_segment(&name) || !is_safe_version(&version) {
        return None;
    }
    Some(PackageSpec {
        namespace: "preview".to_string(),
        name,
        version,
    })
}

/// Does `typst.toml` declare a `[template]` section?
///
/// Universe distinguishes "package" (library — provides functions, show
/// rules) from "template" (project starter — a full document scaffold the
/// user clones with `typst init`). The marker is a `[template]` table in
/// the manifest; presence alone is enough to classify, we don't need to
/// parse its contents.
pub fn manifest_declares_template(content: &str) -> bool {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if trimmed == "[template]" || trimmed.starts_with("[template.") {
            return true;
        }
    }
    false
}

/// Parse top-level fields from a `[package]` section. Returns (description,
/// authors). Best-effort, naive — same approach as `toml_string_field`.
pub fn read_package_meta(content: &str) -> (Option<String>, Option<String>) {
    (
        toml_string_field(content, "description"),
        toml_string_field(content, "authors"),
    )
}

fn toml_string_field(content: &str, key: &str) -> Option<String> {
    // Naive scanner — matches the same shape as helpers.rs's
    // extract_toml_string_field. Adopt a real TOML parser if/when we need
    // more than top-level `key = "value"` reads.
    for line in content.lines() {
        let trimmed = line.trim();
        let prefix = format!("{} =", key);
        if let Some(rest) = trimmed.strip_prefix(&prefix) {
            let rest = rest.trim().trim_start_matches('"');
            if let Some(end) = rest.find('"') {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_spec() {
        let spec = PackageSpec::parse("@preview/cetz:0.2.0").unwrap();
        assert_eq!(spec.namespace, "preview");
        assert_eq!(spec.name, "cetz");
        assert_eq!(spec.version, "0.2.0");
        assert_eq!(spec.canonical(), "@preview/cetz:0.2.0");
    }

    #[test]
    fn defaults_namespace_to_preview() {
        let spec = PackageSpec::parse("cetz:0.2.0").unwrap();
        assert_eq!(spec.namespace, "preview");
    }

    #[test]
    fn rejects_traversal_segments() {
        assert!(PackageSpec::parse("@../etc/passwd:1.0").is_none());
        assert!(PackageSpec::parse("@preview/foo/bar:1.0").is_none());
        assert!(PackageSpec::parse("@preview/foo:").is_none());
        assert!(PackageSpec::parse("@preview/:1.0").is_none());
    }

    #[test]
    fn parse_local_default_expands_bare_name() {
        let spec = PackageSpec::parse_local_default("letter-layout").unwrap();
        assert_eq!(spec.namespace, "local");
        assert_eq!(spec.name, "letter-layout");
        assert_eq!(spec.version, "0.1.0");
    }

    #[test]
    fn parse_local_default_honors_full_spec() {
        let spec = PackageSpec::parse_local_default("@myorg/letter:1.0.0").unwrap();
        assert_eq!(spec.namespace, "myorg");
        assert_eq!(spec.name, "letter");
        assert_eq!(spec.version, "1.0.0");
    }

    #[test]
    fn parse_local_default_accepts_name_with_version() {
        let spec = PackageSpec::parse_local_default("letter:0.2.0").unwrap();
        assert_eq!(spec.namespace, "local");
        assert_eq!(spec.name, "letter");
        assert_eq!(spec.version, "0.2.0");
    }

    #[test]
    fn sanitize_blocks_parent_refs() {
        assert!(sanitize_relative(Path::new("../escape.txt")).is_none());
        assert!(sanitize_relative(Path::new("/etc/passwd")).is_none());
        assert!(sanitize_relative(Path::new("./safe.txt")).unwrap() == PathBuf::from("safe.txt"));
        assert!(
            sanitize_relative(Path::new("nested/file.txt")).unwrap()
                == PathBuf::from("nested/file.txt")
        );
    }
}
