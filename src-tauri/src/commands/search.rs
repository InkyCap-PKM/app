// Tauri IPC commands for notebox search and search-and-replace.

use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::search::engine::AnnotationScope;
use crate::search::query::parse_query;
use crate::search::results::{ReplaceResult, SearchResponse};
use crate::state::AppState;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;
use crate::text_offsets::byte_to_utf16;

/// Get all tags with their counts (for tag autocomplete).
#[tauri::command]
pub async fn get_all_tags(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<(String, usize)>, InkyCapError> {
    let session = state.session(window.label()).await;
    let pi = session.property_index.read().await;
    Ok(pi.all_tags_sorted())
}

/// Full-text search across the notebox. With `case_sensitive`, the
/// case-insensitive index finds candidates and each match is checked against
/// the query's original case, so `Tool` doesn't find `tool`.
#[tauri::command]
pub async fn notebox_search(
    state: State<'_, AppState>,
    query: String,
    max_results: Option<usize>,
    offset: Option<usize>,
    case_sensitive: Option<bool>,
    use_regex: Option<bool>,
    annotation_scope: Option<AnnotationScope>,
    window: tauri::WebviewWindow,
) -> Result<SearchResponse, InkyCapError> {
    let session = state.session(window.label()).await;
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
        parse_query(&query)
            .ok_or_else(|| InkyCapError::FilterParse("Empty or invalid search query".to_string()))?
    };

    // Case-sensitive search checks each matched span inside the engine, before
    // counting and paging, so dropped lines aren't counted. With no terms to
    // check (e.g. only a `tag:` filter), no check is passed, so filter results
    // survive.
    let terms = if case_sensitive.unwrap_or(false) {
        original_case_terms(&query)
    } else {
        Vec::new()
    };
    let verify =
        (!terms.is_empty()).then_some(move |span: &str| terms.iter().any(|t| t.matches(span)));

    // Resolve `collection:` membership before taking the search lock (it reads
    // collection files and the property index); the engine only intersects the
    // paths.
    let mut collections = crate::search::engine::CollectionMembership::new();
    for name in crate::search::query::collection_filter_values(&parsed) {
        let key = name.to_lowercase();
        if collections.contains_key(&key) {
            continue;
        }
        let members = crate::commands::collections::collection_member_paths(&session, &name).await;
        collections.insert(key, members);
    }

    let engine = session.search_engine.read().await;
    let (mut results, total_count) = engine.search_paginated(
        &parsed,
        offset,
        limit,
        annotation_scope,
        verify.as_ref().map(|v| v as &dyn Fn(&str) -> bool),
        &collections,
    );

    // Match ranges are byte offsets, but the webview and CodeMirror use UTF-16,
    // so on lines with multi-byte characters highlights would drift. Convert
    // here, the one point every highlight reads from, after the case check,
    // which needs bytes.
    for r in &mut results {
        for (start, end) in &mut r.match_ranges {
            *start = byte_to_utf16(&r.line_text, *start);
            *end = byte_to_utf16(&r.line_text, *end);
        }
        // Filename ranges index into `file_name`, not `line_text`.
        for (start, end) in &mut r.file_name_ranges {
            *start = byte_to_utf16(&r.file_name, *start);
            *end = byte_to_utf16(&r.file_name, *end);
        }
    }

    // Add each result's `zid` from the property index, for the zid sort orders;
    // one brief lock and a lookup per row, as `get_file_tree` does.
    {
        let pi = session.property_index.read().await;
        for r in &mut results {
            r.zid = pi.notes.get(&PathBuf::from(&r.path)).and_then(|m| m.zid());
        }
    }

    Ok(SearchResponse {
        results,
        total_count,
    })
}

/// A case-sensitive check, built from the raw query, for re-checking a span the
/// index found.
enum CaseTerm {
    /// A plain term — the matched word must equal this verbatim.
    Exact(String),
    /// A wildcard term (`DOG*`, `d*g`): the matched word must match this
    /// case-sensitive, anchored regex. A wildcard hit's span is the whole word,
    /// so comparing with the stem would reject `DOGGZ` for `DOG*`.
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

/// The query's terms in their original case, for case-sensitive checking.
/// Filters (`tag:foo`, `property:k=v`, …), operators, regex literals and quoted
/// phrases are skipped.
fn original_case_terms(query: &str) -> Vec<CaseTerm> {
    const FILTER_PREFIXES: &[&str] = &[
        "path:",
        "file:",
        "tag:",
        "section:",
        "property:",
        "annotation:",
        "collection:",
    ];
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

/// A wildcard term (`*` = any run) as a case-sensitive anchored regex, with
/// other characters escaped.
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
    window: tauri::WebviewWindow,
) -> Result<Vec<ReplaceResult>, InkyCapError> {
    let session = state.session(window.label()).await;
    let case_sensitive = case_sensitive.unwrap_or(false);
    let use_regex = use_regex.unwrap_or(false);
    let storage = session.get_storage().await?;

    // Determine which files to operate on
    let paths: Vec<PathBuf> = if let Some(specified) = file_paths {
        specified.into_iter().map(PathBuf::from).collect()
    } else {
        // No paths given: use all indexed files; the replacement only touches
        // files with matches.
        let engine = session.search_engine.read().await;
        engine.all_indexed_paths()
    };

    // Perform replacements
    let replacements = {
        let engine = session.search_engine.read().await;
        engine.search_and_replace(&query, &replacement, &paths, case_sensitive, use_regex)
    };

    let mut results = Vec::new();

    for (path, new_content, count) in &replacements {
        // Write the updated content
        storage.write_file(path, new_content).await?;

        // Update the search index
        let tags = {
            let pi = session.property_index.read().await;
            pi.get_tags_for_file(path)
        };
        let (title, property_keys, property_values) = {
            let pi = session.property_index.read().await;
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
            let mut engine = session.search_engine.write().await;
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
            path: to_frontend_string(path),
            replacements: *count,
        });
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::original_case_terms;

    /// Does any original-case term accept this span? Mirrors the engine's
    /// `verify_span` predicate.
    fn verify(query: &str, span: &str) -> bool {
        original_case_terms(query).iter().any(|t| t.matches(span))
    }

    #[test]
    fn case_sensitive_wildcard_accepts_full_matched_word() {
        // A wildcard's span is the whole word, so `DOG*` accepts `DOGGZ` and
        // still rejects lowercase.
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
}
