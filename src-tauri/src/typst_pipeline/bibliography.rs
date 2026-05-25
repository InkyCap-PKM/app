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
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("Failed to stat bibliography file: {e}"))?;
    let mtime = meta.modified()
        .map_err(|e| format!("Failed to read bibliography mtime: {e}"))?;
    let size = meta.len();

    {
        let guard = parse_cache().lock().map_err(|e| format!("Cache poisoned: {e}"))?;
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
            key: CacheKey { path: path.to_path_buf(), mtime, size },
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
    let bib = biblatex::Bibliography::parse(content)
        .map_err(|e| format!("BibTeX parse error: {e}"))?;
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
        log::warn!("Skipped {skipped} BibTeX entries with type errors; loaded {} entries", entries.len());
    }
    Ok(ParsedBibliography { entries, notes, skipped_entries: skipped })
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
    Ok(ParsedBibliography { entries, notes, skipped_entries: 0 })
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
            title, authors, year, entry_type,
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
    let csl_entries: Vec<CslJsonEntry> = serde_json::from_str(content)
        .map_err(|e| format!("CSL JSON parse error: {e}"))?;

    let mut entries = Vec::new();
    let mut notes = Vec::new();
    for e in csl_entries {
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

        let mut entry_notes = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for field in [e.annotation, e.note] {
            if let Some(text) = field {
                let trimmed = text.trim().to_string();
                if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
                    entry_notes.push(RefNote { content: trimmed });
                }
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
    Ok(ParsedBibliography { entries, notes, skipped_entries: 0 })
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
                if !prev_ws { s.push(' '); }
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
                '}' => { depth -= 1; if depth < 0 { safe = false; break; } }
                _ => {}
            }
        }
        if depth != 0 { safe = false; }
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
            out.push_str(&format!("  title = {{{}}},\n", sanitize_bibtex_value(&entry.title)));
        }
        if !entry.authors.is_empty() {
            let authors = entry.authors.join(" and ");
            out.push_str(&format!("  author = {{{}}},\n", sanitize_bibtex_value(&authors)));
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
                out.push_str(&format!("  {} = {{{}}},\n", field, sanitize_bibtex_value(value)));
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
            for j in start..i.min(len) {
                out[j] = b' ';
            }
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
            let closing = std::str::from_utf8(&bytes[i..])
                .ok()
                .and_then(|rest| {
                    let needle: String = (0..tick_count).map(|_| '`').collect();
                    rest.find(&needle).map(|pos| pos + i)
                });
            if let Some(close_start) = closing {
                let end = close_start + tick_count;
                for j in tick_start..end.min(len) {
                    out[j] = b' ';
                }
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

/// Escape `@key` patterns in the source that do not match any entry in
/// `valid_keys`. Replaces `@key` with `\@key` so Typst treats it as
/// literal text instead of a citation reference. Skips code spans and
/// already-escaped `\@` (same contexts as `extract_citations`).
pub fn escape_invalid_citations(source: &str, valid_keys: &std::collections::HashSet<String>) -> String {
    if valid_keys.is_empty() {
        // Can't determine what's valid — leave source untouched to avoid
        // accidentally escaping legitimate citations.
        return source.to_string();
    }
    let stripped = strip_code_spans(source);
    let bytes = source.as_bytes();
    let mut out = Vec::with_capacity(source.len() + 64);
    let mut last = 0;
    for m in at_cite_re().find_iter(&stripped) {
        let key = &stripped[m.start() + 1..m.end()];
        if valid_keys.contains(key) {
            continue;
        }
        // This @key is not in the bibliography — escape it.
        out.extend_from_slice(&bytes[last..m.start()]);
        out.push(b'\\');
        out.extend_from_slice(&bytes[m.start()..m.end()]);
        last = m.end();
    }
    if last == 0 {
        return source.to_string();
    }
    out.extend_from_slice(&bytes[last..]);
    String::from_utf8(out).unwrap_or_else(|_| source.to_string())
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
        assert!(out.trim_end().ends_with("#apply-bibliography(\"/references.bib\")"));
    }

    #[test]
    fn injects_at_end_when_no_import() {
        let src = "= Title\nbody\n";
        let out = augment(src, &notebox(), &notebox().join("references.bib"), None);
        assert!(out.trim_end().ends_with("#apply-bibliography(\"/references.bib\")"));
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
        let out = augment(src, &notebox(), &notebox().join("references.bib"), Some("apa"));
        assert!(
            out.contains("#apply-bibliography(\"/references.bib\", style: \"apa\")")
        );
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
    fn escape_invalid_no_bib_leaves_untouched() {
        let valid: std::collections::HashSet<String> = std::collections::HashSet::new();
        let src = "Contact @someone and @other";
        let out = escape_invalid_citations(src, &valid);
        assert_eq!(out, src);
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
}
