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

/// The shared Typst package directories, matching the layout `typst-cli` and
/// Tinymist use so InkyCap reads — and writes — the same on-disk store rather
/// than a private copy. A package found here compiles identically in any Typst
/// tool on the machine.
///
/// - data dir  (`dirs::data_dir()/typst/packages`): `@local` packages and
///   manually-persisted installs.
/// - cache dir (`dirs::cache_dir()/typst/packages`): where `@preview`
///   downloads land (e.g. `~/.cache/typst/packages/preview/<name>/<ver>`).
///
/// Each returns `None` when the platform directory can't be resolved (rare —
/// headless environments without `HOME`/`XDG_*`).
pub fn typst_packages_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("typst").join("packages"))
}

/// See [`typst_packages_data_dir`]; this is the cache-dir sibling that holds
/// downloaded Universe (`@preview`) packages.
pub fn typst_packages_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("typst").join("packages"))
}

/// The package directories searched for a `<namespace>/<name>/<version>`
/// triple, in priority order: notebox-vendored first (a notebox can pin its
/// own copy), then the shared Typst data dir (`@local` + persisted installs),
/// then the cache dir (`@preview` downloads).
///
/// Both the compile resolver ([`crate::typst_pipeline::world`]) and the
/// collab-export vendoring pass ([`crate::typst_pipeline::package_vendor`])
/// derive their candidate paths from here, so the "where does a package live"
/// answer can never drift between the two.
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

/// Recursively copy a directory tree. Used to install a local-tarball package
/// across a filesystem boundary and to vendor packages into a notebox for
/// collaboration export.
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

/// Read `field = "value"` from inside the `[template]` table of a `typst.toml`.
/// [`toml_string_field`] only reads top-level keys, but a template's `path` and
/// `entrypoint` live under `[template]`, so track the current section and match
/// only while inside it. Best-effort, same naive shape as the sibling helper.
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

/// Find the byte offset of the first "everywhere-form" show rule (`#show: …`)
/// in a Typst source. The colon immediately after `show` distinguishes the
/// everywhere form (applies a template to the whole document) from the selector
/// form (`#show heading: …`), which we must not pick up. Only matches a rule
/// that begins its (trimmed) line, to avoid hits inside content.
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

/// Index just past the matching close of the bracket that opens `s` (which must
/// start at an opening `(`/`[`/`{`). Balances all three bracket kinds together
/// and skips `"…"` strings (with `\"` escapes). Returns `None` if unbalanced.
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

/// Extract a template's "apply" show rule from its starter scaffold — the
/// `#show: <fn>.with(…)` (or bare `#show: <fn>`) line that `typst init` would
/// give the user. Best-effort string work; returns `None` when no everywhere-
/// form show rule is present. Handles the call form spanning multiple lines.
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

/// Rewrite the path argument of the first `bibliography("…")` call in `snippet`
/// to `new_path`, so a template's starter points at InkyCap's auto-generated
/// per-collection bibliography rather than the scaffold's example file (e.g.
/// `refs.bib`). Returns the snippet unchanged if it has no such call.
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

/// Read an installed template package's starter scaffold and return its apply
/// show rule (`#show: <fn>.with(…)`), ready to drop into a collection's Custom
/// Typst override. Returns `None` for non-package templates (a `/notebox/path`),
/// packages that aren't installed, non-template packages, or scaffolds without
/// an everywhere-form show rule — every miss degrades gracefully (the caller
/// just doesn't insert a starter). The `#import` is intentionally omitted: the
/// collection's template field already emits it on export.
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
