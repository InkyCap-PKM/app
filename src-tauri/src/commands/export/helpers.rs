use std::path::Path;

use tauri::State;

use crate::state::AppState;

// ── Bibliography ────────────────────────────────────────────────

/// Determine the bibliography file to use for export. Collection-level
/// `bibliography_file` takes priority; otherwise falls back to the global
/// citation settings (Zotero export or user-configured `.bib`).
pub(super) async fn resolve_effective_bib(
    collection_bib: Option<&str>,
    notebox_root: Option<&Path>,
    state: &State<'_, AppState>,
) -> Option<String> {
    if let Some(bib) = collection_bib {
        if !bib.is_empty() {
            return Some(bib.to_string());
        }
    }
    let notebox_root = notebox_root?;
    let global = state.settings.read().await.citations.clone();
    let notebox = state.notebox_settings.read().await.citations.clone();
    crate::state::configure_bibliography(notebox_root, &global, &notebox)
}

/// Resolve the effective citation style. The per-notebox `custom_csl_path`
/// override wins; otherwise the user-global named style (e.g.
/// `"chicago-notes"`) applies. `None` when neither is configured.
pub(super) async fn resolve_user_bib_style(state: &State<'_, AppState>) -> Option<String> {
    let notebox = state.notebox_settings.read().await;
    let global = state.settings.read().await;
    notebox
        .citations
        .custom_csl_path
        .clone()
        .or_else(|| {
            global
                .citations
                .citation_style
                .as_deref()
                .filter(|s| !s.is_empty() && *s != "custom")
                .map(String::from)
        })
}

/// Resolve bibliography settings and inject/suppress as needed. Combines
/// `resolve_effective_bib`, `resolve_user_bib_style`, `maybe_inject_bibliography`,
/// and `apply_bibliography_visibility` into a single call.
pub(super) async fn prepare_bibliography(
    source: String,
    collection_bib: Option<&str>,
    collection_bib_style: Option<&str>,
    include_bibliography: bool,
    state: &State<'_, AppState>,
) -> String {
    let notebox_root = state.notebox_root.read().await;
    let effective_bib = resolve_effective_bib(collection_bib, notebox_root.as_deref(), state).await;
    let bib_style = match collection_bib_style {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => resolve_user_bib_style(state).await,
    };
    let source = maybe_inject_bibliography(source, effective_bib.as_deref(), bib_style.as_deref());
    apply_bibliography_visibility(source, include_bibliography)
}

/// Suppress the rendered bibliography from export output without breaking
/// citation resolution. When `include` is `false`, prepends a Typst show
/// rule that replaces the bibliography element with `none` — the
/// `#bibliography(...)` call still binds the bib file (so `@key` citations
/// resolve) but its visible output is dropped entirely, leaving no blank
/// trailing pages.
///
/// Per CLAUDE.md's Typst-first principle: this uses a Typst show rule
/// rather than mutating user source or stripping the `#bibliography`
/// call, so a user-written `#bibliography(...)` is suppressed by the
/// same mechanism as our auto-injected one.
pub(super) fn apply_bibliography_visibility(source: String, include: bool) -> String {
    if include { return source; }
    format!("#show bibliography: _ => none\n\n{}", source)
}

/// Append a `#bibliography(...)` call to the source when the collection
/// specifies a bibliography file and the source contains `@` citations.
pub(super) fn maybe_inject_bibliography(source: String, bib_file: Option<&str>, bib_style: Option<&str>) -> String {
    let Some(bib) = bib_file else { return source };
    if bib.is_empty() { return source };
    let bib = if bib.starts_with('/') { bib.to_string() } else { format!("/{bib}") };

    let has_explicit_bib = source.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.starts_with("//") && trimmed.contains("#bibliography(")
    });
    if has_explicit_bib { return source };

    if !crate::commands::typst::source_has_citation(&source) { return source };

    let style_arg = match bib_style {
        Some(s) if !s.is_empty() => format!(", style: \"{}\"", s),
        _ => String::new(),
    };
    format!("{}\n\n#bibliography(\"{}\"{})\n", source.trim_end(), bib, style_arg)
}

