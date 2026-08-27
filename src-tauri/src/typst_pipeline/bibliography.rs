//! Notebox-default bibliography auto-injection and bib file parsing.
//!
//! Per [TYPST_PIVOT.md](../../TYPST_PIVOT.md) §8 #5 (and the Phase 0 decision
//! recorded in PHASE_0_NOTES.md): if a note doesn't already declare its own
//! `#bibliography(...)` AND the notebox has a default bibliography file, the
//! compile pipeline injects a `#bibliography("/<path>")` directive
//! immediately after the `inkycap-notebox` import line. The on-disk file is
//! never modified — augmentation happens to an in-memory copy that becomes
//! the main source.
//!
//! Phase 6 adds bibliography entry parsing via the `hayagriva` crate, which
//! handles both BibTeX (`.bib`) and Hayagriva YAML (`.yml`) formats.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use regex::Regex;
use serde::Serialize;

use crate::typst_pipeline::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// Names tried in order when no `bibliographyPath` setting is configured.
/// `.bib` (BibTeX) wins over `.yml` (Hayagriva) when both exist; the caller
/// is expected to surface a warning in that case.
const DEFAULT_BIB_FILES: &[&str] = &["references.bib", "references.yml", "references.json"];

/// Resolve which bibliography file (if any) should auto-load for the notebox.
/// `override_path`, when set, comes from `.inkycap/settings.json
/// bibliographyPath` and is treated as notebox-relative.
pub fn detect_default(notebox_root: &Path, override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(rel) = override_path {
        let candidate = notebox_root.join(rel);
        return candidate.exists().then_some(candidate);
    }
    for name in DEFAULT_BIB_FILES {
        let candidate = notebox_root.join(name);
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
///
/// Per CLAUDE.md's Typst-first principle: the obvious native alternative
/// here is to parse with `typst::syntax` and look for a `FuncCall` whose
/// callee is `bibliography`. We deliberately stay at the substring level
/// because this check runs on every save, on user content that may be
/// mid-edit and unparseable. A regex that recognises the call shape gives
/// the right answer on broken source where the AST walk would either fail
/// or omit the call from the tree. `note_rewriter` uses the AST because it
/// rewrites — it can't operate without parsing — but this predicate only
/// needs to *detect*, and the conservative-failure mode (false-positive
/// suppresses injection) is exactly what we want for half-typed input.
pub fn already_declares_bibliography(source: &str) -> bool {
    // Strip line comments (`// ...`) before searching so a `// #bibliography`
    // example in a docstring doesn't trip us. Block comments `/* */` are a
    // niche case in Typst and we ignore them — the false-positive failure
    // mode is preferable.
    let stripped = strip_line_comments(source);
    bib_re().is_match(&stripped)
}

/// Build the augmented source for compile. Returns the input unchanged if
/// there's nothing to inject; otherwise appends a call to the notebox
/// package's [`apply-bibliography`] (a thin wrapper around Typst's own
/// `#bibliography(...)`) at the end of the source. Citation collection in
/// Typst is whole-document, so the appended call is purely about *where*
/// the bibliography list renders — conventionally at the end.
///
/// `style`, when provided, is forwarded as the `style:` argument. Both
/// built-in style names ("apa", "ieee") and CSL paths ("foo.csl",
/// "/styles/foo.csl") flow through identically — Typst itself decides how
/// to interpret the value.
pub fn augment(
    source: &str,
    notebox_root: &Path,
    bibliography: &Path,
    style: Option<&str>,
) -> String {
    if already_declares_bibliography(source) {
        return source.to_string();
    }
    let Ok(rel) = bibliography.strip_prefix(notebox_root) else {
        return source.to_string();
    };
    let typst_path = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let directive = match style {
        Some(s) => format!(
            "#apply-bibliography(\"/{}\", style: \"{}\")\n",
            typst_path, s
        ),
        None => format!("#apply-bibliography(\"/{}\")\n", typst_path),
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
    /// True if the source has user notes/annotations attached. Used by the
    /// "import note text" picker to filter out entries with nothing to show.
    /// Computed once at load time so the picker doesn't pay per-entry SQL
    /// or parse costs.
    pub has_notes: bool,
    /// Extra BibTeX fields (publisher, journal, volume, pages, doi, url, etc.)
    /// captured from Zotero for the exported `.bib` file. Empty for file-based
    /// entries (the user's `.bib` already has all fields).
    #[serde(skip)]
    pub extra_fields: std::collections::HashMap<String, String>,
}

/// A note attached to a bibliography entry.
#[derive(Debug, Clone, Serialize)]
pub struct RefNote {
    pub content: String,
}

/// Cached parse output: entries for the picker plus per-key notes. Both come
/// from a single parse pass so the picker and the note importer don't pay
/// the parse cost twice.
#[derive(Debug, Clone)]
struct ParsedBibliography {
    entries: Vec<BibEntry>,
    /// Aligned by index with `entries`. Notes are pre-extracted because the
    /// underlying `biblatex::Bibliography` / `hayagriva::Library` are
    /// non-`Send`/non-`Clone` and can't live in the cache directly.
    notes: Vec<Vec<RefNote>>,
    /// Count of entries skipped because of conversion/type errors. Surfaced
    /// to the UI so users notice silent data loss.
    skipped_entries: u32,
}

#[derive(Debug)]
struct CacheKey {
    path: PathBuf,
    mtime: SystemTime,
    size: u64,
}

#[derive(Debug)]
struct CacheSlot {
    key: CacheKey,
    parsed: ParsedBibliography,
}

fn parse_cache() -> &'static Mutex<Option<CacheSlot>> {
    static CACHE: OnceLock<Mutex<Option<CacheSlot>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Skip count from the most recent parse. UI polls this to surface a
/// "loaded N of M" notice when entries were dropped due to type errors.
pub fn last_parse_skipped_count() -> u32 {
    parse_cache()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.parsed.skipped_entries))
        .unwrap_or(0)
}

/// Load the parsed bibliography for `path`, using an mtime+size keyed cache.
/// The cache holds a single slot — noteboxes have one active bibliography file
/// at a time, and an LRU would just add bookkeeping.
fn load_cached(path: &Path) -> Result<ParsedBibliography, String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("Failed to stat bibliography file: {e}"))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("Failed to read bibliography mtime: {e}"))?;
    let size = meta.len();

    {
        let guard = parse_cache()
            .lock()
            .map_err(|e| format!("Cache poisoned: {e}"))?;
        if let Some(slot) = guard.as_ref() {
            if slot.key.path == path && slot.key.mtime == mtime && slot.key.size == size {
                return Ok(slot.parsed.clone());
            }
        }
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read bibliography file: {e}"))?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let parsed = match ext {
        "bib" => parse_bibtex(&content)?,
        "yml" | "yaml" => parse_hayagriva(&content)?,
        "json" => parse_csl_json(&content)?,
        _ => return Err(format!("Unsupported bibliography format: .{ext}")),
    };

    if let Ok(mut guard) = parse_cache().lock() {
        *guard = Some(CacheSlot {
            key: CacheKey {
                path: path.to_path_buf(),
                mtime,
                size,
            },
            parsed: parsed.clone(),
        });
    }
    Ok(parsed)
}

