//! Bibliography-related Tauri commands (Phase 6).

use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::bibliography::{self, BibEntry};

/// Return all entries from the configured citation source (file or Zotero).
#[tauri::command]
pub async fn get_bibliography_entries(
    state: State<'_, AppState>,
) -> Result<Vec<BibEntry>, InkyCapError> {
    let notebox_root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let (source, bib_path, zotero_path) = {
        let notebox = state.notebox_settings.read().await;
        let global = state.settings.read().await;
        (
            notebox.citations.source.clone(),
            notebox.citations.bibliography_path.clone(),
            global.citations.zotero_database_path.clone(),
        )
    };

    match source.as_str() {
        "zotero" => {
            let db = zotero_path
                .map(PathBuf::from)
                .or_else(|| crate::typst_pipeline::zotero::auto_detect_path());
            match db {
                Some(p) => crate::typst_pipeline::zotero::read_entries(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
        _ => {
            let bib = bibliography::detect_default(&notebox_root, bib_path.as_deref());
            match bib {
                Some(p) => bibliography::parse_bibliography(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
    }
}

/// Return citation keys used in the given file, with metadata from the
/// configured citation source.
#[tauri::command]
pub async fn get_file_citations(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileCitation>, InkyCapError> {
    let storage = state.get_storage().await?;
    let source = storage.read_file(&sanitize_notebox_arg(&path)?).await?;

    let keys = bibliography::extract_citations(&source);
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    // Re-use get_bibliography_entries logic but we can't call a Tauri command
    // from another command, so inline the lookup.
    let entries = load_entries_inner(&state).await.unwrap_or_default();

    let citations = keys
        .into_iter()
        .filter_map(|key| {
            let entry = entries.iter().find(|e| e.key == key)?;
            Some(FileCitation {
                key: key.clone(),
                title: Some(entry.title.clone()),
                authors: entry.authors.clone(),
                year: entry.year.clone(),
                entry_type: Some(entry.entry_type.clone()),
                zotero_item_key: entry.zotero_item_key.clone(),
            })
        })
        .collect();

    Ok(citations)
}

/// Shared entry loading logic.
pub(crate) async fn load_entries_inner(state: &AppState) -> Result<Vec<BibEntry>, InkyCapError> {
    let notebox_root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let (source, bib_path, zotero_path) = {
        let notebox = state.notebox_settings.read().await;
        let global = state.settings.read().await;
        (
            notebox.citations.source.clone(),
            notebox.citations.bibliography_path.clone(),
            global.citations.zotero_database_path.clone(),
        )
    };

    match source.as_str() {
        "zotero" => {
            let db = zotero_path
                .map(PathBuf::from)
                .or_else(|| crate::typst_pipeline::zotero::auto_detect_path());
            match db {
                Some(p) => crate::typst_pipeline::zotero::read_entries(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
        _ => {
            let bib = bibliography::detect_default(&notebox_root, bib_path.as_deref());
            match bib {
                Some(p) => bibliography::parse_bibliography(&p)
                    .map_err(|e| InkyCapError::Typst(e)),
                None => Ok(Vec::new()),
            }
        }
    }
}

/// Re-export the Zotero bibliography to `.inkycap/zotero-export.bib`.
/// Called from the "refresh" button in the References panel.
#[tauri::command]
pub async fn refresh_bibliography(
    state: State<'_, AppState>,
) -> Result<Option<String>, InkyCapError> {
    let notebox_root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    let global = state.settings.read().await.citations.clone();
    let notebox = state.notebox_settings.read().await.citations.clone();
    Ok(crate::state::configure_bibliography(&notebox_root, &global, &notebox))
}

/// Return the count of entries skipped during the most recent BibTeX parse
/// because of type-conversion errors. The UI uses this to surface a notice
/// like "Loaded N of M entries" so silent data loss doesn't go unnoticed.
#[tauri::command]
pub async fn get_bibliography_skip_count() -> Result<u32, InkyCapError> {
    Ok(bibliography::last_parse_skipped_count())
}

/// Auto-detect the Zotero database path.
#[tauri::command]
pub async fn detect_zotero_path() -> Result<Option<String>, InkyCapError> {
    Ok(crate::typst_pipeline::zotero::auto_detect_path()
        .map(|p| p.to_string_lossy().to_string()))
}

/// Return notes attached to a bibliography entry identified by its cite key.
/// For Zotero, fetches child notes from the SQLite DB (stripped to plain text).
/// For file-based sources, returns the `note`/`annotation` field if present.
#[tauri::command]
pub async fn get_reference_notes(
    key: String,
    state: State<'_, AppState>,
) -> Result<Vec<bibliography::RefNote>, InkyCapError> {
    let notebox_root = state
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;

    let (source, bib_path, zotero_path) = {
        let notebox = state.notebox_settings.read().await;
        let global = state.settings.read().await;
        (
            notebox.citations.source.clone(),
            notebox.citations.bibliography_path.clone(),
            global.citations.zotero_database_path.clone(),
        )
    };

    match source.as_str() {
        "zotero" => {
            let db = zotero_path
                .map(PathBuf::from)
                .or_else(|| crate::typst_pipeline::zotero::auto_detect_path());
            match db {
                Some(p) => {
                    // Zotero stores the item_key, but we receive a citation key.
                    // Look up the item_key from the entries list.
                    let entries = crate::typst_pipeline::zotero::read_entries(&p)
                        .map_err(|e| InkyCapError::Typst(e))?;
                    let item_key = entries.iter()
                        .find(|e| e.key == key)
                        .and_then(|e| e.zotero_item_key.as_deref());
                    match item_key {
                        Some(ik) => {
                            let raw_notes = crate::typst_pipeline::zotero::read_notes(&p, ik)
                                .map_err(|e| InkyCapError::Typst(e))?;
                            Ok(raw_notes.into_iter()
                                .map(|html| bibliography::RefNote {
                                    content: strip_html_tags(&html),
                                })
                                .filter(|n| !n.content.trim().is_empty())
                                .collect())
                        }
                        None => Ok(Vec::new()),
                    }
                }
                None => Ok(Vec::new()),
            }
        }
        _ => {
            let bib = bibliography::detect_default(&notebox_root, bib_path.as_deref());
            match bib {
                Some(p) => {
                    let notes = bibliography::get_entry_notes(&p, &key)
                        .map_err(|e| InkyCapError::Typst(e))?;
                    Ok(notes.into_iter()
                        .map(|n| bibliography::RefNote {
                            content: strip_latex_markup(&n.content),
                        })
                        .filter(|n| !n.content.trim().is_empty())
                        .collect())
                }
                None => Ok(Vec::new()),
            }
        }
    }
}

const BLOCK_TAGS: &[&str] = &[
    "p", "div", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "table", "tr", "td", "th",
    "section", "article", "header", "footer", "nav", "aside", "figure",
];

fn is_block_tag(tag_content: &str) -> bool {
    let name = tag_content
        .trim_start_matches('/')
        .split(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    BLOCK_TAGS.contains(&name.as_str())
}

/// Minimal HTML tag stripper for Zotero note content. Only block-level
/// tags produce newlines; inline tags (`<em>`, `<strong>`, etc.) are
/// removed silently so the surrounding text stays on one line.
///
/// Per CLAUDE.md's Typst-first principle: Typst has no path for parsing
/// HTML — Zotero's child notes live in a SQLite blob as serialized HTML
/// from its rich-text editor, never touching the Typst document model.
/// This function runs at the trust boundary between an external store
/// and the user's note text, so a small hand-rolled stripper is the
/// right shape; we deliberately don't take a heavyweight HTML parser
/// dependency just to flatten a note into plain text.
fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;

    while !rest.is_empty() {
        if let Some(tag_open) = rest.find('<') {
            // Copy text before the tag (byte-slice between ASCII '<' delimiters
            // is always on char boundaries).
            out.push_str(&rest[..tag_open]);
            let after_open = &rest[tag_open + 1..];
            if let Some(tag_close) = after_open.find('>') {
                let tag_content = &after_open[..tag_close];
                if is_block_tag(tag_content) {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push('\n');
                    }
                }
                rest = &after_open[tag_close + 1..];
            } else {
                rest = after_open;
            }
        } else {
            out.push_str(rest);
            break;
        }
    }

    let decoded = decode_html_entities(&out);

    // Collapse runs of blank lines into single newlines
    let mut result = String::with_capacity(decoded.len());
    let mut prev_newline = false;
    for line in decoded.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !prev_newline && !result.is_empty() {
                result.push('\n');
                prev_newline = true;
            }
        } else {
            if prev_newline || (!result.is_empty() && !result.ends_with('\n')) {
                result.push('\n');
            }
            result.push_str(trimmed);
            prev_newline = false;
        }
    }
    result
}

/// Decode HTML entities to their Unicode equivalents. Handles named entities
/// (`&amp;`, `&mdash;`, etc.), decimal numeric refs (`&#8212;`), and
/// hexadecimal numeric refs (`&#x2014;`). Unknown named entities are left
/// in place so we don't lose information silently.
fn decode_html_entities(input: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});").unwrap());

    re.replace_all(input, |caps: &regex::Captures| {
        let raw = &caps[1];
        if let Some(rest) = raw.strip_prefix('#') {
            let code = if let Some(hex) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
                u32::from_str_radix(hex, 16).ok()
            } else {
                rest.parse::<u32>().ok()
            };
            return code.and_then(char::from_u32).map(|c| c.to_string()).unwrap_or_else(|| caps[0].to_string());
        }
        match raw {
            "amp" => "&".to_string(),
            "lt" => "<".to_string(),
            "gt" => ">".to_string(),
            "quot" => "\"".to_string(),
            "apos" => "'".to_string(),
            "nbsp" => " ".to_string(),
            "mdash" => "—".to_string(),
            "ndash" => "–".to_string(),
            "hellip" => "…".to_string(),
            "lsquo" => "‘".to_string(),
            "rsquo" => "’".to_string(),
            "ldquo" => "“".to_string(),
            "rdquo" => "”".to_string(),
            "laquo" => "«".to_string(),
            "raquo" => "»".to_string(),
            "copy" => "©".to_string(),
            "reg" => "®".to_string(),
            "trade" => "™".to_string(),
            "deg" => "°".to_string(),
            "para" => "¶".to_string(),
            "sect" => "§".to_string(),
            "middot" => "·".to_string(),
            "bull" => "•".to_string(),
            _ => caps[0].to_string(),
        }
    }).into_owned()
}

/// Strip LaTeX markup from bibliography note fields (e.g. Zotero BibTeX
/// annotation exports) to produce clean plain text for insertion.
///
/// Per CLAUDE.md's Typst-first principle: LaTeX is a foreign syntax that
/// will never compile in a Typst pipeline. There is no native Typst path
/// for "decode LaTeX to plain text" because Typst deliberately doesn't
/// understand LaTeX. The user-facing job here is to clean up a
/// foreign-format export field at the trust boundary so it can be inserted
/// as readable note text — a pragmatic, scoped task that doesn't belong
/// inside the Typst document model.
fn strip_latex_markup(input: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    // \section{...}, \subsection{...}, \subsubsection{...} → content + newline
    static SECTION_RE: OnceLock<Regex> = OnceLock::new();
    let section_re = SECTION_RE.get_or_init(|| {
        Regex::new(r"\\(?:sub)*section\{([^}]*)\}").unwrap()
    });

    // \textbf{...}, \textit{...}, \emph{...}, \underline{...} → content
    static FORMAT_RE: OnceLock<Regex> = OnceLock::new();
    let format_re = FORMAT_RE.get_or_init(|| {
        Regex::new(r"\\(?:textbf|textit|emph|underline|textsuperscript|textsubscript)\{([^}]*)\}").unwrap()
    });

    // \href{url}{text} → text
    static HREF_RE: OnceLock<Regex> = OnceLock::new();
    let href_re = HREF_RE.get_or_init(|| {
        Regex::new(r"\\href\{[^}]*\}\{([^}]*)\}").unwrap()
    });

    // \url{...} → content
    static URL_RE: OnceLock<Regex> = OnceLock::new();
    let url_re = URL_RE.get_or_init(|| {
        Regex::new(r"\\url\{([^}]*)\}").unwrap()
    });

    // Named breaks: \par, \newline. A trailing \b keeps us from eating
    // commands like \paragraph or \newlinechar.
    static NAMED_BREAK_RE: OnceLock<Regex> = OnceLock::new();
    let named_break_re = NAMED_BREAK_RE.get_or_init(|| {
        Regex::new(r"\\(?:par|newline)\b\s*").unwrap()
    });

    // Line-break: a literal `\\` (TeX's line-break operator). Split into
    // its own pattern because `\b` after the backslashes mis-matches when
    // followed by non-word characters (whitespace, EOL, punctuation),
    // which is exactly the common case.
    static LINEBREAK_RE: OnceLock<Regex> = OnceLock::new();
    let linebreak_re = LINEBREAK_RE.get_or_init(|| {
        Regex::new(r"\\\\\s*").unwrap()
    });

    // Symbol replacements
    static SYMBOL_RE: OnceLock<Regex> = OnceLock::new();
    let symbol_re = SYMBOL_RE.get_or_init(|| {
        Regex::new(r"\\(?:circ|degree)").unwrap()
    });

    // Remaining \command (no braces) — strip the command, keep surrounding text
    static BARE_CMD_RE: OnceLock<Regex> = OnceLock::new();
    let bare_cmd_re = BARE_CMD_RE.get_or_init(|| {
        Regex::new(r"\\[a-zA-Z]+\b\s*").unwrap()
    });

    // Remaining \command{...} — keep the brace content
    static BRACE_CMD_RE: OnceLock<Regex> = OnceLock::new();
    let brace_cmd_re = BRACE_CMD_RE.get_or_init(|| {
        Regex::new(r"\\[a-zA-Z]+\{([^}]*)\}").unwrap()
    });

    let mut s = input.to_string();

    // Process in order: specific patterns first, then general catch-alls
    s = section_re.replace_all(&s, "\n$1\n").to_string();
    s = href_re.replace_all(&s, "$1").to_string();
    s = url_re.replace_all(&s, "$1").to_string();
    s = format_re.replace_all(&s, "$1").to_string();
    s = linebreak_re.replace_all(&s, "\n").to_string();
    s = named_break_re.replace_all(&s, "\n").to_string();
    s = symbol_re.replace_all(&s, "°").to_string();

    // Strip remaining braced commands (keep content), then bare commands
    s = brace_cmd_re.replace_all(&s, "$1").to_string();
    s = bare_cmd_re.replace_all(&s, "").to_string();

    // Remove stray braces and LaTeX superscript/subscript operators
    s = s.replace('{', "").replace('}', "");
    s = s.replace('^', "").replace('~', " ");

    // Clean up: collapse multiple blank lines, trim
    let mut result = String::with_capacity(s.len());
    let mut prev_blank = false;
    for line in s.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !prev_blank && !result.is_empty() {
                result.push('\n');
                prev_blank = true;
            }
        } else {
            if prev_blank || (!result.is_empty() && !result.ends_with('\n')) {
                result.push('\n');
            }
            result.push_str(trimmed);
            prev_blank = false;
        }
    }
    result.trim().to_string()
}

/// A citation key found in a file, enriched with bibliography metadata.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileCitation {
    pub key: String,
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub entry_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_item_key: Option<String>,
}

/// A citation key aggregated across many notes, enriched with
/// bibliography metadata. Used by the Journal Scroll's "Scroll context"
/// panel to summarise the citation footprint of the visible window.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AggregatedCitation {
    pub key: String,
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub entry_type: Option<String>,
    /// Total occurrence count across all input paths (a single note
    /// citing the same key twice counts twice).
    pub count: usize,
    /// Distinct notebox-relative paths of notes that cite this key,
    /// preserved in input order.
    pub paths: Vec<String>,
    /// Zotero library item key, when the bibliography is Zotero-backed —
    /// lets the panel surface an "open in Zotero" link, as the References
    /// sidebar does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_item_key: Option<String>,
}

