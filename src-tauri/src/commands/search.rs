// Tauri IPC commands for notebox search and search-and-replace.

use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::search::engine::AnnotationScope;
use crate::search::query::parse_query;
use crate::search::results::{ReplaceResult, SearchResponse};
use crate::state::AppState;
use crate::storage::traits::NoteboxStorage;

/// Get all tags with their counts (for tag autocomplete).
#[tauri::command]
pub async fn get_all_tags(
    state: State<'_, AppState>,
) -> Result<Vec<(String, usize)>, InkyCapError> {
    let pi = state.property_index.read().await;
    Ok(pi.all_tags_sorted())
}

/// Full-text search across the notebox. When `case_sensitive` is true,
/// the (case-insensitive) inverted index is used to find candidate lines
/// but every emitted match range is verified against the original-case
/// query terms, so a search for `Tool` won't return `tool`.
#[tauri::command]
pub async fn notebox_search(
    state: State<'_, AppState>,
    query: String,
    max_results: Option<usize>,
    offset: Option<usize>,
    case_sensitive: Option<bool>,
    use_regex: Option<bool>,
    annotation_scope: Option<AnnotationScope>,
) -> Result<SearchResponse, InkyCapError> {
    let limit = max_results.unwrap_or(100);
    let offset = offset.unwrap_or(0);
    let annotation_scope = annotation_scope.unwrap_or_default();

    let parsed = if annotation_scope == AnnotationScope::Only && query.trim().is_empty() {
        // Annotations-only scope with no query → browse every annotation.
        crate::search::query::QueryNode::Filter {
            kind: crate::search::query::FilterKind::Annotation,
            value: String::new(),
        }
    } else if use_regex.unwrap_or(false) {
        crate::search::query::QueryNode::Regex(query.clone())
    } else {
        parse_query(&query).ok_or_else(|| {
            InkyCapError::FilterParse("Empty or invalid search query".to_string())
        })?
    };

    // Case-sensitive search verifies each matched span against the original-case
    // query terms. The inverted index is case-insensitive, so this runs as a
    // span predicate inside the engine — *before* counting and pagination — so a
    // dropped line is dropped from `total_count` too. With no case-sensitive
    // terms (e.g. a pure `tag:` filter), there's nothing to verify and the
    // predicate is omitted so filter-only results survive unchanged.
    let terms = if case_sensitive.unwrap_or(false) {
        original_case_terms(&query)
    } else {
        Vec::new()
    };
    let verify = (!terms.is_empty()).then(|| {
        move |span: &str| terms.iter().any(|t| t.matches(span))
    });

    // Resolve membership for any `collection:` filter in the query before we
    // take the search-engine lock (resolution reads the collection files and
    // property index). The engine itself has no notion of collections — it
    // just intersects the precomputed member paths with document paths.
    let mut collections = crate::search::engine::CollectionMembership::new();
    for name in crate::search::query::collection_filter_values(&parsed) {
        let key = name.to_lowercase();
        if collections.contains_key(&key) {
            continue;
        }
        let members =
            crate::commands::collections::collection_member_paths(state.inner(), &name).await;
        collections.insert(key, members);
    }

    let engine = state.search_engine.read().await;
    let (mut results, total_count) = engine.search_paginated(
        &parsed,
        offset,
        limit,
        annotation_scope,
        verify.as_ref().map(|v| v as &dyn Fn(&str) -> bool),
        &collections,
    );

    // Match ranges are computed as *byte* offsets into each line (Rust `&str`),
    // but the webview indexes line text — and CodeMirror places selections — in
    // UTF-16 code units. On a line with multi-byte characters (curly quotes,
    // em-dashes, accents) the two diverge, drifting every highlight after the
    // first such character onto the wrong text. Convert to UTF-16 here, the
    // single boundary every frontend highlight consumer (result excerpt, editor
    // jump, in-note highlight) reads from. This runs *after* the case-sensitive
    // check above, which still needs byte offsets to slice `line_text`.
    for r in &mut results {
        for (start, end) in &mut r.match_ranges {
            *start = byte_to_utf16(&r.line_text, *start);
            *end = byte_to_utf16(&r.line_text, *end);
        }
    }

    Ok(SearchResponse {
        results,
        total_count,
    })
}

