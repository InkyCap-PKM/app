//! Vault-default bibliography auto-injection and bib file parsing.
//!
//! Per [TYPST_PIVOT.md](../../TYPST_PIVOT.md) §8 #5 (and the Phase 0 decision
//! recorded in PHASE_0_NOTES.md): if a note doesn't already declare its own
//! `#bibliography(...)` AND the vault has a default bibliography file, the
//! compile pipeline injects a `#bibliography("/<path>")` directive
//! immediately after the `inkycap-vault` import line. The on-disk file is
//! never modified — augmentation happens to an in-memory copy that becomes
//! the main source.
//!
//! Phase 6 adds bibliography entry parsing via the `hayagriva` crate, which
//! handles both BibTeX (`.bib`) and Hayagriva YAML (`.yml`) formats.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// Names tried in order when no `bibliographyPath` setting is configured.
/// `.bib` (BibTeX) wins over `.yml` (Hayagriva) when both exist; the caller
/// is expected to surface a warning in that case.
const DEFAULT_BIB_FILES: &[&str] = &["references.bib", "references.yml", "references.json"];

/// Resolve which bibliography file (if any) should auto-load for the vault.
/// `override_path`, when set, comes from `.inkycap/settings.json
/// bibliographyPath` and is treated as vault-relative.
pub fn detect_default(vault_root: &Path, override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(rel) = override_path {
        let candidate = vault_root.join(rel);
        return candidate.exists().then_some(candidate);
    }
    for name in DEFAULT_BIB_FILES {
        let candidate = vault_root.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Return `true` if the source already has a `#bibliography(...)` call. The
/// scan is deliberately permissive — any uncommented occurrence at any depth
/// counts. Typst itself errors on a duplicate bibliography call, so a
/// false-positive that suppresses our injection is harmless; a false-negative
/// would inject a duplicate and cause a compile error, which is worse.
pub fn already_declares_bibliography(source: &str) -> bool {
    // Strip line comments (`// ...`) before searching so a `// #bibliography`
    // example in a docstring doesn't trip us. Block comments `/* */` are a
    // niche case in Typst and we ignore them — the false-positive failure
    // mode is preferable.
    let stripped = strip_line_comments(source);
    bib_re().is_match(&stripped)
}

/// Build the augmented source for compile. Returns the input unchanged if
/// there's nothing to inject; otherwise appends `#bibliography("/<rel>")`
/// at the end of the source (where users conventionally place references).
/// When `style` is provided, it's included as
/// `#bibliography("/<rel>", style: "<style>")`. If `style` looks like a
/// file path (contains `/` or ends in `.csl`), it's quoted as a path;
/// otherwise it's treated as a built-in style name.
pub fn augment(
    source: &str,
    vault_root: &Path,
    bibliography: &Path,
    style: Option<&str>,
) -> String {
    if already_declares_bibliography(source) {
        return source.to_string();
    }
    let Ok(rel) = bibliography.strip_prefix(vault_root) else {
        return source.to_string();
    };
    let typst_path = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let directive = match style {
        Some(s) if s.contains('/') || s.ends_with(".csl") => {
            format!("#bibliography(\"/{}\", style: \"{}\")\n", typst_path, s)
        }
        Some(s) => format!("#bibliography(\"/{}\", style: \"{}\")\n", typst_path, s),
        None => format!("#bibliography(\"/{}\")\n", typst_path),
    };

    let mut out = String::with_capacity(source.len() + directive.len() + 1);
    out.push_str(source);
    if !source.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&directive);
    out
}


fn strip_line_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    for line in source.split_inclusive('\n') {
        if let Some(idx) = line.find("//") {
            out.push_str(&line[..idx]);
            // Preserve the trailing newline so byte offsets stay stable
            // enough for the regex match. (We don't use the offsets for
            // anything other than presence-checking.)
            if line.ends_with('\n') {
                out.push('\n');
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Match `#bibliography(` with optional whitespace, anywhere in the file.
fn bib_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"#\s*bibliography\s*\(").unwrap())
}


/// A bibliography entry with fields extracted for UI display.
#[derive(Debug, Clone, Serialize)]
pub struct BibEntry {
    pub key: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub entry_type: String,
    /// Original Zotero item key (e.g. "WQ5JZDEU") for constructing
    /// `zotero://select/library/items/<key>` URIs. `None` for file-based entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_item_key: Option<String>,
}

/// Parse a bibliography file (`.bib`, `.yml`, or CSL JSON `.json`).
pub fn parse_bibliography(path: &Path) -> Result<Vec<BibEntry>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read bibliography file: {e}"))?;

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    match ext {
        "bib" => parse_bibtex(&content),
        "yml" | "yaml" => parse_hayagriva(&content),
        "json" => parse_csl_json(&content),
        _ => Err(format!("Unsupported bibliography format: .{ext}")),
    }
}