/// Parse a bibliography file (`.bib`, `.yml`, or CSL JSON `.json`).
pub fn parse_bibliography(path: &Path) -> Result<Vec<BibEntry>, String> {
    Ok(load_cached(path)?.entries)
}

/// Extract notes from a parsed bibliography for the given key. Reuses the
/// cached parse from `parse_bibliography` so a `RefNotePicker` open after
/// the picker pays nothing.
pub fn get_entry_notes(path: &Path, key: &str) -> Result<Vec<RefNote>, String> {
    let parsed = load_cached(path)?;
    let idx = parsed.entries.iter().position(|e| e.key == key);
    Ok(idx.map(|i| parsed.notes[i].clone()).unwrap_or_default())
}

fn parse_bibtex(content: &str) -> Result<ParsedBibliography, String> {
    let bib =
        biblatex::Bibliography::parse(content).map_err(|e| format!("BibTeX parse error: {e}"))?;
    let mut entries = Vec::new();
    let mut notes = Vec::new();
    let mut skipped: u32 = 0;
    for raw in bib.iter() {
        // Pull annotation/annote/note as raw fields before the hayagriva
        // conversion — Zotero's BibTeX export puts user annotations in
        // `annotation` (not `note`, which carries bibliographic provenance
        // like "Online resource"), and biblatex+hayagriva's `Entry::note()`
        // only surfaces `note`.
        let entry_notes = collect_bibtex_notes(raw);

        let converted: Result<hayagriva::Entry, _> = raw.try_into();
        match converted {
            Ok(entry) => {
                let title = entry.title().map(|t| t.to_string()).unwrap_or_default();
                let authors = entry
                    .authors()
                    .map(|persons| persons.iter().map(|p| p.name_first(false, false)).collect())
                    .unwrap_or_default();
                let year = entry.date_any().map(|d| d.year.to_string());
                let entry_type = format!("{:?}", entry.entry_type());
                entries.push(BibEntry {
                    key: entry.key().to_string(),
                    title,
                    authors,
                    year,
                    entry_type,
                    zotero_item_key: None,
                    has_notes: !entry_notes.is_empty(),
                    extra_fields: std::collections::HashMap::new(),
                });
                notes.push(entry_notes);
            }
            Err(e) => {
                log::warn!("Skipping BibTeX entry {:?}: {e}", raw.key);
                skipped += 1;
            }
        }
    }
    if skipped > 0 {
        log::warn!(
            "Skipped {skipped} BibTeX entries with type errors; loaded {} entries",
            entries.len()
        );
    }
    Ok(ParsedBibliography {
        entries,
        notes,
        skipped_entries: skipped,
    })
}

/// Pull user-note fields (`annotation`, `annote`, `note`) from a raw biblatex
/// entry. Zotero exports stash user annotations in `annotation`; classic
/// BibTeX uses `annote`; `note` is the standard bibliographic-note field.
/// Returned in priority order so the most-useful note is first.
fn collect_bibtex_notes(raw: &biblatex::Entry) -> Vec<RefNote> {
    use biblatex::ChunksExt;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for field in ["annotation", "annote", "note"] {
        if let Some(chunks) = raw.fields.get(field) {
            let text = chunks.format_verbatim();
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
                out.push(RefNote { content: trimmed });
            }
        }
    }
    out
}

fn parse_hayagriva(content: &str) -> Result<ParsedBibliography, String> {
    let library = hayagriva::io::from_yaml_str(content)
        .map_err(|e| format!("Hayagriva YAML parse error: {e}"))?;
    let (entries, notes) = hayagriva_to_entries(&library);
    Ok(ParsedBibliography {
        entries,
        notes,
        skipped_entries: 0,
    })
}

fn hayagriva_to_entries(library: &hayagriva::Library) -> (Vec<BibEntry>, Vec<Vec<RefNote>>) {
    let mut entries = Vec::new();
    let mut notes = Vec::new();
    for entry in library.iter() {
        let title = entry.title().map(|t| t.to_string()).unwrap_or_default();
        let authors = entry
            .authors()
            .map(|persons| persons.iter().map(|p| p.name_first(false, false)).collect())
            .unwrap_or_default();
        let year = entry.date_any().map(|d| d.year.to_string());
        let entry_type = format!("{:?}", entry.entry_type());
        let mut entry_notes = Vec::new();
        if let Some(note) = entry.note() {
            let text = note.to_string();
            if !text.trim().is_empty() {
                entry_notes.push(RefNote { content: text });
            }
        }
        let has_notes = !entry_notes.is_empty();
        entries.push(BibEntry {
            key: entry.key().to_string(),
            title,
            authors,
            year,
            entry_type,
            zotero_item_key: None,
            has_notes,
            extra_fields: std::collections::HashMap::new(),
        });
        notes.push(entry_notes);
    }
    (entries, notes)
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
    note: Option<String>,
    annotation: Option<String>,
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

fn parse_csl_json(content: &str) -> Result<ParsedBibliography, String> {
    let csl_entries: Vec<CslJsonEntry> =
        serde_json::from_str(content).map_err(|e| format!("CSL JSON parse error: {e}"))?;

    let mut entries = Vec::new();
    let mut notes = Vec::new();
    for e in csl_entries {
        let authors = e
            .author
            .unwrap_or_default()
            .into_iter()
            .map(|n| match (n.family, n.given) {
                (Some(f), Some(g)) => format!("{f}, {g}"),
                (Some(f), None) => f,
                (None, Some(g)) => g,
                (None, None) => String::new(),
            })
            .filter(|s| !s.is_empty())
            .collect();

        let year = e
            .issued
            .and_then(|d| {
                d.date_parts.and_then(|parts| {
                    parts.first().and_then(|p| {
                        p.first().map(|v| match v {
                            serde_json::Value::Number(n) => n.to_string(),
                            serde_json::Value::String(s) => s.clone(),
                            _ => String::new(),
                        })
                    })
                })
            })
            .filter(|s| !s.is_empty());

        let mut entry_notes = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for text in [e.annotation, e.note].into_iter().flatten() {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
                entry_notes.push(RefNote { content: trimmed });
            }
        }

        let has_notes = !entry_notes.is_empty();
        entries.push(BibEntry {
            key: e.id,
            title: e.title.unwrap_or_default(),
            authors,
            year,
            entry_type: e.entry_type.unwrap_or_else(|| "unknown".to_string()),
            zotero_item_key: None,
            has_notes,
            extra_fields: std::collections::HashMap::new(),
        });
        notes.push(entry_notes);
    }
    Ok(ParsedBibliography {
        entries,
        notes,
        skipped_entries: 0,
    })
}

