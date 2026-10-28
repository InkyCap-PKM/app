//! Typst package installation, from Typst Universe
//! (<https://typst.app/universe>) or a local `.tar.gz`.
//!
//! Universe packages are downloaded from
//!
//!   https://packages.typst.org/<namespace>/<name>-<version>.tar.gz
//!
//! and extracted to
//!
//!   <notebox>/.inkycap/packages/<namespace>/<name>/<version>/
//!
//! where the package resolver finds them. Entries that would extract outside
//! the target are skipped (path traversal), and size limits guard against
//! decompression bombs. [`extract_tar_gz`] is also used by the Markdown
//! importer for `.tar.gz` sources.
//!
//! Per CLAUDE.md's Typst-first principle: Typst has no package fetching of its
//! own (every tool ships its own), so this is Rust glue that lays files out
//! where world.rs already looks.

pub mod details;
pub mod docs;

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};

/// Largest extracted file (256 MiB); Universe packages are usually under 1 MiB.
/// A file over the limit is skipped, not the whole archive.
const MAX_ENTRY_SIZE: u64 = 256 * 1024 * 1024;

/// Largest total extracted size per archive, against many small entries adding
/// up.
const MAX_TOTAL_SIZE: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PackageSpec {
    pub namespace: String,
    pub name: String,
    pub version: String,
}

impl PackageSpec {
    /// Parse a spec like `@preview/cetz:0.2.0`, or `None` if malformed. The
    /// namespace defaults to `preview` without an `@<ns>/` prefix.
    pub fn parse(input: &str) -> Option<Self> {
        Self::parse_with_default_ns(input, "preview")
    }

    /// Like [`parse`], but defaulting to `@local/` and version `0.1.0`, so
    /// `letter-layout` becomes `@local/letter-layout:0.1.0`. For local package
    /// authoring.
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
        // Universe's URL scheme; other namespaces are installed from local
        // archives.
        format!(
            "https://packages.typst.org/{}/{}-{}.tar.gz",
            self.namespace, self.name, self.version
        )
    }
}

/// The shared Typst package folders, as used by `typst-cli` and Tinymist, so
/// InkyCap reads and writes the same store and a package works the same in any
/// Typst tool.
///
/// - data dir (`dirs::data_dir()/typst/packages`): `@local` and installed
///   packages.
/// - cache dir (`dirs::cache_dir()/typst/packages`): downloaded `@preview`
///   packages (e.g. `~/.cache/typst/packages/preview/<name>/<ver>`).
///
/// `None` when the platform folder can't be found (e.g. no `HOME`).
pub fn typst_packages_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("typst").join("packages"))
}

/// See [`typst_packages_data_dir`]; this is the cache-dir sibling that holds
/// downloaded Universe (`@preview`) packages.
pub fn typst_packages_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("typst").join("packages"))
}

/// Package folders for a `<namespace>/<name>/<version>`, in order: the
/// notebox's own (so it can pin a copy), the Typst data dir, then the cache
/// dir. The compile resolver ([`crate::typst_pipeline::world`]) and bundling
/// ([`crate::typst_pipeline::package_vendor`]) both use this, so they agree.
pub fn package_search_dirs(
    notebox_root: &Path,
    namespace: &str,
    name: &str,
    version: &str,
) -> Vec<PathBuf> {
    let sub = Path::new(namespace).join(name).join(version);
    let mut dirs = Vec::with_capacity(3);
    dirs.push(notebox_root.join(".inkycap").join("packages").join(&sub));
    if let Some(data) = typst_packages_data_dir() {
        dirs.push(data.join(&sub));
    }
    if let Some(cache) = typst_packages_cache_dir() {
        dirs.push(cache.join(&sub));
    }
    dirs
}

/// First existing directory among [`package_search_dirs`], or `None` if the
/// package isn't present anywhere locally.
pub fn locate_package_dir(
    notebox_root: &Path,
    namespace: &str,
    name: &str,
    version: &str,
) -> Option<PathBuf> {
    package_search_dirs(notebox_root, namespace, name, version)
        .into_iter()
        .find(|d| d.is_dir())
}

/// Copy a folder recursively, for installing a local package across filesystems
/// and bundling packages into a notebox.
pub fn copy_dir_all(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), dst_path)?;
        }
    }
    Ok(())
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

/// Extract a `.tar.gz` stream into `target_dir`. Entries that would land
/// outside it and symlinks are skipped. Returns the number of entries written.
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

