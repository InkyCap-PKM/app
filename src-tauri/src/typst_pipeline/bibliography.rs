//! Default bibliography injection and bibliography file parsing.
//!
//! When a note declares no `#bibliography(...)` and the notebox has a default
//! bibliography file, the compile pipeline adds one to an in-memory copy of the
//! note; the file on disk is never changed. Entries are parsed with
//! `hayagriva`, which reads BibTeX (`.bib`) and Hayagriva YAML (`.yml`).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use regex::Regex;
use serde::Serialize;

use crate::typst_pipeline::book_wrapper::escape_typst_markup;
use crate::typst_pipeline::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// File names tried, in order, when no `bibliographyPath` is set. `.bib` wins
/// over `.yml`; the caller should warn when both exist.
const DEFAULT_BIB_FILES: &[&str] = &["references.bib", "references.yml", "references.json"];

/// The bibliography file to load for the notebox, if any. `override_path` is
/// the notebox-relative `bibliographyPath` from `.inkycap/settings.json`.
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

/// True if the source already has an uncommented `#bibliography(...)` call.
/// Errs towards true: a false positive only skips the injection, while a false
/// negative adds a duplicate, which Typst rejects.
///
/// Per CLAUDE.md's Typst-first principle, an AST check was considered, but this
/// runs on every save against text that may be mid-edit and unparseable, where
/// a pattern match is more reliable. `note_rewriter` uses the AST because it
/// rewrites.
pub fn already_declares_bibliography(source: &str) -> bool {
    // Ignore `//` comments. Block comments aren't handled; a false positive is
    // acceptable.
    let stripped = strip_line_comments(source);
    bib_re().is_match(&stripped)
}

/// The source to compile: unchanged if there is nothing to inject, otherwise
/// with a call to the package's [`apply-bibliography`] appended. Typst collects
/// citations across the whole document, so placement only decides where the
/// list renders.
///
/// `style`, when given, is passed as `style:`; Typst interprets both built-in
/// names ("apa") and CSL paths ("/styles/foo.csl").
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
            // Keep the trailing newline.
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
    /// True if the source has user notes attached, so the note-import picker
    /// can hide entries without any. Computed once at load.
    pub has_notes: bool,
    /// Extra BibTeX fields (publisher, journal, volume, pages, doi, url, …)
    /// from Zotero, for the exported `.bib`. Empty for file-based entries.
    #[serde(skip)]
    pub extra_fields: std::collections::HashMap<String, String>,
}

/// A note attached to a bibliography entry.
#[derive(Debug, Clone, Serialize)]
pub struct RefNote {
    pub content: String,
}

/// One parse pass: entries for the picker and notes per key.
#[derive(Debug, Clone)]
struct ParsedBibliography {
    entries: Vec<BibEntry>,
    /// Aligned with `entries`. Notes are extracted up front because the parsed
    /// library types aren't `Send` or `Clone` and can't be cached.
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

/// The parsed bibliography for `path`, cached by mtime and size in a single
/// slot (a notebox has one active bibliography file).
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

/// Notes for `key`, from the cached parse.
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
        // Read annotation, annote and note directly: Zotero puts user
        // annotations in `annotation`, and hayagriva's `Entry::note()` only
        // exposes `note`.
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

/// User-note fields from a raw entry, most useful first: `annotation` (Zotero),
/// `annote` (classic BibTeX), then `note`.
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

/// Make a BibTeX field value safe inside `{...}`:
///
/// - newlines become spaces (an `@` starting a continuation line confuses
///   hayagriva);
/// - unbalanced `{` / `}` are escaped.
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

/// Entries as BibTeX for the compiler. Used for the Zotero source, since
/// `#bibliography()` needs a file.
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
        // Emit fields in alphabetical order so the `.bib` is identical across
        // runs; HashMap order would make every export a change, and a merge
        // conflict when collaborating.
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

/// Write `entries` as BibTeX at `rel_path` in the notebox (leading `/`
/// optional), creating folders as needed. Used at export so a template's
/// `bibliography("…")` reads current data. Returns the path with a leading
/// slash; rejects paths outside the notebox.
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

/// Citation keys in Typst source, in order of first appearance, without
/// duplicates: both `@key` and `cite(<key>)`.
///
/// Walks the syntax tree, so escaped `\@`, raw text, strings and comments are
/// skipped, and keys follow Typst's label rules (Zotero keys like `5VX4GJ8Q`
/// included). References to labels in the note are returned too; callers match
/// against the bibliography.
pub fn extract_citations(source: &str) -> Vec<String> {
    let root = parse(source);
    let mut keys = Vec::new();
    collect_citation_keys(&LinkedNode::new(&root), &mut keys);
    let mut seen = std::collections::HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));
    keys
}