/// Byte offset → UTF-16 code-unit offset within `line`, matching how the
/// JS/CodeMirror frontend indexes strings. See the call site in
/// `notebox_search` for why search ranges cross the IPC boundary in UTF-16.
fn byte_to_utf16(line: &str, byte_off: usize) -> usize {
    let mut b = byte_off.min(line.len());
    // Defensive: ranges land on char boundaries, but never panic if one didn't.
    while b > 0 && !line.is_char_boundary(b) {
        b -= 1;
    }
    line[..b].encode_utf16().count()
}

/// A single original-case verification predicate for case-sensitive search.
/// Built from the raw query so a candidate span (found via the case-insensitive
/// index) can be re-checked against exactly what the user typed.
enum CaseTerm {
    /// A plain term — the matched word must equal this verbatim.
    Exact(String),
    /// A wildcard term (`DOG*`, `d*g`) — the matched word must match this
    /// case-sensitive, anchored regex. The engine reports a wildcard hit's
    /// span as the whole matched word, so an exact-equality check against the
    /// `*`-stripped stem would wrongly reject it (e.g. stem `DOG` ≠ word
    /// `DOGGZ`); the wildcard pattern accepts the full word instead.
    Wildcard(regex::Regex),
}

impl CaseTerm {
    fn matches(&self, span: &str) -> bool {
        match self {
            CaseTerm::Exact(s) => s == span,
            CaseTerm::Wildcard(re) => re.is_match(span),
        }
    }
}