fn parse_bibtex(content: &str) -> Result<Vec<BibEntry>, String> {
    let library = hayagriva::io::from_biblatex_str(content)
        .map_err(|errs| {
            let msgs: Vec<_> = errs.iter().map(|e| format!("{e}")).collect();
            format!("BibTeX parse errors: {}", msgs.join("; "))
        })?;
    Ok(hayagriva_to_entries(&library))
}

fn parse_hayagriva(content: &str) -> Result<Vec<BibEntry>, String> {
    let library = hayagriva::io::from_yaml_str(content)
        .map_err(|e| format!("Hayagriva YAML parse error: {e}"))?;
    Ok(hayagriva_to_entries(&library))
}

fn hayagriva_to_entries(library: &hayagriva::Library) -> Vec<BibEntry> {
    library
        .iter()
        .map(|entry| {
            let title = entry.title().map(|t| t.to_string()).unwrap_or_default();
            let authors = entry
                .authors()
                .map(|persons| persons.iter().map(|p| p.name_first(false, false)).collect())
                .unwrap_or_default();
            let year = entry.date_any().map(|d| d.year.to_string());
            let entry_type = format!("{:?}", entry.entry_type());
            BibEntry { key: entry.key().to_string(), title, authors, year, entry_type, zotero_item_key: None }
        })
        .collect()
}

/// CSL JSON deserialization types.
#[derive(serde::Deserialize)]
struct CslJsonEntry {
    id: String,
    title: Option<String>,
    author: Option<Vec<CslName>>,
    issued: Option<CslDate>,
    #[serde(rename = "type")]
    entry_type: Option<String>,
}

#[derive(serde::Deserialize)]
struct CslName {
    family: Option<String>,
    given: Option<String>,
}

#[derive(serde::Deserialize)]
struct CslDate {
    #[serde(rename = "date-parts")]
    date_parts: Option<Vec<Vec<serde_json::Value>>>,
}

fn parse_csl_json(content: &str) -> Result<Vec<BibEntry>, String> {
    let csl_entries: Vec<CslJsonEntry> = serde_json::from_str(content)
        .map_err(|e| format!("CSL JSON parse error: {e}"))?;

    Ok(csl_entries
        .into_iter()
        .map(|e| {
            let authors = e.author.unwrap_or_default().into_iter().map(|n| {
                match (n.family, n.given) {
                    (Some(f), Some(g)) => format!("{f}, {g}"),
                    (Some(f), None) => f,
                    (None, Some(g)) => g,
                    (None, None) => String::new(),
                }
            }).filter(|s| !s.is_empty()).collect();

            let year = e.issued.and_then(|d| {
                d.date_parts.and_then(|parts| {
                    parts.first().and_then(|p| {
                        p.first().map(|v| match v {
                            serde_json::Value::Number(n) => n.to_string(),
                            serde_json::Value::String(s) => s.clone(),
                            _ => String::new(),
                        })
                    })
                })
            }).filter(|s| !s.is_empty());

            BibEntry {
                key: e.id,
                title: e.title.unwrap_or_default(),
                authors,
                year,
                entry_type: e.entry_type.unwrap_or_else(|| "unknown".to_string()),
                zotero_item_key: None,
            }
        })
        .collect())
}

/// Export bibliography entries to BibTeX format for the Typst compile pipeline.
/// Used when the citation source is Zotero — Typst's `#bibliography()` needs a
/// real file on disk, so we generate one from the Zotero database contents.
pub fn export_entries_to_bibtex(entries: &[BibEntry]) -> String {
    let mut out = String::new();
    let mut seen_keys = std::collections::HashSet::new();
    for entry in entries {
        if !seen_keys.insert(&entry.key) {
            continue;
        }
        let bib_type = zotero_type_to_bibtex(&entry.entry_type);
        out.push_str(&format!("@{}{{{},\n", bib_type, entry.key));
        if !entry.title.is_empty() {
            out.push_str(&format!("  title = {{{}}},\n", entry.title));
        }
        if !entry.authors.is_empty() {
            out.push_str(&format!("  author = {{{}}},\n", entry.authors.join(" and ")));
        }
        if let Some(ref year) = entry.year {
            out.push_str(&format!("  year = {{{}}},\n", year));
        }
        out.push_str("}\n\n");
    }
    out
}