/// Sanitize a BibTeX field value for safe embedding inside `{...}`.
///
/// - Collapses newlines to single spaces (multi-line values with `@` at
///   the start of a continuation line confuse hayagriva's parser).
/// - Escapes unbalanced `{` / `}` so the entry structure stays intact.
fn sanitize_bibtex_value(value: &str) -> std::borrow::Cow<'_, str> {
    let needs_newline_fix = value.contains('\n');
    let has_braces = value.contains('{') || value.contains('}');

    if !needs_newline_fix && !has_braces {
        return std::borrow::Cow::Borrowed(value);
    }

    let mut result = if needs_newline_fix {
        // Collapse runs of whitespace (including newlines) to single spaces.
        let mut s = String::with_capacity(value.len());
        let mut prev_ws = false;
        for c in value.chars() {
            if c.is_whitespace() {
                if !prev_ws {
                    s.push(' ');
                }
                prev_ws = true;
            } else {
                s.push(c);
                prev_ws = false;
            }
        }
        s
    } else {
        value.to_string()
    };

    if has_braces {
        let mut depth: i32 = 0;
        let mut safe = true;
        for c in result.chars() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth < 0 {
                        safe = false;
                        break;
                    }
                }
                _ => {}
            }
        }
        if depth != 0 {
            safe = false;
        }
        if !safe {
            result = result.replace('{', r"\{").replace('}', r"\}");
        }
    }

    std::borrow::Cow::Owned(result)
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
            out.push_str(&format!(
                "  title = {{{}}},\n",
                sanitize_bibtex_value(&entry.title)
            ));
        }
        if !entry.authors.is_empty() {
            let authors = entry.authors.join(" and ");
            out.push_str(&format!(
                "  author = {{{}}},\n",
                sanitize_bibtex_value(&authors)
            ));
        }
        if let Some(ref year) = entry.year {
            out.push_str(&format!("  year = {{{}}},\n", year));
        }
        // `extra_fields` is a HashMap, whose iteration order is randomized per
        // process run. Emit fields in a stable (alphabetical) order so the
        // exported .bib is byte-for-byte deterministic — otherwise every
        // re-export reshuffles every entry, churning the working tree (spurious
        // "dirty" state, needless commits) and turning the shared bibliography
        // into a perpetual merge-conflict source under collaboration.
        let mut fields: Vec<(&String, &String)> = entry.extra_fields.iter().collect();
        fields.sort_by(|a, b| a.0.cmp(b.0));
        for (field, value) in fields {
            if !value.is_empty() {
                out.push_str(&format!(
                    "  {} = {{{}}},\n",
                    field,
                    sanitize_bibtex_value(value)
                ));
            }
        }
        out.push_str("}\n\n");
    }
    out
}

/// Write a Zotero export BibTeX file to `.inkycap/zotero-export.bib` inside the
/// notebox. Returns the notebox-relative path suitable for `bibliography_override`.
pub fn write_zotero_export(notebox_root: &Path, entries: &[BibEntry]) -> Result<String, String> {
    let inkycap_dir = notebox_root.join(".inkycap");
    std::fs::create_dir_all(&inkycap_dir)
        .map_err(|e| format!("Failed to create .inkycap directory: {e}"))?;
    let bib_path = inkycap_dir.join("zotero-export.bib");
    let content = export_entries_to_bibtex(entries);
    std::fs::write(&bib_path, &content)
        .map_err(|e| format!("Failed to write zotero-export.bib: {e}"))?;
    Ok("/.inkycap/zotero-export.bib".to_string())
}

/// Write `entries` as a BibTeX file at `rel_path` (notebox-root-relative, with
/// or without a leading `/`) inside the notebox, creating parent dirs as needed.
/// Used to materialize a collection's cited-works bibliography fresh at export
/// so a template's `bibliography("…")` argument resolves to current data.
/// Returns the leading-slash notebox-relative path written. Rejects any path
/// that would escape the notebox root.
pub fn write_bibliography_file(
    notebox_root: &Path,
    rel_path: &str,
    entries: &[BibEntry],
) -> Result<String, String> {
    let trimmed = rel_path.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return Err("empty bibliography path".to_string());
    }
    // Only normal path components — reject `..`, absolute, and drive prefixes so
    // the write stays within the notebox.
    let mut safe = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            std::path::Component::Normal(seg) => safe.push(seg),
            std::path::Component::CurDir => {}
            _ => return Err(format!("unsafe bibliography path: {rel_path}")),
        }
    }
    let abs = notebox_root.join(&safe);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create bibliography directory: {e}"))?;
    }
    let content = export_entries_to_bibtex(entries);
    std::fs::write(&abs, &content)
        .map_err(|e| format!("Failed to write bibliography file: {e}"))?;
    Ok(format!("/{}", safe.to_string_lossy().replace('\\', "/")))
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
/// `#cite(<key>)` forms. Skips escaped `\@` and `@` inside backtick
/// code spans (inline `` `...` `` and fenced `` ```...``` ``).
pub fn extract_citations(source: &str) -> Vec<String> {
    let stripped = strip_code_spans(source);
    let mut keys = Vec::new();
    // @key — the standard Typst citation shorthand
    for m in at_cite_re().find_iter(&stripped) {
        let s = m.as_str();
        keys.push(s[1..].to_string());
    }
    // #cite(<key>) — the function form
    for cap in cite_func_re().captures_iter(&stripped) {
        if let Some(m) = cap.get(1) {
            keys.push(m.as_str().to_string());
        }
    }
    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    keys
}