/// Re-extract original-case query terms from a raw query string. Used by
/// case-sensitive search to verify that a match-range substring really
/// corresponds to what the user typed. Filter prefixes (`tag:foo`, `path:bar`,
/// `property:k=v`, etc.), boolean operators, regex literals, and quoted
/// phrases are skipped — none of them participate in the case-sensitivity
/// check.
fn original_case_terms(query: &str) -> Vec<CaseTerm> {
    const FILTER_PREFIXES: &[&str] =
        &["path:", "file:", "tag:", "section:", "property:", "annotation:", "collection:"];
    let mut out: Vec<CaseTerm> = Vec::new();
    for raw in query.split_whitespace() {
        if matches!(raw, "AND" | "OR" | "NOT") {
            continue;
        }
        let trimmed = raw.trim_start_matches('-');
        if trimmed.is_empty() {
            continue;
        }
        // Skip regex literals and quoted phrases; their case-sensitivity
        // semantics are owned by the user.
        if trimmed.starts_with('/') || trimmed.starts_with('"') {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if FILTER_PREFIXES.iter().any(|p| lower.starts_with(p)) {
            continue;
        }
        // Drop grouping parens; they're query syntax, not part of the term.
        let cleaned: String = trimmed.chars().filter(|c| *c != '(' && *c != ')').collect();
        if cleaned.is_empty() {
            continue;
        }
        if cleaned.contains('*') {
            if let Some(re) = wildcard_to_regex(&cleaned) {
                out.push(CaseTerm::Wildcard(re));
            }
        } else {
            out.push(CaseTerm::Exact(cleaned));
        }
    }
    out
}

/// Compile a wildcard term (`*` = any run of characters) into a case-sensitive,
/// fully-anchored regex. Non-`*` segments are escaped so regex metacharacters in
/// the user's term are matched literally.
fn wildcard_to_regex(term: &str) -> Option<regex::Regex> {
    let mut pattern = String::from("^");
    for (i, segment) in term.split('*').enumerate() {
        if i > 0 {
            pattern.push_str(".*");
        }
        pattern.push_str(&regex::escape(segment));
    }
    pattern.push('$');
    regex::Regex::new(&pattern).ok()
}

/// Search and replace across specified files (or all notebox files if none specified).
#[tauri::command]
pub async fn search_and_replace(
    state: State<'_, AppState>,
    query: String,
    replacement: String,
    file_paths: Option<Vec<String>>,
    case_sensitive: Option<bool>,
    use_regex: Option<bool>,
) -> Result<Vec<ReplaceResult>, InkyCapError> {
    let case_sensitive = case_sensitive.unwrap_or(false);
    let use_regex = use_regex.unwrap_or(false);
    let storage = state.get_storage().await?;

    // Determine which files to operate on
    let paths: Vec<PathBuf> = if let Some(specified) = file_paths {
        specified.into_iter().map(PathBuf::from).collect()
    } else {
        // No paths specified — pass all indexed files. The regex
        // replacement itself filters to only files with matches, so
        // there's no need to pre-filter via the search query parser.
        let engine = state.search_engine.read().await;
        engine.all_indexed_paths()
    };

    // Perform replacements
    let replacements = {
        let engine = state.search_engine.read().await;
        engine.search_and_replace(&query, &replacement, &paths, case_sensitive, use_regex)
    };

    let mut results = Vec::new();

    for (path, new_content, count) in &replacements {
        // Write the updated content
        storage.write_file(path, new_content).await?;

        // Update the search index
        let tags = {
            let pi = state.property_index.read().await;
            pi.get_tags_for_file(path)
        };
        let (title, property_keys, property_values) = {
            let pi = state.property_index.read().await;
            let title = pi.get_title_for_file(path);
            let note = pi.notes.get(path);
            let keys = note
                .map(|n| {
                    n.properties
                        .keys()
                        .filter(|k| !k.starts_with("file."))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let values = note
                .map(|n| crate::search::engine::flatten_property_values(&n.properties))
                .unwrap_or_default();
            (title, keys, values)
        };
        {
            let mut engine = state.search_engine.write().await;
            engine.update_doc(
                path,
                new_content,
                tags,
                title,
                property_keys,
                property_values,
            );
        }

        results.push(ReplaceResult {
            path: path.to_string_lossy().to_string(),
            replacements: *count,
        });
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{byte_to_utf16, original_case_terms};

    /// Does any original-case term accept this span? Mirrors the engine's
    /// `verify_span` predicate.
    fn verify(query: &str, span: &str) -> bool {
        original_case_terms(query).iter().any(|t| t.matches(span))
    }

    #[test]
    fn case_sensitive_wildcard_accepts_full_matched_word() {
        // Regression: a wildcard hit's span is the whole matched word, so a
        // case-sensitive `DOG*` must accept `DOGGZ` (not just the stem `DOG`),
        // while still rejecting a lowercase word.
        assert!(verify("DOG*", "DOGGZ"));
        assert!(verify("DOG*", "DOG"));
        assert!(!verify("DOG*", "doggz"));
        assert!(!verify("DOG*", "dogs"));
    }

    #[test]
    fn case_sensitive_exact_term_requires_same_case() {
        assert!(verify("Tool", "Tool"));
        assert!(!verify("Tool", "tool"));
        assert!(!verify("Tool", "Toolbox")); // exact word, not a prefix
    }

    #[test]
    fn wildcard_escapes_regex_metacharacters() {
        // A `.` in the term is a literal, not "any char".
        assert!(verify("a.b*", "a.bcd"));
        assert!(!verify("a.b*", "aXbcd"));
    }

    #[test]
    fn filters_and_operators_are_not_verification_terms() {
        // Pure filters / operators yield no terms, so case-sensitive search
        // leaves filter-only results untouched (no span predicate at all).
        assert!(original_case_terms("tag:Rust").is_empty());
        assert!(original_case_terms("AND OR NOT").is_empty());
    }

    #[test]
    fn byte_to_utf16_converts_past_multibyte() {
        // `“` is 3 UTF-8 bytes but 1 UTF-16 unit. A word after it has a byte
        // offset 2 higher than its UTF-16 index — the exact drift that pushed
        // highlights onto the wrong characters.
        let line = "“a is"; // “(3) a(1) ' '(1) i(1) s(1)
        // "is" starts at byte 5 (3+1+1) but UTF-16 index 3 (1+1+1).
        assert_eq!(byte_to_utf16(line, 5), 3);
        // ASCII-only lines are unchanged.
        assert_eq!(byte_to_utf16("hello world", 6), 6);
        // Out-of-range clamps to the string's UTF-16 length.
        assert_eq!(byte_to_utf16("ab", 99), 2);
    }
}