/// Recursively gather citation keys from `@key` references and the first
/// label argument of `cite(...)` calls.
fn collect_citation_keys(node: &LinkedNode<'_>, keys: &mut Vec<String>) {
    match node.kind() {
        SyntaxKind::Ref => {
            if let Some(reference) = node.cast::<ast::Ref>() {
                keys.push(reference.target().to_string());
            }
        }
        SyntaxKind::FuncCall => {
            if let Some(key) = node.cast::<ast::FuncCall>().and_then(cite_call_key) {
                keys.push(key);
            }
        }
        _ => {}
    }
    for child in node.children() {
        collect_citation_keys(&child, keys);
    }
}

/// The key of a `cite(<key>, ...)` call, or `None` for any other call.
fn cite_call_key(call: ast::FuncCall<'_>) -> Option<String> {
    let ast::Expr::Ident(callee) = call.callee() else {
        return None;
    };
    if callee.get().as_str() != "cite" {
        return None;
    }
    call.args().items().find_map(|arg| match arg {
        ast::Arg::Pos(ast::Expr::Label(label)) => Some(label.get().to_string()),
        _ => None,
    })
}

/// Escape references that match neither a bibliography entry nor a label in the
/// document, so Typst shows them as text instead of failing. The usual case is
/// an email address: Typst reads the `@domain` of `user@domain.com` as a
/// reference.
///
/// Per CLAUDE.md's Typst-first principle this walks the `typst::syntax` tree,
/// so only real `Ref` nodes are considered (not `@` in strings, code or
/// comments), and `@intro` pointing at `= Heading <intro>` is kept.
///
/// An unresolved `@` straight after an email-style character
/// (`athena@inkycap.org`) is always escaped (see [`is_email_like_at`]). A
/// standalone unresolved `@key` is escaped only when `valid_keys` is non-empty;
/// otherwise it may be a citation not loaded yet.
pub fn escape_invalid_citations(
    source: &str,
    valid_keys: &std::collections::HashSet<String>,
) -> String {
    let root = parse(source);
    let link = LinkedNode::new(&root);

    // First collect every label and every reference: a label can be defined after
    // the reference to it.
    let mut labels: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut refs: Vec<(usize, String)> = Vec::new();
    collect_refs_and_labels(&link, &mut labels, &mut refs);
    if refs.is_empty() {
        return source.to_string();
    }

    // Then escape each reference whose target is neither a key nor a label, by
    // inserting `\` before its `@`.
    refs.sort_by_key(|(pos, _)| *pos);
    let bytes = source.as_bytes();
    let mut out = Vec::with_capacity(source.len() + 16);
    let mut last = 0;
    for (pos, target) in &refs {
        // A real key or label: leave it.
        if valid_keys.contains(target) || labels.contains(target) {
            continue;
        }
        // An unresolved `@` after an email character is an address. `*pos` is the
        // byte offset of the ASCII `@`, so the slice ends on a char boundary.
        let attached_to_word = is_email_like_at(source[..*pos].chars().next_back());
        // With no keys loaded, a standalone `@` might be a citation not
        // resolved yet, so leave it.
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

/// Whether an `@` after `char_before` joins an email address or handle rather
/// than starting a reference. Typst reads `athena@inkycap.org` as text plus a
/// reference to `<inkycap.org>`; InkyCap treats it as an address everywhere: no
/// `@` popup, plain text in the visual editor, escaped here. ASCII only, so a
/// citation right after a CJK word (`参见@smith2020`) still works. Keep in step
/// with `isEmailLikeAt` in `reference-form.ts`.
fn is_email_like_at(char_before: Option<char>) -> bool {
    char_before.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// Collect every `<label>` and `@target` in the tree. References are recorded
/// as (byte position of `@`, target).
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

// ---------------------------------------------------------------------------
// Static bibliography rendering ("copy formatted bibliography").
//
// Produces a fixed Typst-markup copy of the references cited in one note, in
// the user's citation style, that renders the same when pasted elsewhere.
//
// Per CLAUDE.md's Typst-first principle, formatting is done by hayagriva, as
// in Typst's own `#bibliography`; Typst has no way to output a bibliography as
// static text. hayagriva's formatted output is mapped to the equivalent Typst
// markup (`_italic_`, `*bold*`, `#super[...]`, `#smallcaps[...]`,
// `#underline[...]`, `#link(...)`).
// ---------------------------------------------------------------------------

/// Parse a bibliography file into a hayagriva [`Library`](hayagriva::Library)
/// for rendering. Unlike [`parse_bibliography`], keeps the full entries the CSL
/// renderer needs.
pub fn load_library(path: &Path) -> Result<hayagriva::Library, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read bibliography file: {e}"))?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    match ext {
        "bib" => parse_library_bibtex(&content),
        "yml" | "yaml" => hayagriva::io::from_yaml_str(&content)
            .map_err(|e| format!("Hayagriva YAML parse error: {e}")),
        // CSL JSON can't be read by hayagriva (nor rendered by
        // `#bibliography`), so report it clearly.
        "json" => {
            Err("CSL JSON bibliographies can't be rendered to static Typst markup yet".to_string())
        }
        _ => Err(format!("Unsupported bibliography format: .{ext}")),
    }
}

/// Parse BibTeX into a hayagriva [`Library`](hayagriva::Library). Used for the
/// Zotero source, which is exported as BibTeX first.
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

/// The CSL style to render with, in the same order as compiling (see
/// `NoteboxSession::open_notebox_fast`): the notebox's custom `.csl`, else the
/// global named style, else `chicago-author-date`.
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

/// The references for `keys` as static Typst markup in CSL `style`, one
/// paragraph each in the style's order. Keys not in `library` are skipped.
/// Empty when none resolve.
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
        // Within one pasted reference everything stays in one paragraph, so
        // recurse inline whatever the `display`.
        ElemChild::Elem(elem) => elem_children_to_typst(&elem.children, out),
        // hayagriva's contract: `Markup` is already Typst markup — emit verbatim.
        ElemChild::Markup(markup) => out.push_str(markup),
        ElemChild::Link { text, url } => {
            // hayagriva often writes a URL's start as plain text (e.g.
            // `https://doi.org/`) followed by a link whose URL includes it.
            // Typst would auto-link that text separately, so merge it into this
            // link.
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
                // When the text equals the URL, omit the body; Typst shows the
                // URL itself.
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

/// Wrap escaped `text` in the Typst markup for hayagriva's
/// [`Formatting`](hayagriva::Formatting). Whitespace-only runs are left bare.
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

    /// The exported BibTeX is identical whatever the HashMap order: fields are
    /// sorted alphabetically.
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
        // Extra fields in alphabetical order after title, author and year.
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

    /// Our `#apply-bibliography(` must not count as a user's
    /// `#bibliography(...)`, or re-augmenting would skip the directive; a
    /// direct `#bibliography(` must still be detected.
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
    fn extract_follows_typst_raw_rules() {
        // Two backticks are an empty raw span in Typst, so `@inner` between
        // them is a real citation; three or more open a raw block.
        let src = "``@inner`` and ```@block``` and @outer";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["inner", "outer"]);
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
    fn extract_finds_digit_first_keys() {
        let src = "Zotero keys @5VX4GJ8Q and #cite(<2ABCDEF9>) both count.";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["5VX4GJ8Q", "2ABCDEF9"]);
    }

    #[test]
    fn extract_skips_strings_and_comments() {
        let src = "#let s = \"@instring\"\n// @incomment\n/* @inblock */\n@real\n";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["real"]);
    }

    #[test]
    fn extract_cite_with_extra_arguments_and_in_code() {
        let src = "#cite(<smith>, form: \"prose\") and #{ cite(<jones>) }";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["smith", "jones"]);
    }

    #[test]
    fn extract_ignores_other_calls_with_labels() {
        let src = "#ref(<fig>) and #link(<intro>)[Intro]";
        let keys = extract_citations(src);
        assert!(keys.is_empty());
    }

    #[test]
    fn extract_citation_with_supplement() {
        let src = "@smith[p. 7] said so.";
        let keys = extract_citations(src);
        assert_eq!(keys, vec!["smith"]);
    }

    #[test]
    fn escape_invalid_keeps_valid_citations() {
        let valid: std::collections::HashSet<String> =
            ["smith2020"].iter().map(|s| s.to_string()).collect();
        let src = "See @smith2020 and athena@inkycap.org for details.";
        let out = escape_invalid_citations(src, &valid);
        assert!(out.contains("@smith2020"));
        assert!(out.contains(r"\@inkycap"));
        assert!(!out.contains(" @inkycap"));
    }

    #[test]
    fn escape_invalid_no_bib_leaves_standalone_refs_untouched() {
        // A standalone `@ref` with no bibliography loaded is left alone.
        let valid: std::collections::HashSet<String> = std::collections::HashSet::new();
        let src = "Contact @someone and @other";
        let out = escape_invalid_citations(src, &valid);
        assert_eq!(out, src);
    }

    #[test]
    fn escape_email_without_bibliography() {
        // An email in a note with no bibliography must still be escaped, or a
        // strict export fails with `label <inkycap.org> does not exist`.
        let valid: std::collections::HashSet<String> = std::collections::HashSet::new();
        let src = "e-mail: athena@inkycap.org";
        let out = escape_invalid_citations(src, &valid);
        assert_eq!(out, r"e-mail: athena\@inkycap.org");
    }

    #[test]
    fn escape_email_ending_in_local_part_punctuation() {
        // `+` tags and `_` / `-` / `.` are all legal at the end of a local part.
        let valid: std::collections::HashSet<String> = std::collections::HashSet::new();
        for src in [
            "me+news@example.org",
            "first_@example.org",
            "a-@b.c",
            "x.@y.z",
        ] {
            let out = escape_invalid_citations(src, &valid);
            assert_eq!(out, src.replacen('@', r"\@", 1), "{src}");
        }
    }

    #[test]
    fn escape_leaves_reference_after_cjk_word_as_a_reference() {
        // A citation right after a CJK word is a reference and is left for a
        // later compile.
        let valid: std::collections::HashSet<String> = std::collections::HashSet::new();
        let src = "参见@smith2020。";
        assert_eq!(escape_invalid_citations(src, &valid), src);
        // With keys loaded it is unresolved like any other stray reference.
        let valid: std::collections::HashSet<String> = ["other".to_string()].into_iter().collect();
        assert_eq!(escape_invalid_citations(src, &valid), r"参见\@smith2020。");
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
        // A reference to a heading, figure or equation label survives when a
        // bibliography is loaded.
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
        // an email's `@inkycap`) is still escaped so Typst doesn't error.
        let valid: std::collections::HashSet<String> =
            ["smith2020"].iter().map(|s| s.to_string()).collect();
        let src = "Mail me at athena@inkycap.org or cite @smith2020.";
        let out = escape_invalid_citations(src, &valid);
        assert!(
            out.contains(r"\@inkycap"),
            "email @inkycap should be escaped: {out}"
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

        // hayagriva's DOI shape: the plain "https://doi.org/" text must be
        // merged into the link.
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