/// Replace code spans, string literals, and escaped `@` with whitespace
/// so the citation regexes don't match inside them. Handles:
/// - fenced code blocks (```...```, with any number of backticks ≥ 3)
/// - inline raw spans (`...`, with any number of backticks)
/// - Typst string literals ("...")
/// - escaped at-signs (`\@`)
fn strip_code_spans(source: &str) -> String {
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut out = source.to_string().into_bytes();
    let mut i = 0;
    while i < len {
        if bytes[i] == b'\\' && i + 1 < len && bytes[i + 1] == b'@' {
            out[i] = b' ';
            out[i + 1] = b' ';
            i += 2;
            continue;
        }
        // Typst string literals: "..." (with backslash escapes inside)
        if bytes[i] == b'"' {
            let start = i;
            i += 1;
            while i < len {
                if bytes[i] == b'\\' && i + 1 < len {
                    i += 2; // skip escaped character
                } else if bytes[i] == b'"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            out[start..i.min(len)].fill(b' ');
            continue;
        }
        if bytes[i] == b'`' {
            let tick_start = i;
            let mut tick_count = 0;
            while i < len && bytes[i] == b'`' {
                tick_count += 1;
                i += 1;
            }
            // Find matching closing backtick sequence of the same length
            let closing = std::str::from_utf8(&bytes[i..]).ok().and_then(|rest| {
                let needle: String = (0..tick_count).map(|_| '`').collect();
                rest.find(&needle).map(|pos| pos + i)
            });
            if let Some(close_start) = closing {
                let end = close_start + tick_count;
                out[tick_start..end.min(len)].fill(b' ');
                i = end;
            }
            // No closing found — the ticks are literal; leave i advanced past them
            continue;
        }
        i += 1;
    }
    // Safety: we only replaced ASCII bytes with ASCII spaces
    String::from_utf8(out).unwrap_or_else(|_| source.to_string())
}

/// Escape references whose target resolves to neither a bibliography entry
/// nor a label defined in the document, so Typst renders them as literal
/// text instead of erroring on an unknown reference. The motivating case is
/// an email address: Typst parses the `@domain` in `user@domain.com` as a
/// reference, and without a `<domain>` label it would fail to compile.
///
/// Per CLAUDE.md's Typst-first principle this walks the real `typst::syntax`
/// AST rather than scanning with a regex. That matters for correctness, not
/// just style: only genuine `Ref` nodes are considered, so an `@` inside a
/// string literal, code span, or comment is never touched — the parser
/// already excluded it — and, crucially, a legitimate `@intro` pointing at a
/// `= Heading <intro>` is recognized as a label reference and left alone.
/// The previous regex compared only against `valid_keys` (bibliography
/// keys), so it silently rewrote every cross-reference to a heading, figure,
/// or equation into `\@...` whenever a bibliography was present — breaking
/// the reference in the rendered output.
///
/// An `@` attached to a preceding word character (an email or handle, e.g.
/// `athena@inkycap.org`) is always escaped, even with no bibliography loaded:
/// Typst never parses a citation mid-word, so such an `@` cannot be a real
/// citation. A *standalone* unresolved `@key` is only escaped when
/// `valid_keys` is non-empty; with none loaded it may be a transiently
/// unresolved citation and is left untouched.
pub fn escape_invalid_citations(
    source: &str,
    valid_keys: &std::collections::HashSet<String>,
) -> String {
    let root = parse(source);
    let link = LinkedNode::new(&root);

    // Phase 1: collect every label defined anywhere in the document and the
    // byte position + target of every reference. A label can be defined *after*
    // the reference that points at it (`@intro` … `= Heading <intro>`), so the
    // whole document must be seen before deciding which references are unresolved.
    let mut labels: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut refs: Vec<(usize, String)> = Vec::new();
    collect_refs_and_labels(&link, &mut labels, &mut refs);
    if refs.is_empty() {
        return source.to_string();
    }

    // Phase 2: a reference is valid when its target is a bibliography key or a
    // label defined in this document; anything else (an email's `@domain`, a
    // typo) is escaped by inserting a backslash before its `@`.
    refs.sort_by_key(|(pos, _)| *pos);
    let bytes = source.as_bytes();
    let mut out = Vec::with_capacity(source.len() + 16);
    let mut last = 0;
    for (pos, target) in &refs {
        // A reference whose target is a real bibliography key or a label
        // defined in this document is genuine — leave it untouched whether or
        // not it's attached to a preceding word.
        if valid_keys.contains(target) || labels.contains(target) {
            continue;
        }
        // Typst only ever parses a citation or cross-reference at a word
        // boundary, so an `@` sitting directly after a letter or digit —
        // `athena@inkycap.org` — is never a citation and is always safe to
        // render literally, regardless of whether a bibliography is loaded.
        // This mirrors the visual editor's email heuristic (the `attached`
        // branch in `visual-plugin.ts`) so the two paths agree. UTF-8-safe:
        // `*pos` is the byte offset of the ASCII `@`, so slicing to it lands on
        // a char boundary and `next_back()` yields the whole preceding char.
        let attached_to_word = source[..*pos]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric());
        // A *standalone* stray `@` is only escaped when we have keys to compare
        // against. With none loaded (a failed or not-yet-loaded bibliography)
        // we can't tell a real, transiently-unresolved citation from a typo, so
        // we leave it — the original guard's rationale, now scoped to this
        // ambiguous case instead of aborting the whole pass and letting stray
        // emails through.
        if !attached_to_word && valid_keys.is_empty() {
            continue;
        }
        out.extend_from_slice(&bytes[last..*pos]);
        out.push(b'\\');
        last = *pos;
    }
    if last == 0 {
        return source.to_string();
    }
    out.extend_from_slice(&bytes[last..]);
    String::from_utf8(out).unwrap_or_else(|_| source.to_string())
}

