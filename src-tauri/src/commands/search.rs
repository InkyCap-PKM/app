// Tauri IPC commands for notebox search and search-and-replace.

use std::path::PathBuf;

use tauri::State;

use crate::errors::InkyCapError;
use crate::search::query::parse_query;
use crate::search::results::{ReplaceResult, SearchResult};
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
    case_sensitive: Option<bool>,
) -> Result<Vec<SearchResult>, InkyCapError> {
    let max = max_results.unwrap_or(100);

    let parsed = parse_query(&query).ok_or_else(|| {
        InkyCapError::FilterParse("Empty or invalid search query".to_string())
    })?;

    let engine = state.search_engine.read().await;
    let mut results = engine.search(&parsed, max);

    if case_sensitive.unwrap_or(false) {
        // Term/Phrase nodes are lowercased at parse time, so we re-derive
        // original-case tokens directly from the raw query string. Tokens
        // that look like prefix:value filters are skipped — case
        // sensitivity applies to text terms only.
        let terms = original_case_terms(&query);
        if !terms.is_empty() {
            // Drop any match range whose substring doesn't equal one of
            // the user's cased terms; drop the whole result if no ranges
            // survive. Filter-only results (placeholder ranges of width 0)
            // are dropped here too — those have no meaningful text match.
            results.retain_mut(|r| {
                r.match_ranges.retain(|(start, end)| {
                    if *start >= *end || *end > r.line_text.len() {
                        return false;
                    }
                    let span = &r.line_text[*start..*end];
                    terms.iter().any(|t| t == span)
                });
                !r.match_ranges.is_empty()
            });
        }
    }

    Ok(results)
}

/// Re-extract original-case word tokens from a raw query string. Used by
/// case-sensitive search to verify that a match-range substring really
/// equals what the user typed. Filter prefixes (`tag:foo`, `path:bar`,
/// `property:k=v`, etc.), boolean operators, regex literals, and quoted
/// phrases are skipped — none of them participate in the case-sensitivity
/// check.
fn original_case_terms(query: &str) -> Vec<String> {
    const FILTER_PREFIXES: &[&str] = &["path:", "file:", "tag:", "section:", "property:"];
    let mut out: Vec<String> = Vec::new();
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
        // Strip a wildcard `*` if present so we keep the literal stem.
        let cleaned: String = trimmed
            .chars()
            .filter(|c| *c != '*' && *c != '(' && *c != ')')
            .collect();
        if !cleaned.is_empty() {
            out.push(cleaned);
        }
    }
    out
}

/// Search and replace across specified files (or all notebox files if none specified).
#[tauri::command]
pub async fn search_and_replace(
    state: State<'_, AppState>,
    query: String,
    replacement: String,
    file_paths: Option<Vec<String>>,
    case_sensitive: Option<bool>,
) -> Result<Vec<ReplaceResult>, InkyCapError> {
    let case_sensitive = case_sensitive.unwrap_or(false);
    let storage = state.get_storage().await?;

    // Determine which files to operate on
    let paths: Vec<PathBuf> = if let Some(specified) = file_paths {
        specified.into_iter().map(PathBuf::from).collect()
    } else {
        // Search all indexed files
        let engine = state.search_engine.read().await;
        let parsed = parse_query(&query).ok_or_else(|| {
            InkyCapError::FilterParse("Empty or invalid search query".to_string())
        })?;
        engine
            .search(&parsed, 10000)
            .into_iter()
            .map(|r| PathBuf::from(r.path))
            .collect()
    };

    // Perform replacements
    let replacements = {
        let engine = state.search_engine.read().await;
        engine.search_and_replace(&query, &replacement, &paths, case_sensitive)
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