// ── Wikilinks ───────────────────────────────────────────────────

/// Rewrite `#wikilink(...)` calls in Typst source to `#link(...)` calls pointing
/// to the target HTML file. Wikilinks to notes outside the collection become
/// plain text.
pub(super) fn rewrite_wikilinks_to_links(
    source: &str,
    name_to_file: &std::collections::HashMap<String, String>,
) -> String {
    let re = regex::Regex::new(
        r#"#wikilink\("([^"]*)"(?:,\s*display:\s*"([^"]*)")?\)"#,
    )
    .unwrap();
    re.replace_all(source, |caps: &regex::Captures| {
        let target = &caps[1];
        let display = caps.get(2).map(|m| m.as_str()).unwrap_or(target);
        if let Some(file) = name_to_file.get(target) {
            format!("#link(\"{}\")[{}]", file, display)
        } else {
            display.to_string()
        }
    })
    .to_string()
}

/// Strip `#wikilink(...)` calls from source, replacing with their display text.
pub(super) fn strip_wikilinks_from_source(source: &str) -> String {
    let re = regex::Regex::new(
        r#"#wikilink\("([^"]*)"(?:,\s*display:\s*"([^"]*)")?\)"#,
    )
    .unwrap();
    re.replace_all(source, |caps: &regex::Captures| {
        caps.get(2)
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| caps[1].to_string())
    })
    .to_string()
}

// ── Document metadata injection ─────────────────────────────────

/// Inject `#set document(...)` rule from `#note(...)` properties so that
/// Typst embeds title/author/date/keywords into the compiled document.
/// `typst-pdf` then writes these into the PDF metadata fields.
pub(super) fn inject_document_metadata(source: &str) -> String {
    use crate::typst_pipeline::note_rewriter::note_call_span;

    let props = extract_metadata_raw(source);
    if props.is_empty() {
        return source.to_string();
    }

    let mut doc_args = Vec::new();

    for (key, value) in &props {
        match key.as_str() {
            "title" => {
                doc_args.push(format!("title: \"{}\"", escape_typst_string(value)));
            }
            "author" => {
                if value.contains(", ") {
                    let authors: Vec<String> = value
                        .split(", ")
                        .map(|a| format!("\"{}\"", escape_typst_string(a)))
                        .collect();
                    doc_args.push(format!("author: ({})", authors.join(", ")));
                } else {
                    doc_args.push(format!("author: \"{}\"", escape_typst_string(value)));
                }
            }
            "date" => {
                if value.starts_with("datetime(") {
                    doc_args.push(format!("date: {}", value));
                } else if let Some(dt) = parse_date_to_typst_datetime(value) {
                    doc_args.push(format!("date: {}", dt));
                }
            }
            "tags" | "tag" | "keywords" => {
                let kws: Vec<String> = value
                    .split(", ")
                    .map(|k| format!("\"{}\"", escape_typst_string(k)))
                    .collect();
                doc_args.push(format!("keywords: ({})", kws.join(", ")));
            }
            _ => {}
        }
    }

    if doc_args.is_empty() {
        return source.to_string();
    }

    let set_rule = format!("#set document({})\n", doc_args.join(", "));

    let insert_after = if let Some(span) = note_call_span(source) {
        let after_call = span.end;
        if source.as_bytes().get(after_call) == Some(&b'\n') {
            after_call + 1
        } else {
            after_call
        }
    } else {
        0
    };

    let mut result = String::with_capacity(source.len() + set_rule.len());
    result.push_str(&source[..insert_after]);
    result.push_str(&set_rule);
    result.push_str(&source[insert_after..]);
    result
}