/// Recursively gather every `<label>` definition and `@target` reference in
/// the parsed AST. Labels go into `labels`; references are recorded as
/// `(byte position of the `@`, target string)`.
fn collect_refs_and_labels(
    node: &LinkedNode<'_>,
    labels: &mut std::collections::HashSet<String>,
    refs: &mut Vec<(usize, String)>,
) {
    match node.kind() {
        SyntaxKind::Label => {
            if let Some(label) = node.cast::<ast::Label>() {
                labels.insert(label.get().to_string());
            }
        }
        SyntaxKind::Ref => {
            if let Some(reference) = node.cast::<ast::Ref>() {
                refs.push((node.range().start, reference.target().to_string()));
            }
        }
        _ => {}
    }
    for child in node.children() {
        collect_refs_and_labels(&child, labels, refs);
    }
}

fn at_cite_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"@([a-zA-Z][\w:.+-]*)").unwrap())
}

fn cite_func_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"#\s*cite\s*\(\s*<\s*([^>]+)\s*>").unwrap())
}

// ---------------------------------------------------------------------------
// Static bibliography rendering (the "copy formatted bibliography" feature).
//
// A live `#bibliography(...)` is resolved at compile time against the whole
// document's citations. This path produces the *opposite*: a frozen Typst-
// markup snapshot of the references cited in one note, formatted in the user's
// citation style, that can be pasted into any other note and render identically
// without re-running citation resolution.
//
// Per CLAUDE.md's Typst-first principle: Typst's own `#bibliography` is driven
// by hayagriva, and that is exactly what we call here — we do not hand-format
// references. The only thing Typst can't natively give us is a *static* render
// of a live bibliography, which is the whole reason this code exists. We map
// hayagriva's rendered `ElemChild` formatting tree onto the equivalent Typst
// markup (`_italic_`, `*bold*`, `#super[...]`, `#smallcaps[...]`,
// `#underline[...]`, `#link(...)`), so the pasted output carries the same
// emphasis the compiled bibliography would.
// ---------------------------------------------------------------------------

/// Parse a bibliography file into a hayagriva [`Library`](hayagriva::Library)
/// for rendering. Unlike [`parse_bibliography`], which returns display-only
/// [`BibEntry`] rows, this keeps the full hayagriva entries that the CSL
/// renderer needs.
pub fn load_library(path: &Path) -> Result<hayagriva::Library, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read bibliography file: {e}"))?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    match ext {
        "bib" => parse_library_bibtex(&content),
        "yml" | "yaml" => hayagriva::io::from_yaml_str(&content)
            .map_err(|e| format!("Hayagriva YAML parse error: {e}")),
        // CSL JSON has no native hayagriva reader; the live `#bibliography`
        // path doesn't support it as a render source either, so we surface a
        // clear error rather than silently dropping fields.
        "json" => {
            Err("CSL JSON bibliographies can't be rendered to static Typst markup yet".to_string())
        }
        _ => Err(format!("Unsupported bibliography format: .{ext}")),
    }
}

/// Parse a BibTeX string into a hayagriva [`Library`](hayagriva::Library).
/// Used for the Zotero source, which is materialized as BibTeX first (the same
/// shape the live compile pipeline feeds Typst).
pub fn parse_library_bibtex(content: &str) -> Result<hayagriva::Library, String> {
    hayagriva::io::from_biblatex_str(content).map_err(|errs| {
        let joined = errs
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        format!("BibTeX parse error: {joined}")
    })
}

/// Resolve the CSL style to render with, mirroring the live compile pipeline's
/// precedence (see `NoteboxSession::open_notebox_fast`): a per-notebox custom
/// `.csl` file wins, otherwise the user-global named style, defaulting to
/// `chicago-author-date`.
pub fn resolve_style(
    notebox_root: &Path,
    custom_csl_path: Option<&str>,
    style_name: Option<&str>,
) -> Result<hayagriva::citationberg::IndependentStyle, String> {
    use hayagriva::citationberg::{IndependentStyle, Style};

    if let Some(rel) = custom_csl_path.filter(|s| !s.is_empty()) {
        // `custom_csl_path` is notebox-root-absolute (`/styles/foo.csl`); join
        // strips the leading slash so it resolves under the notebox.
        let path = notebox_root.join(rel.trim_start_matches('/'));
        let xml = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read CSL style file: {e}"))?;
        return IndependentStyle::from_xml(&xml).map_err(|e| format!("Invalid CSL style: {e}"));
    }

    let name = style_name
        .filter(|s| !s.is_empty() && *s != "custom")
        .unwrap_or("chicago-author-date");
    let archived = hayagriva::archive::ArchivedStyle::by_name(name)
        .or_else(|| hayagriva::archive::ArchivedStyle::by_name("chicago-author-date"))
        .ok_or_else(|| format!("Unknown citation style: {name}"))?;
    match archived.get() {
        Style::Independent(s) => Ok(s),
        Style::Dependent(_) => Err(format!(
            "Citation style '{name}' is a dependent style and can't render a bibliography directly"
        )),
    }
}