/// Write a Zotero export BibTeX file to `.inkycap/zotero-export.bib` inside the
/// vault. Returns the vault-relative path suitable for `bibliography_override`.
pub fn write_zotero_export(vault_root: &Path, entries: &[BibEntry]) -> Result<String, String> {
    let inkycap_dir = vault_root.join(".inkycap");
    std::fs::create_dir_all(&inkycap_dir)
        .map_err(|e| format!("Failed to create .inkycap directory: {e}"))?;
    let bib_path = inkycap_dir.join("zotero-export.bib");
    let content = export_entries_to_bibtex(entries);
    std::fs::write(&bib_path, &content)
        .map_err(|e| format!("Failed to write zotero-export.bib: {e}"))?;
    Ok("/.inkycap/zotero-export.bib".to_string())
}

fn zotero_type_to_bibtex(zotero_type: &str) -> &str {
    match zotero_type {
        "journalArticle" => "article",
        "book" => "book",
        "bookSection" => "inbook",
        "conferencePaper" => "inproceedings",
        "thesis" => "phdthesis",
        "report" => "techreport",
        "webpage" => "online",
        "manuscript" => "unpublished",
        "presentation" => "misc",
        _ => "misc",
    }
}

/// Extract citation keys from Typst source. Matches both `@key` and
/// `#cite(<key>)` forms.
pub fn extract_citations(source: &str) -> Vec<String> {
    let mut keys = Vec::new();
    // @key — the standard Typst citation shorthand
    for m in at_cite_re().find_iter(source) {
        let s = m.as_str();
        keys.push(s[1..].to_string());
    }
    // #cite(<key>) — the function form
    for cap in cite_func_re().captures_iter(source) {
        if let Some(m) = cap.get(1) {
            keys.push(m.as_str().to_string());
        }
    }
    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    keys
}

fn at_cite_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"@([a-zA-Z][\w:.+-]*)").unwrap())
}

fn cite_func_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"#\s*cite\s*\(\s*<\s*([^>]+)\s*>").unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vault() -> PathBuf {
        PathBuf::from("/tmp/vault")
    }

    #[test]
    fn no_inject_when_user_declares() {
        let src = "#import \"/lib.typ\": *\n#bibliography(\"/refs.bib\")\n= Title\n";
        let out = augment(src, &vault(), &vault().join("references.bib"), None);
        assert_eq!(out, src);
    }

    #[test]
    fn injects_at_end() {
        let src = "#import \"/lib.typ\": *\n= Title\n";
        let out = augment(src, &vault(), &vault().join("references.bib"), None);
        assert!(out.contains("#bibliography(\"/references.bib\")"));
        assert!(out.trim_end().ends_with("#bibliography(\"/references.bib\")"));
    }

    #[test]
    fn injects_at_end_when_no_import() {
        let src = "= Title\nbody\n";
        let out = augment(src, &vault(), &vault().join("references.bib"), None);
        assert!(out.trim_end().ends_with("#bibliography(\"/references.bib\")"));
        assert!(out.starts_with("= Title"));
    }

    #[test]
    fn comment_is_not_a_declaration() {
        let src = "// #bibliography(\"/x.bib\")\n= Title\n";
        assert!(!already_declares_bibliography(src));
    }

    #[test]
    fn injects_with_style() {
        let src = "#import \"/lib.typ\": *\n= Title\n";
        let out = augment(src, &vault(), &vault().join("references.bib"), Some("apa"));
        assert!(out.contains("#bibliography(\"/references.bib\", style: \"apa\")"));
    }

    #[test]
    fn extract_at_citations() {
        let src = "As shown by @smith2020 and @jones2021, the result holds.\n";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["smith2020", "jones2021"]);
    }

    #[test]
    fn extract_cite_func() {
        let src = "See #cite(<smith2020>) for details.\n";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["smith2020"]);
    }

    #[test]
    fn extract_deduplicates() {
        let src = "@foo and @bar and @foo again.\n";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["foo", "bar"]);
    }

    #[test]
    fn extract_mixed() {
        let src = "@alpha, #cite(<beta>), @alpha\n";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["alpha", "beta"]);
    }
}