/// Extract all `#note(...)` metadata from Typst source as plain-text key-value
/// pairs. Preserves original InkyCap key names (tag, to-do, etc.).
pub(super) fn extract_metadata_raw(
    source: &str,
) -> Vec<(String, String)> {
    use crate::typst_pipeline::note_rewriter::{extract_note_properties, typst_value_to_plain_text};

    extract_note_properties(source)
        .into_iter()
        .map(|(k, raw_v)| (k, typst_value_to_plain_text(&raw_v)))
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

/// Normalize metadata for document property formats (DOCX/ODT/PDF).
/// Maps InkyCap keys to standard document property keys, normalizes dates,
/// and filters out keys that aren't document properties.
pub(super) fn normalize_metadata(raw: &[(String, String)]) -> Vec<(String, String)> {
    raw.iter()
        .filter_map(|(k, v)| {
            let key = match k.as_str() {
                "tag" | "tags" => "keywords".to_string(),
                "to-do" | "alias" | "collection" => return None,
                other => other.to_string(),
            };
            let value = if key == "date" {
                normalize_date_value(v)
            } else {
                v.clone()
            };
            Some((key, value))
        })
        .collect()
}

/// Convert datetime-style values to ISO date strings.
/// Handles: `datetime(year: 2026, month: 4, day: 29)` → `2026-04-29`
/// and passes through already-formatted dates like `2026-04-29`.
pub(super) fn normalize_date_value(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("datetime(") {
        if let Some(inner) = rest.strip_suffix(')') {
            let mut year = None;
            let mut month = None;
            let mut day = None;
            for part in inner.split(',') {
                let part = part.trim();
                if let Some(v) = part.strip_prefix("year:") {
                    year = v.trim().parse::<i32>().ok();
                } else if let Some(v) = part.strip_prefix("month:") {
                    month = v.trim().parse::<u32>().ok();
                } else if let Some(v) = part.strip_prefix("day:") {
                    day = v.trim().parse::<u32>().ok();
                }
            }
            if let (Some(y), Some(m), Some(d)) = (year, month, day) {
                return format!("{:04}-{:02}-{:02}", y, m, d);
            }
        }
    }
    value.to_string()
}

// ── Escaping ────────────────────────────────────────────────────

pub(super) fn escape_typst_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

pub(super) fn escape_html_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(super) fn escape_html_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(super) fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// ── XML helpers ─────────────────────────────────────────────────

/// Replace the content of an XML element, or insert it before `closing_parent`
/// if the element doesn't exist.
pub(super) fn upsert_xml_element(xml: &mut String, tag: &str, value: &str, closing_parent: &str) {
    upsert_xml_element_with_attr(xml, tag, value, "", closing_parent);
}

/// Like `upsert_xml_element` but allows extra attributes on the opening tag.
pub(super) fn upsert_xml_element_with_attr(
    xml: &mut String,
    tag: &str,
    value: &str,
    attr: &str,
    closing_parent: &str,
) {
    let escaped = escape_xml(value);
    let close_tag = format!("</{}>", tag);

    let open_pattern = format!("<{}", tag);
    if let Some(start) = xml.find(&open_pattern) {
        if let Some(gt) = xml[start..].find('>') {
            let content_start = start + gt + 1;
            if let Some(close_offset) = xml[content_start..].find(&close_tag) {
                let close_end = content_start + close_offset + close_tag.len();
                let replacement = format!("<{}{}>{}{}",tag, attr, escaped, close_tag);
                xml.replace_range(start..close_end, &replacement);
                return;
            }
        }
    }

    if let Some(pos) = xml.find(closing_parent) {
        let insert = format!("<{}{}>{}{}", tag, attr, escaped, close_tag);
        xml.insert_str(pos, &insert);
    }
}

// ── Typst argument parsing ──────────────────────────────────────

pub(super) fn parse_date_to_typst_datetime(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() == 3 {
        if let (Ok(y), Ok(m), Ok(d)) = (
            parts[0].parse::<i32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) {
            return Some(format!("datetime(year: {}, month: {}, day: {})", y, m, d));
        }
    }
    None
}

/// Extract the first positional string argument from a Typst args slice
/// (e.g. `"foo"` from `"foo", display: "bar"`). Returns `None` if the args
/// don't begin with a quoted string.
pub(super) fn parse_first_string_arg(args: &str) -> Option<String> {
    let trimmed = args.trim_start();
    if !trimmed.starts_with('"') {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let mut i = 1;
    let mut buf = String::new();
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if i + 1 < bytes.len() => {
                buf.push(bytes[i + 1] as char); // utf8-safe: Typst string escapes are ASCII-range
                i += 2;
            }
            b'"' => return Some(buf),
            b if b < 0x80 => {
                buf.push(b as char); // utf8-safe: guarded by b < 0x80 (ASCII only)
                i += 1;
            }
            _ => {
                let rest = &trimmed[i..];
                let Some(ch) = rest.chars().next() else { break };
                buf.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    None
}

/// Extract a named string argument value from a Typst args slice. Looks for
/// `<name>:` followed by a quoted string. Returns `None` if not found.
pub(super) fn parse_named_string_arg(args: &str, name: &str) -> Option<String> {
    let needle = format!("{}:", name);
    let mut search = args;
    loop {
        let idx = search.find(&needle)?;
        let preceding = if idx == 0 {
            None
        } else {
            search[..idx].chars().last()
        };
        let is_word = preceding.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !is_word {
            let after = &search[idx + needle.len()..];
            let trimmed = after.trim_start();
            return parse_first_string_arg(trimmed);
        }
        search = &search[idx + needle.len()..];
    }
}

pub(super) fn find_matching_paren(s: &str, open_pos: usize) -> Option<usize> {
    let mut depth = 0;
    let mut in_string = false;
    let bytes = s.as_bytes();
    for i in open_pos..bytes.len() {
        match bytes[i] {
            b'"' if !in_string => in_string = true,
            b'"' if in_string => in_string = false,
            b'(' if !in_string => depth += 1,
            b')' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

pub(super) fn find_matching_bracket(s: &str, open_pos: usize) -> Option<usize> {
    let mut depth = 0;
    let bytes = s.as_bytes();
    for i in open_pos..bytes.len() {
        match bytes[i] {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Cheap predicate: does this Typst args slice contain `<name>:` as a
/// named-argument keyword? Used to detect non-string alt values
/// (`alt: none`, `alt: my-var`) that `parse_named_string_arg` skips.
pub(super) fn args_has_named_arg(args: &str, name: &str) -> bool {
    let needle = format!("{}:", name);
    let mut search = args;
    loop {
        let Some(idx) = search.find(&needle) else { return false };
        let preceding = if idx == 0 { None } else { search[..idx].chars().last() };
        let is_word = preceding.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !is_word {
            return true;
        }
        search = &search[idx + needle.len()..];
    }
}

// ── Image path extraction ───────────────────────────────────────

/// Extract all `#image(...)` paths from a Typst source file.
pub(super) fn extract_image_paths(source: &str) -> Vec<String> {
    let re = regex::Regex::new(r#"#image\("([^"]*)""#).unwrap();
    re.captures_iter(source)
        .map(|cap| cap[1].to_string())
        .collect()
}

// ── Template resolution ─────────────────────────────────────────

/// Resolve a template reference to a Typst import path.
///
/// - Paths starting with `/` are notebox-root-relative, passed through.
/// Resolve a creation-rule's Typst-template reference into something we can
/// inject as `#import "<resolved>": *`.
///
/// - Paths starting with `/` or `@` are passed through (notebox-root-absolute
///   or package spec — already canonical).
/// - Bare names are interpreted as an `@local/<name>:0.1.0` spec by default.
///   Users authoring custom-namespace local packages can write the full
///   `@<namespace>/<name>:<version>` form in the rule field.
///
/// `notebox_root` is accepted for API symmetry with earlier code paths that
/// resolved against the filesystem; it's currently unused but kept so call
/// sites don't need to change if we later add manifest-aware resolution
/// (e.g. picking the latest available version for a bare name).
pub fn resolve_template_path(template: &str) -> String {
    resolve_template_path_with_root(template, None)
}

pub fn resolve_template_path_with_root(template: &str, _notebox_root: Option<&Path>) -> String {
    if template.starts_with('/') || template.starts_with('@') {
        return template.to_string();
    }
    // Bare name → default to the local namespace and version 0.1.0. Users
    // who need a different version or namespace write the full spec.
    format!("@local/{}:0.1.0", template)
}