/// Render the references for `keys` as static Typst markup, formatted with the
/// given CSL `style`. Returns one paragraph per reference (blank-line
/// separated), in the style's own sort order. Keys not present in `library`
/// (e.g. typos or non-bibliographic `@`-tokens) are skipped. Returns an empty
/// string when no key resolves to an entry.
pub fn render_cited_bibliography(
    library: &hayagriva::Library,
    keys: &[String],
    style: &hayagriva::citationberg::IndependentStyle,
) -> Result<String, String> {
    use hayagriva::{BibliographyDriver, BibliographyRequest, CitationItem, CitationRequest};

    let locales = hayagriva::archive::locales();

    let mut driver = BibliographyDriver::new();
    let mut any = false;
    for key in keys {
        if let Some(entry) = library.get(key) {
            any = true;
            driver.citation(CitationRequest::from_items(
                vec![CitationItem::with_entry(entry)],
                style,
                &locales,
            ));
        }
    }
    if !any {
        return Ok(String::new());
    }

    let rendered = driver.finish(BibliographyRequest {
        style,
        locale: None,
        locale_files: &locales,
    });

    let Some(bib) = rendered.bibliography else {
        return Err("The selected citation style does not define a bibliography".to_string());
    };

    let mut paragraphs = Vec::with_capacity(bib.items.len());
    for item in &bib.items {
        let mut para = String::new();
        // Numeric styles (IEEE, Vancouver) split the leading label into
        // `first_field`; author-date styles leave it `None`.
        if let Some(first) = &item.first_field {
            elem_child_to_typst(first, &mut para);
            para.push(' ');
        }
        elem_children_to_typst(&item.content, &mut para);
        let trimmed = para.trim();
        if !trimmed.is_empty() {
            paragraphs.push(trimmed.to_string());
        }
    }
    Ok(paragraphs.join("\n\n"))
}

fn elem_children_to_typst(children: &hayagriva::ElemChildren, out: &mut String) {
    for child in &children.0 {
        elem_child_to_typst(child, out);
    }
}

fn elem_child_to_typst(child: &hayagriva::ElemChild, out: &mut String) {
    use hayagriva::ElemChild;
    match child {
        ElemChild::Text(formatted) => {
            out.push_str(&wrap_formatting(
                &escape_typst_markup(&formatted.text),
                &formatted.formatting,
            ));
        }
        // Block-vs-inline display only matters for hanging indents in the
        // rendered list; inside a single pasted reference we keep everything on
        // one paragraph, so recurse inline regardless of `display`.
        ElemChild::Elem(elem) => elem_children_to_typst(&elem.children, out),
        // hayagriva's contract: `Markup` is already Typst markup — emit verbatim.
        ElemChild::Markup(markup) => out.push_str(markup),
        ElemChild::Link { text, url } => {
            // hayagriva commonly emits a URL's leading portion as plain text
            // (e.g. a `https://doi.org/` DOI prefix) immediately followed by a
            // Link whose `url` is that prefix plus the link's display text.
            // Emitted as-is, Typst auto-links the bare-URL prefix into a
            // *separate, truncated* link sitting next to ours. Re-absorb such a
            // prefix into this single link so the whole URL is one clean link.
            let mut display = text.text.clone();
            if let Some(prefix) = url.strip_suffix(&text.text) {
                let escaped_prefix = escape_typst_markup(prefix);
                if !escaped_prefix.is_empty() && out.ends_with(&escaped_prefix) {
                    out.truncate(out.len() - escaped_prefix.len());
                    display = format!("{prefix}{}", text.text);
                }
            }

            out.push_str("#link(\"");
            out.push_str(&escape_typst_string(url));
            out.push('"');
            if display == *url {
                // Body identical to the destination: Typst renders the URL as
                // the link text on its own. Omitting the body also avoids a
                // nested auto-link firing on a bare URL inside `[...]`.
                out.push(')');
            } else {
                out.push_str(")[");
                out.push_str(&wrap_formatting(
                    &escape_typst_markup(&display),
                    &text.formatting,
                ));
                out.push(']');
            }
        }
        // Only emitted for in-text citations, never in a bibliography list.
        ElemChild::Transparent { .. } => {}
    }
}

/// Wrap already-escaped `text` in the Typst markup equivalent to hayagriva's
/// resolved [`Formatting`](hayagriva::Formatting). Whitespace-only runs are left
/// bare so we don't emit empty `_ _` / `*  *` artifacts.
fn wrap_formatting(text: &str, fmt: &hayagriva::Formatting) -> String {
    use hayagriva::citationberg::{
        FontStyle, FontVariant, FontWeight, TextDecoration, VerticalAlign,
    };

    if text.trim().is_empty() {
        return text.to_string();
    }

    let mut s = text.to_string();
    match fmt.vertical_align {
        VerticalAlign::Sup => s = format!("#super[{s}]"),
        VerticalAlign::Sub => s = format!("#sub[{s}]"),
        _ => {}
    }
    if fmt.font_variant == FontVariant::SmallCaps {
        s = format!("#smallcaps[{s}]");
    }
    if fmt.text_decoration == TextDecoration::Underline {
        s = format!("#underline[{s}]");
    }
    if fmt.font_weight == FontWeight::Bold {
        s = format!("*{s}*");
    }
    if fmt.font_style == FontStyle::Italic {
        s = format!("_{s}_");
    }
    s
}