/// A tar entry path without a leading "./", or None if absolute, climbing out
/// with `..`, or a drive letter.
pub(crate) fn sanitize_relative(p: &Path) -> Option<PathBuf> {
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

/// The package spec declared in an extracted package's typst.toml, for local
/// archives whose name and version aren't known in advance.
pub fn read_package_manifest(dir: &Path) -> Option<PackageSpec> {
    let toml_path = dir.join("typst.toml");
    let content = fs::read_to_string(&toml_path).ok()?;
    let name = toml_string_field(&content, "name")?;
    let version = toml_string_field(&content, "version")?;
    // typst.toml has no namespace; Universe packages are `preview`, and the
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

/// Whether `typst.toml` has a `[template]` section, which marks a template (a
/// document starter for `typst init`) rather than a library package. Its
/// presence is enough.
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
    // Simple line scan, like `extract_toml_string_field` in helpers.rs; only
    // top-level `key = "value"`.
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

/// `field = "value"` inside a typst.toml's `[template]` table, where `path` and
/// `entrypoint` live (unlike [`toml_string_field`], which reads top-level
/// keys).
fn toml_template_section_field(content: &str, field: &str) -> Option<String> {
    let mut in_template = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') {
            // Enter `[template]`; any other table (including `[template.x]`
            // subtables) leaves the section we care about.
            in_template = trimmed == "[template]";
            continue;
        }
        if !in_template {
            continue;
        }
        let prefix = format!("{} =", field);
        if let Some(rest) = trimmed.strip_prefix(&prefix) {
            let rest = rest.trim().trim_start_matches('"');
            if let Some(end) = rest.find('"') {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

/// Offset of the first `#show: …` rule (the whole-document form, not `#show
/// heading: …`) that starts a line.
fn find_everywhere_show(s: &str) -> Option<usize> {
    let mut offset = 0usize;
    for line in s.split_inclusive('\n') {
        let lead = line.len() - line.trim_start().len();
        let t = line.trim_start();
        if t.starts_with("#show:") || t.starts_with("#show :") {
            return Some(offset + lead);
        }
        offset += line.len();
    }
    None
}

/// Index after the bracket closing the one that starts `s` (`(`, `[` or `{`),
/// balancing all three and skipping `"…"` strings. `None` if unbalanced.
fn balanced_end(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + c.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

/// The `#show: <fn>.with(…)` (or `#show: <fn>`) line from a template's starter,
/// which `typst init` would give the user, including when it spans lines.
/// `None` if there is none.
pub fn extract_show_rule(scaffold: &str) -> Option<String> {
    let start = find_everywhere_show(scaffold)?;
    let rest = &scaffold[start..];
    // A call form (`.with(`) opens a paren before the line ends; balance it.
    // Otherwise the statement is the single bare `#show: ident` line.
    let nl = rest.find('\n');
    let paren = rest.find('(');
    let end = match paren {
        Some(p) if nl.is_none_or(|n| p < n) => p + balanced_end(&rest[p..])?,
        _ => nl.unwrap_or(rest.len()),
    };
    let snippet = rest[..end].trim_end();
    if snippet.is_empty() {
        None
    } else {
        Some(snippet.to_string())
    }
}

/// Index of the next unescaped `"` in `s` (which starts just after an opening
/// quote), or `None` if unterminated.
fn find_close_quote(s: &str) -> Option<usize> {
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '"' => return Some(i),
            _ => {}
        }
    }
    None
}

/// Point the first `bibliography("…")` in `snippet` at `new_path`, so a
/// template uses the collection's generated bibliography instead of the
/// starter's example (e.g. `refs.bib`). Unchanged if there is none.
pub fn rewrite_show_rule_bibliography(snippet: &str, new_path: &str) -> String {
    const NEEDLE: &str = "bibliography(\"";
    let Some(start) = snippet.find(NEEDLE) else {
        return snippet.to_string();
    };
    let path_start = start + NEEDLE.len();
    let Some(rel_end) = find_close_quote(&snippet[path_start..]) else {
        return snippet.to_string();
    };
    let end = path_start + rel_end;
    let mut out = String::with_capacity(snippet.len() - (end - path_start) + new_path.len());
    out.push_str(&snippet[..path_start]);
    out.push_str(new_path);
    out.push_str(&snippet[end..]);
    out
}

/// The `#show: <fn>.with(…)` rule from an installed template package's starter,
/// for a collection's Custom Typst. `None` for non-package templates, packages
/// not installed, non-templates and starters without such a rule; the caller
/// then adds nothing. The `#import` is left out because the collection's
/// template setting already adds it.
pub fn template_starter_snippet(notebox_root: &Path, spec: &str) -> Option<String> {
    let trimmed = spec.trim();
    // Notebox-path templates have no package scaffold to read.
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return None;
    }
    // Mirror `resolve_template_path_with_root`: `@…` specs parse as-is; a bare
    // name resolves to the local namespace.
    let parsed = if trimmed.starts_with('@') {
        PackageSpec::parse(trimmed)?
    } else {
        PackageSpec::parse_local_default(trimmed)?
    };
    let dir = locate_package_dir(
        notebox_root,
        &parsed.namespace,
        &parsed.name,
        &parsed.version,
    )?;
    let manifest = fs::read_to_string(dir.join("typst.toml")).ok()?;
    if !manifest_declares_template(&manifest) {
        return None;
    }
    let entrypoint = toml_template_section_field(&manifest, "entrypoint")?;
    // `[template].path` (the scaffold dir) is optional — default to the package
    // root. Both values come from the manifest, so sanitize against traversal.
    let rel = match toml_template_section_field(&manifest, "path") {
        Some(p) => Path::new(&p).join(&entrypoint),
        None => PathBuf::from(&entrypoint),
    };
    let safe = sanitize_relative(&rel)?;
    let scaffold = fs::read_to_string(dir.join(safe)).ok()?;
    extract_show_rule(&scaffold)
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
        assert!(sanitize_relative(Path::new("./safe.txt")).unwrap() == Path::new("safe.txt"));
        assert!(
            sanitize_relative(Path::new("nested/file.txt")).unwrap()
                == Path::new("nested/file.txt")
        );
    }

    #[test]
    fn extract_show_rule_multiline_call() {
        let scaffold = r#"#import "@preview/charged-ieee:0.1.0": *
#show: ieee.with(
  title: [A Paper (draft)],
  authors: ((name: "Ada", email: "ada@x.org"),),
  abstract: [Lorem ipsum.],
)

= Introduction
Body text here.
"#;
        let rule = extract_show_rule(scaffold).unwrap();
        assert!(rule.starts_with("#show: ieee.with("));
        // Balances to the closing paren, not into the body.
        assert!(rule.ends_with(')'));
        assert!(rule.contains("abstract: [Lorem ipsum.]"));
        assert!(!rule.contains("Introduction"));
    }

    #[test]
    fn extract_show_rule_bare_form() {
        let scaffold = "#import \"@preview/foo:1.0.0\": *\n#show: foo\n\n= Title\n";
        assert_eq!(extract_show_rule(scaffold).unwrap(), "#show: foo");
    }

    #[test]
    fn extract_show_rule_skips_selector_form() {
        // `#show heading: …` is a selector rule, not a template application.
        let scaffold = "#show heading: it => emph(it)\n= Heading\nText.\n";
        assert!(extract_show_rule(scaffold).is_none());
    }

    #[test]
    fn extract_show_rule_picks_everywhere_over_selector() {
        let scaffold = "#show heading: set text(red)\n#show: ieee.with(title: [T])\n= H\n";
        assert_eq!(
            extract_show_rule(scaffold).unwrap(),
            "#show: ieee.with(title: [T])"
        );
    }

    #[test]
    fn extract_show_rule_none_when_absent() {
        assert!(extract_show_rule("#import \"@preview/foo:1.0.0\": *\n= Title\n").is_none());
    }

    #[test]
    fn rewrite_show_rule_bibliography_swaps_path() {
        let snippet =
            "#show: ieee.with(\n  title: [T],\n  bibliography: bibliography(\"refs.bib\"),\n)";
        let out = rewrite_show_rule_bibliography(snippet, "/.inkycap/collection-bibs/Foo.bib");
        assert!(out.contains("bibliography(\"/.inkycap/collection-bibs/Foo.bib\")"));
        assert!(!out.contains("refs.bib"));
        // Unchanged when there's no bibliography call.
        let plain = "#show: ieee.with(title: [T])";
        assert_eq!(rewrite_show_rule_bibliography(plain, "/x.bib"), plain);
    }

    #[test]
    fn template_section_field_reads_under_template_table() {
        let manifest = r#"[package]
name = "charged-ieee"
version = "0.1.0"
entrypoint = "lib.typ"

[template]
path = "template"
entrypoint = "main.typ"
"#;
        assert_eq!(
            toml_template_section_field(manifest, "entrypoint").as_deref(),
            Some("main.typ")
        );
        assert_eq!(
            toml_template_section_field(manifest, "path").as_deref(),
            Some("template")
        );
        // A field that only exists at top level isn't read from [template].
        assert_eq!(toml_template_section_field(manifest, "name"), None);
    }
}