/// Aggregate citation keys across a batch of notes. Returns one row per
/// distinct key, ordered by descending occurrence count then by key. The
/// bibliography is loaded once for the whole batch — calling
/// `get_file_citations` per note and joining client-side would re-load
/// it N times.
#[tauri::command]
pub async fn aggregate_citations(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<AggregatedCitation>, InkyCapError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let storage = state.get_storage().await?;
    let entries = load_entries_inner(&state).await.unwrap_or_default();

    use std::collections::HashMap;
    // key -> (count, ordered list of citing paths, set for dedup)
    let mut totals: HashMap<String, (usize, Vec<String>, std::collections::HashSet<String>)> =
        HashMap::new();

    for raw_path in &paths {
        let notebox_path = match sanitize_notebox_arg(raw_path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let source = match storage.read_file(&notebox_path).await {
            Ok(s) => s,
            Err(_) => continue,
        };
        // `extract_citations` already de-duplicates within a single note,
        // so the per-note contribution is +1 per distinct key. The
        // resulting count is "how many visible notes cite this key",
        // which is the value the panel surfaces.
        for key in bibliography::extract_citations(&source) {
            let row = totals
                .entry(key.clone())
                .or_insert_with(|| (0, Vec::new(), std::collections::HashSet::new()));
            row.0 += 1;
            if row.2.insert(raw_path.clone()) {
                row.1.push(raw_path.clone());
            }
        }
    }

    let mut out: Vec<AggregatedCitation> = totals
        .into_iter()
        .filter_map(|(key, (count, paths, _))| {
            let entry = entries.iter().find(|e| e.key == key)?;
            Some(AggregatedCitation {
                key,
                title: Some(entry.title.clone()),
                authors: entry.authors.clone(),
                year: entry.year.clone(),
                entry_type: Some(entry.entry_type.clone()),
                count,
                paths,
                zotero_item_key: entry.zotero_item_key.clone(),
            })
        })
        .collect();

    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_latex_sections_and_par() {
        let input = r#"\section{Annotations} \par Birds are weird \par more text"#;
        let out = strip_latex_markup(input);
        assert!(out.contains("Annotations"));
        assert!(out.contains("Birds are weird"));
        assert!(!out.contains(r"\par"));
        assert!(!out.contains(r"\section"));
    }

    #[test]
    fn strip_latex_formatting_commands() {
        let input = r#"\textbf{bold text} and \emph{italic text}"#;
        let out = strip_latex_markup(input);
        assert_eq!(out, "bold text and italic text");
    }

    #[test]
    fn strip_latex_symbols() {
        let input = r#"27^\circ16'S, 152^\circ51'E"#;
        let out = strip_latex_markup(input);
        assert!(out.contains("27°16'S"));
        assert!(out.contains("152°51'E"));
    }

    #[test]
    fn strip_latex_subsubsection() {
        let input = r#"\subsubsection{Baldassarre - What's the Deal with Birds.pdf}"#;
        let out = strip_latex_markup(input);
        assert!(out.contains("Baldassarre - What's the Deal with Birds.pdf"));
        assert!(!out.contains(r"\subsubsection"));
    }

    #[test]
    fn strip_latex_double_backslash_linebreak() {
        // `\\` at end-of-line followed by whitespace must become a newline.
        // Old regex `\\(?:par|newline|\\)\b\s*` failed this case because
        // `\b` doesn't match between backslash and whitespace.
        let input = "first line \\\\ second line";
        let out = strip_latex_markup(input);
        assert!(out.contains("first line"));
        assert!(out.contains("second line"));
        assert!(!out.contains('\\'), "expected no backslashes in: {out:?}");
        assert!(out.contains('\n'), "expected newline in: {out:?}");
    }

    #[test]
    fn decode_html_named_and_numeric_entities() {
        let input = "tea&mdash;coffee, 27&#176;C, &#x2014;dash";
        let out = decode_html_entities(input);
        assert_eq!(out, "tea—coffee, 27°C, —dash");
    }

    #[test]
    fn decode_html_preserves_unknown_entity() {
        let input = "&unknownthing; persists";
        let out = decode_html_entities(input);
        assert_eq!(out, "&unknownthing; persists");
    }

    #[test]
    fn strip_latex_href() {
        let input = r#"\href{https://example.com}{click here}"#;
        let out = strip_latex_markup(input);
        assert_eq!(out, "click here");
    }
}