/// Escape the characters that carry markup meaning in Typst content mode, so a
/// rendered reference string becomes literal text. Hyphens, periods, commas,
/// and parentheses are intentionally left alone — they're common in citations
/// and benign in markup.
fn escape_typst_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '*' | '_' | '`' | '$' | '#' | '<' | '>' | '@' | '[' | ']'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escape a string for embedding inside a Typst `"..."` string literal.
fn escape_typst_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn notebox() -> PathBuf {
        PathBuf::from("/tmp/notebox")
    }

    /// The exported BibTeX must be byte-for-byte deterministic regardless of the
    /// (randomized) HashMap iteration order of `extra_fields` — otherwise the
    /// committed `.inkycap/zotero-export.bib` churns on every re-export, which
    /// surfaced as spurious extra commits and would be a perpetual merge
    /// conflict under git collaboration. Fields come out alphabetically sorted.
    #[test]
    fn bibtex_export_is_deterministic_and_fields_sorted() {
        let mut extra = std::collections::HashMap::new();
        extra.insert("volume".to_string(), "12".to_string());
        extra.insert("doi".to_string(), "10.1/abc".to_string());
        extra.insert("journal".to_string(), "Nature".to_string());
        extra.insert("language".to_string(), "en".to_string());
        let entry = BibEntry {
            key: "smith2020".to_string(),
            title: "A Title".to_string(),
            authors: vec!["Smith, Jane".to_string()],
            year: Some("2020".to_string()),
            entry_type: "journalArticle".to_string(),
            zotero_item_key: None,
            has_notes: false,
            extra_fields: extra,
        };

        let out = export_entries_to_bibtex(std::slice::from_ref(&entry));
        // Stable across runs (different HashMap seeds) within this process at
        // least, and the extra fields are alphabetical: doi, journal, language,
        // volume — after the fixed title/author/year.
        assert_eq!(
            out,
            "@article{smith2020,\n  \
             title = {A Title},\n  \
             author = {Smith, Jane},\n  \
             year = {2020},\n  \
             doi = {10.1/abc},\n  \
             journal = {Nature},\n  \
             language = {en},\n  \
             volume = {12},\n}\n\n"
        );
        // Re-exporting yields identical bytes.
        assert_eq!(out, export_entries_to_bibtex(std::slice::from_ref(&entry)));
    }

    #[test]
    fn write_bibliography_file_creates_nested_path_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let entry = BibEntry {
            key: "smith2020".to_string(),
            title: "A Title".to_string(),
            authors: vec!["Smith, Jane".to_string()],
            year: Some("2020".to_string()),
            entry_type: "journalArticle".to_string(),
            zotero_item_key: None,
            has_notes: false,
            extra_fields: std::collections::HashMap::new(),
        };
        // Leading-slash, nested path → created under the notebox; returns the
        // normalized leading-slash form.
        let rel =
            write_bibliography_file(root, "/.inkycap/collection-bibs/Foo.bib", &[entry]).unwrap();
        assert_eq!(rel, "/.inkycap/collection-bibs/Foo.bib");
        let written =
            std::fs::read_to_string(root.join(".inkycap/collection-bibs/Foo.bib")).unwrap();
        assert!(written.contains("@article{smith2020,"));
        // Traversal is rejected; nothing escapes the notebox.
        assert!(write_bibliography_file(root, "../escape.bib", &[]).is_err());
        assert!(write_bibliography_file(root, "/../escape.bib", &[]).is_err());
    }

    #[test]
    fn no_inject_when_user_declares() {
        let src = "#import \"/lib.typ\": *\n#bibliography(\"/refs.bib\")\n= Title\n";
        let out = augment(src, &notebox(), &notebox().join("references.bib"), None);
        assert_eq!(out, src);
    }

    #[test]
    fn injects_at_end() {
        let src = "#import \"/lib.typ\": *\n= Title\n";
        let out = augment(src, &notebox(), &notebox().join("references.bib"), None);
        assert!(out.contains("#apply-bibliography(\"/references.bib\")"));
        assert!(out
            .trim_end()
            .ends_with("#apply-bibliography(\"/references.bib\")"));
    }

    #[test]
    fn injects_at_end_when_no_import() {
        let src = "= Title\nbody\n";
        let out = augment(src, &notebox(), &notebox().join("references.bib"), None);
        assert!(out
            .trim_end()
            .ends_with("#apply-bibliography(\"/references.bib\")"));
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
        let out = augment(
            src,
            &notebox(),
            &notebox().join("references.bib"),
            Some("apa"),
        );
        assert!(out.contains("#apply-bibliography(\"/references.bib\", style: \"apa\")"));
    }

    /// Our injected wrapper must not be detected as a user-declared
    /// `#bibliography(...)` call — otherwise re-augmenting an already
    /// augmented source would short-circuit and we'd lose the directive
    /// through some pipelines (export → reuse). The detection regex matches
    /// `#bibliography(` only; `#apply-bibliography(` slips through, which is
    /// what we want for our own emission, but we also lock down the inverse:
    /// if a user calls Typst's bibliography directly, we still detect it.
    #[test]
    fn user_bibliography_call_is_detected() {
        let src = "#bibliography(\"/x.bib\")\n";
        assert!(already_declares_bibliography(src));
    }

    #[test]
    fn our_apply_bibliography_call_is_not_misdetected() {
        let src = "#apply-bibliography(\"/x.bib\")\n";
        assert!(!already_declares_bibliography(src));
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

    #[test]
    fn extract_skips_escaped_at() {
        let src = r"Real @smith2020, escaped \@notacite, also @jones2021";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["smith2020", "jones2021"]);
    }

    #[test]
    fn extract_skips_inline_code() {
        let src = "See @real but `@inside_ticks` is code and @also_real";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["real", "also_real"]);
    }

    #[test]
    fn extract_skips_fenced_code() {
        let src = "```\n@codeblock\n```\n@outside\n";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["outside"]);
    }

    #[test]
    fn extract_skips_double_backtick_code() {
        let src = "``@inner`` and @outer";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["outer"]);
    }

    #[test]
    fn extract_skips_escaped_email() {
        let src = r"nailisa.tanner\@mcgill.ca and @real_cite";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["real_cite"]);
    }

    #[test]
    fn extract_preserves_normal_citations() {
        let src = "@a @b #cite(<c>)";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["a", "b", "c"]);
    }

    #[test]
    fn escape_invalid_keeps_valid_citations() {
        let valid: std::collections::HashSet<String> =
            ["smith2020"].iter().map(|s| s.to_string()).collect();
        let src = "See @smith2020 and paulgott9@gmail.com for details.";
        let out = escape_invalid_citations(src, &valid);
        assert!(out.contains("@smith2020"));
        assert!(out.contains(r"\@gmail"));
        assert!(!out.contains(" @gmail"));
    }

    #[test]
    fn escape_invalid_no_bib_leaves_standalone_refs_untouched() {
        // A *standalone* `@ref` (preceded by whitespace) with no bibliography
        // loaded is ambiguous — it may be a transiently unresolved citation, so
        // it is left untouched.
        let valid: std::collections::HashSet<String> = std::collections::HashSet::new();
        let src = "Contact @someone and @other";
        let out = escape_invalid_citations(src, &valid);
        assert_eq!(out, src);
    }

    #[test]
    fn escape_email_without_bibliography() {
        // The motivating export bug: an email in a note with no bibliography.
        // Its `@domain` is attached to a preceding word, so Typst can never
        // parse it as a citation — it must be escaped even with an empty key
        // set, or a strict export compile fails on `label <inkycap.org> does
        // not exist`. (The reading view masked this via error recovery.)
        let valid: std::collections::HashSet<String> = std::collections::HashSet::new();
        let src = "e-mail: athena@inkycap.org";
        let out = escape_invalid_citations(src, &valid);
        assert_eq!(out, r"e-mail: athena\@inkycap.org");
    }

    #[test]
    fn escape_preserves_string_literals() {
        let valid: std::collections::HashSet<String> =
            ["smith2020"].iter().map(|s| s.to_string()).collect();
        let src = r#"@smith2020 #bibliography("/user@host/refs.bib")"#;
        let out = escape_invalid_citations(src, &valid);
        // @smith2020 is valid, @host is inside a string literal — neither should be escaped
        assert_eq!(out, src);
    }

    #[test]
    fn escape_keeps_label_reference_when_bibliography_present() {
        // Regression: a cross-reference to a heading/figure/equation label must
        // survive even when a bibliography is loaded. Before the AST rewrite,
        // `@intro` was escaped to `\@intro` because it wasn't a bibliography
        // key — silently breaking the reference in the rendered document.
        let valid: std::collections::HashSet<String> =
            ["smith2020"].iter().map(|s| s.to_string()).collect();
        let src = "= Introduction <intro>\n\nSee @intro and @smith2020.";
        let out = escape_invalid_citations(src, &valid);
        assert_eq!(out, src, "label ref and citation should both survive");
    }

    #[test]
    fn escape_keeps_label_reference_defined_after_use() {
        // The label can be defined further down than the reference; collection
        // must see the whole document before deciding.
        let valid: std::collections::HashSet<String> =
            ["smith2020"].iter().map(|s| s.to_string()).collect();
        let src = "As shown in @fig-plot below.\n\n#figure(image(\"/p.png\")) <fig-plot>";
        let out = escape_invalid_citations(src, &valid);
        assert_eq!(out, src);
    }

    #[test]
    fn escape_still_escapes_unresolved_reference_with_bibliography() {
        // A reference that is neither a citation key nor a defined label (here
        // an email's `@gmail`) is still escaped so Typst doesn't error.
        let valid: std::collections::HashSet<String> =
            ["smith2020"].iter().map(|s| s.to_string()).collect();
        let src = "Mail me at paulgott9@gmail.com or cite @smith2020.";
        let out = escape_invalid_citations(src, &valid);
        assert!(
            out.contains(r"\@gmail"),
            "email @gmail should be escaped: {out}"
        );
        assert!(out.contains("@smith2020"), "citation should survive");
    }

    #[test]
    fn escape_typst_markup_neutralizes_special_chars() {
        // Markup-significant characters must be backslash-escaped so a rendered
        // reference becomes literal text, not accidental formatting.
        assert_eq!(escape_typst_markup("a*b_c#d@e"), r"a\*b\_c\#d\@e");
        // Brackets (which would otherwise open a content block) and angle
        // brackets (labels) too.
        assert_eq!(escape_typst_markup("[1] <x>"), r"\[1\] \<x\>");
        // Benign punctuation is left alone.
        assert_eq!(escape_typst_markup("pp. 12-15, 2020."), "pp. 12-15, 2020.");
    }

    #[test]
    fn wrap_formatting_emits_markup_for_emphasis() {
        use hayagriva::citationberg::FontStyle;
        let fmt = hayagriva::Formatting {
            font_style: FontStyle::Italic,
            ..Default::default()
        };
        assert_eq!(wrap_formatting("Title", &fmt), "_Title_");
        // Whitespace-only runs stay bare (no empty `_ _`).
        assert_eq!(wrap_formatting("  ", &fmt), "  ");
    }

    #[test]
    fn render_cited_bibliography_formats_titles() {
        // A minimal Hayagriva YAML library; the rendered reference should carry
        // the cited entry and italicize the work's title (chicago-author-date).
        let yaml = r#"
gross1961:
    type: Article
    author: Gross, E. P.
    title: Structure of a Quantized Vortex in Boson Systems
    date: 1961
    parent:
        type: Periodical
        title: Il Nuovo Cimento
"#;
        let library = hayagriva::io::from_yaml_str(yaml).unwrap();
        let style = resolve_style(
            std::path::Path::new("/tmp/notebox"),
            None,
            Some("chicago-author-date"),
        )
        .unwrap();
        let keys = vec!["gross1961".to_string()];
        let out = render_cited_bibliography(&library, &keys, &style).unwrap();
        assert!(out.contains("Gross"), "expected author in: {out:?}");
        assert!(out.contains("1961"), "expected year in: {out:?}");
        // Some emphasis markup must be present (journal/title italics).
        assert!(out.contains('_'), "expected italic markup in: {out:?}");
        // Keys that don't resolve are skipped, yielding an empty string.
        let none = render_cited_bibliography(&library, &["nope".to_string()], &style).unwrap();
        assert_eq!(none, "");
    }

    #[test]
    fn link_with_url_prefix_collapses_to_single_clean_link() {
        use hayagriva::{ElemChild, Formatted};

        // hayagriva's DOI shape: a plain-text "https://doi.org/" prefix followed
        // by a Link whose url is that prefix + the display text. The prefix must
        // be re-absorbed so Typst doesn't auto-link the bare-URL fragment.
        let url = "https://doi.org/10.48550/arXiv.2304.07327";
        let children = hayagriva::ElemChildren(vec![
            ElemChild::Text(Formatted {
                text: "https://doi.org/".to_string(),
                formatting: hayagriva::Formatting::default(),
            }),
            ElemChild::Link {
                text: Formatted {
                    text: "10.48550/arXiv.2304.07327".to_string(),
                    formatting: hayagriva::Formatting::default(),
                },
                url: url.to_string(),
            },
        ]);

        let mut out = String::new();
        elem_children_to_typst(&children, &mut out);
        // Single body-less link to the full URL — no stray bare-URL prefix left
        // for Typst to auto-link.
        assert_eq!(out, format!("#link(\"{url}\")"));
        assert!(
            !out.contains("doi.org/#link"),
            "bare prefix leaked: {out:?}"
        );
    }

    #[test]
    fn link_with_distinct_anchor_keeps_body() {
        use hayagriva::{ElemChild, Formatted};
        let children = hayagriva::ElemChildren(vec![ElemChild::Link {
            text: Formatted {
                text: "Project page".to_string(),
                formatting: hayagriva::Formatting::default(),
            },
            url: "https://example.com/x".to_string(),
        }]);
        let mut out = String::new();
        elem_children_to_typst(&children, &mut out);
        assert_eq!(out, "#link(\"https://example.com/x\")[Project page]");
    }
}
