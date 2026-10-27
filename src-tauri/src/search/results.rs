// Search result types and ranking logic.

use serde::Serialize;

/// A single search result with context for display.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    /// Absolute file path.
    pub path: String,
    /// File name (without extension) for display.
    pub file_name: String,
    /// Line number of the first match (1-indexed).
    pub line_number: usize,
    /// The text of the matched line.
    pub line_text: String,
    /// Character offset ranges within `line_text` that matched.
    pub match_ranges: Vec<(usize, usize)>,
    /// Character ranges in `file_name` that matched, for highlighting in the
    /// result group header. Empty unless the query matched the file name.
    pub file_name_ranges: Vec<(usize, usize)>,
    /// Relevance score (higher is better).
    pub score: f64,
    /// Modification time (Unix seconds, 0 if unknown), so the UI can sort by
    /// modified time without another IPC call.
    pub modified_time: i64,
    /// File creation time as a Unix timestamp in seconds. Falls back to
    /// `modified_time` on platforms that don't expose creation time.
    pub created_time: i64,
    /// The note's `#note(zid:)`, if any, filled in by the command layer from
    /// the property index (the engine indexes text, not metadata), so search
    /// sorts by zid as the file tree does.
    pub zid: Option<String>,
    /// Up to two lines before `line_text`. The notebox import line is left out.
    pub context_before: Vec<String>,
    /// Lines immediately after `line_text` (max 2), with the same
    /// import-line filter applied.
    pub context_after: Vec<String>,
}

/// Scoring weights for ranking search results.
const FILENAME_MATCH_BONUS: f64 = 50.0;
const TITLE_MATCH_BONUS: f64 = 30.0;
const DENSITY_MULTIPLIER: f64 = 10.0;

/// Compute a relevance score for a search result.
pub fn compute_score(
    match_in_filename: bool,
    match_in_title: bool,
    match_count: usize,
    total_words: usize,
) -> f64 {
    let mut score = 0.0;
    if match_in_filename {
        score += FILENAME_MATCH_BONUS;
    }
    if match_in_title {
        score += TITLE_MATCH_BONUS;
    }
    // Density: matches per 1000 words
    if total_words > 0 {
        let density = (match_count as f64 / total_words as f64) * 1000.0;
        score += density * DENSITY_MULTIPLIER;
    }
    score
}

/// Paginated search response — results plus total count for the UI.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub total_count: usize,
}

/// A search-and-replace result for a single file.
#[derive(Debug, Clone, Serialize)]
pub struct ReplaceResult {
    pub path: String,
    pub replacements: usize,
}
