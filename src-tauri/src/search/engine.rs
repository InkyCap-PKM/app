// In-memory inverted index for full-text vault search.
// Built on vault open, incrementally updated on file changes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::note::PropertyValue;
use crate::search::query::{FilterKind, QueryNode};
use crate::search::results::{compute_score, SearchResult};

/// Flatten a note's property map into a `key → [stringified values]`
/// form that the search engine uses to evaluate `property:key=value`
/// filters. Values are lowercased so filter matching is case
/// insensitive; `file.*` pseudo-properties are skipped.
pub fn flatten_property_values(
    properties: &HashMap<String, PropertyValue>,
) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for (key, value) in properties {
        if key.starts_with("file.") {
            continue;
        }
        let mut bucket: Vec<String> = Vec::new();
        collect_value_strings(value, &mut bucket);
        out.insert(key.to_lowercase(), bucket);
    }
    out
}

fn collect_value_strings(value: &PropertyValue, out: &mut Vec<String>) {
    match value {
        PropertyValue::String(s) => {
            let lower = s.to_lowercase();
            if !lower.is_empty() {
                out.push(lower);
            }
        }
        PropertyValue::Number(n) => {
            let s = if *n == (*n as i64) as f64 {
                format!("{}", *n as i64)
            } else {
                n.to_string()
            };
            out.push(s);
        }
        PropertyValue::Bool(b) => out.push(b.to_string()),
        PropertyValue::List(items) => {
            for item in items {
                collect_value_strings(item, out);
            }
        }
        PropertyValue::Null => {}
    }
}

/// Position of a word within a document: (line_number, word_offset_in_line, char_start, char_end).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WordPosition {
    line: usize,
    word_index: usize,
    char_start: usize,
    char_end: usize,
}

/// Per-document index data.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocEntry {
    path: PathBuf,
    file_name: String,
    /// Title from the `#note(title: ...)` property, if any.
    title: Option<String>,
    /// Tags extracted from the document.
    tags: Vec<String>,
    /// Property keys (lowercased) present on the document. Populated so
    /// that `property:name` filters can be evaluated directly against the
    /// search index rather than cross-referencing the separate property
    /// index.
    property_keys: Vec<String>,
    /// Stringified, lowercased property values, keyed by (lowercased)
    /// property key. Enables `property:key=value` filters
    /// — the engine substring-matches `value` against any string in
    /// the matching key's bucket.
    property_values: HashMap<String, Vec<String>>,
    /// Lines of the document (for context retrieval).
    lines: Vec<String>,
    /// Total word count.
    word_count: usize,
    /// Heading text (lowercased) extracted from `=`-prefix lines. Used by
    /// the `section:` filter.
    headings: Vec<String>,
    /// Indices of lines that are the auto-injected vault-library import.
    /// These lines are kept in `lines` so result line numbers still point
    /// at the source, but they are filtered out of every user-facing
    /// path: word index, regex match scan, "best line" pick, filter
    /// representative line, and context windows.
    import_line_indices: Vec<usize>,
    /// `tag name (lowercased)` → source line indices of `#tag("…")` call
    /// sites, populated from the AST projection so `tag:` filter clicks
    /// land on the actual tag call instead of a heuristic line.
    tag_locations: HashMap<String, Vec<usize>>,
    /// Filesystem modification time, Unix seconds. Defaulted to 0 if the
    /// file's metadata could not be read.
    modified_time: i64,
    /// Filesystem creation time, Unix seconds. Falls back to
    /// `modified_time` on platforms that don't expose creation time.
    created_time: i64,
}

/// The inverted index: word → list of (doc_id, positions).
type PostingList = Vec<(usize, Vec<WordPosition>)>;

/// Full-text search engine with an in-memory inverted index.
#[derive(Serialize, Deserialize)]
pub struct SearchEngine {
    /// All indexed documents.
    docs: Vec<DocEntry>,
    /// Path → doc index for fast lookup.
    path_to_doc: HashMap<PathBuf, usize>,
    /// Inverted index: lowercase word → posting list.
    index: HashMap<String, PostingList>,
}

impl SearchEngine {
    pub fn new() -> Self {
        Self {
            docs: Vec::new(),
            path_to_doc: HashMap::new(),
            index: HashMap::new(),
        }
    }

    /// Check whether a path is currently indexed.
    pub fn contains_path(&self, path: &Path) -> bool {
        self.path_to_doc.contains_key(path)
    }

    /// Return all currently indexed absolute paths.
    pub fn indexed_paths(&self) -> Vec<&Path> {
        self.path_to_doc.keys().map(|p| p.as_path()).collect()
    }

    /// Build the index from a set of files and their contents.
    /// Each entry is (path, content, tags, title, property_keys, property_values).
    pub fn build(
        files: Vec<(
            PathBuf,
            String,
            Vec<String>,
            Option<String>,
            Vec<String>,
            HashMap<String, Vec<String>>,
        )>,
    ) -> Self {
        let mut engine = Self::new();

        let processed: Vec<DocBuild> = files
            .into_par_iter()
            .map(|(path, content, tags, title, property_keys, property_values)| {
                let (mtime, ctime) = file_timestamps(&path);
                build_doc(
                    path,
                    &content,
                    tags,
                    title,
                    property_keys,
                    property_values,
                    mtime,
                    ctime,
                )
            })
            .collect();

        for built in processed {
            let doc_id = engine.docs.len();
            engine.path_to_doc.insert(built.entry.path.clone(), doc_id);
            engine.docs.push(built.entry);
            for (word, positions) in built.word_positions {
                engine.index.entry(word).or_default().push((doc_id, positions));
            }
        }

        engine
    }

    /// Add or update a single document in the index.
    pub fn update_doc(
        &mut self,
        path: &Path,
        content: &str,
        tags: Vec<String>,
        title: Option<String>,
        property_keys: Vec<String>,
        property_values: HashMap<String, Vec<String>>,
    ) {
        // Remove old entry if it exists
        self.remove_doc(path);

        let (mtime, ctime) = file_timestamps(path);
        let built = build_doc(
            path.to_path_buf(),
            content,
            tags,
            title,
            property_keys,
            property_values,
            mtime,
            ctime,
        );

        let doc_id = self.docs.len();
        self.path_to_doc.insert(path.to_path_buf(), doc_id);
        self.docs.push(built.entry);

        for (word, positions) in built.word_positions {
            let posting = self.index.entry(word).or_default();
            posting.push((doc_id, positions));
        }
    }

    /// Remove a document from the index.
    pub fn remove_doc(&mut self, path: &Path) {
        if let Some(&doc_id) = self.path_to_doc.get(path) {
            // Remove from posting lists
            for posting in self.index.values_mut() {
                posting.retain(|(id, _)| *id != doc_id);
            }
            // Note: we don't remove from self.docs to avoid invalidating IDs.
            // The doc entry stays but won't appear in search results since
            // its posting entries are removed.
            self.path_to_doc.remove(path);
        }
    }

    /// Execute a search query and return ranked results — one entry per
    /// matched line. The frontend groups by file. Lines that belong to
    /// the auto-injected vault-library import are filtered out so users
    /// never see InkyCap's preamble in the result list.
    pub fn search(&self, query: &QueryNode, max_results: usize) -> Vec<SearchResult> {
        let matches = self.evaluate(query);
        let mut results: Vec<SearchResult> = Vec::new();

        for (doc_id, line_matches) in &matches {
            let doc = match self.docs.get(*doc_id) {
                Some(d) => d,
                None => continue,
            };
            if self.path_to_doc.get(&doc.path) != Some(doc_id) {
                continue;
            }

            // Compute per-doc score factors once; every line in this doc
            // shares the same filename/title bonuses and word-count
            // density baseline.
            let total_match_count: usize = line_matches.values().map(|v| v.len()).sum();
            let match_in_filename = {
                let fname_lower = doc.file_name.to_lowercase();
                self.query_matches_text(query, &fname_lower)
            };
            let match_in_title = doc.title.as_ref().map_or(false, |t| {
                let t_lower = t.to_lowercase();
                self.query_matches_text(query, &t_lower)
            });
            let doc_score = compute_score(
                match_in_filename,
                match_in_title,
                total_match_count,
                doc.word_count,
            );

            // Walk matches in source order so the UI shows them in the
            // same order they appear in the file.
            let mut sorted_lines: Vec<(usize, &Vec<WordPosition>)> = line_matches
                .iter()
                .filter(|(line_idx, _)| !doc.import_line_indices.contains(line_idx))
                .map(|(line, positions)| (*line, positions))
                .collect();
            sorted_lines.sort_by_key(|(line, _)| *line);

            for (line_idx, positions) in sorted_lines {
                let line_text = doc.lines.get(line_idx).cloned().unwrap_or_default();
                let match_ranges: Vec<(usize, usize)> = positions
                    .iter()
                    .map(|p| (p.char_start, p.char_end))
                    .collect();

                let (context_before, context_after) =
                    collect_context(&doc.lines, &doc.import_line_indices, line_idx, 2);

                results.push(SearchResult {
                    path: doc.path.to_string_lossy().to_string(),
                    file_name: doc.file_name.clone(),
                    line_number: line_idx + 1,
                    line_text,
                    match_ranges,
                    // Per-line score: use the doc score plus a small bonus
                    // for line density so the file's first match (often the
                    // most relevant) ranks just slightly higher than later
                    // hits inside the same file.
                    score: doc_score + (positions.len() as f64) * 0.01,
                    modified_time: doc.modified_time,
                    created_time: doc.created_time,
                    context_before,
                    context_after,
                });
            }
        }

        // Stable sort by score descending; per-line tie-break already
        // preserved by the in-source-order traversal above.
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(max_results);
        results
    }

    /// Evaluate a query node, returning matching doc_ids with per-line positions.
    fn evaluate(&self, node: &QueryNode) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        match node {
            QueryNode::Term(term) => self.find_term(term),
            QueryNode::Phrase(words) => self.find_phrase(words),
            QueryNode::Wildcard(pattern) => self.find_wildcard(pattern),
            QueryNode::Regex(pattern) => self.find_regex(pattern),
            QueryNode::Filter { kind, value } => self.find_filter(kind, value),
            QueryNode::And(left, right) => {
                let left_matches = self.evaluate(left);
                let right_matches = self.evaluate(right);
                // Intersect doc IDs
                let mut result = HashMap::new();
                for (doc_id, left_lines) in &left_matches {
                    if let Some(right_lines) = right_matches.get(doc_id) {
                        let mut merged = left_lines.clone();
                        for (line, positions) in right_lines {
                            merged.entry(*line).or_default().extend(positions.clone());
                        }
                        result.insert(*doc_id, merged);
                    }
                }
                result
            }
            QueryNode::Or(left, right) => {
                let mut result = self.evaluate(left);
                let right_matches = self.evaluate(right);
                for (doc_id, lines) in right_matches {
                    let entry = result.entry(doc_id).or_default();
                    for (line, positions) in lines {
                        entry.entry(line).or_default().extend(positions);
                    }
                }
                result
            }
            QueryNode::Not(inner) => {
                let exclude = self.evaluate(inner);
                // Return all docs NOT in the exclude set
                let mut result = HashMap::new();
                for (doc_id, doc) in self.docs.iter().enumerate() {
                    if !exclude.contains_key(&doc_id) && self.path_to_doc.get(&doc.path) == Some(&doc_id) {
                        // Include with first line as placeholder
                        let mut lines = HashMap::new();
                        if !doc.lines.is_empty() {
                            lines.insert(0, vec![WordPosition {
                                line: 0,
                                word_index: 0,
                                char_start: 0,
                                char_end: 0,
                            }]);
                        }
                        result.insert(doc_id, lines);
                    }
                }
                result
            }
            QueryNode::Proximity { left, right, distance, ordered } => {
                self.find_proximity(left, right, *distance, *ordered)
            }
        }
    }

    /// Find documents containing a single term.
    fn find_term(&self, term: &str) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        let mut result = HashMap::new();
        if let Some(posting) = self.index.get(term) {
            for (doc_id, positions) in posting {
                let mut lines: HashMap<usize, Vec<WordPosition>> = HashMap::new();
                for pos in positions {
                    lines.entry(pos.line).or_default().push(pos.clone());
                }
                result.insert(*doc_id, lines);
            }
        }
        result
    }

    /// Find documents containing an exact phrase (sequence of words on the same line).
    fn find_phrase(&self, words: &[String]) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        if words.is_empty() {
            return HashMap::new();
        }

        // Start with the first word's positions
        let first_matches = self.find_term(&words[0]);
        let mut result = HashMap::new();

        for (doc_id, line_positions) in &first_matches {
            let mut valid_lines: HashMap<usize, Vec<WordPosition>> = HashMap::new();

            for (line, positions) in line_positions {
                for start_pos in positions {
                    // Check if consecutive words follow
                    let mut all_match = true;
                    let mut phrase_positions = vec![start_pos.clone()];

                    for (offset, word) in words.iter().enumerate().skip(1) {
                        let expected_word_idx = start_pos.word_index + offset;
                        let found = self.index.get(word.as_str()).map_or(false, |posting| {
                            posting.iter().any(|(did, poss)| {
                                *did == *doc_id
                                    && poss.iter().any(|p| {
                                        p.line == *line && p.word_index == expected_word_idx
                                    })
                            })
                        });
                        if !found {
                            all_match = false;
                            break;
                        }
                        // Find the actual position for highlighting
                        if let Some(posting) = self.index.get(word.as_str()) {
                            for (did, poss) in posting {
                                if *did == *doc_id {
                                    for p in poss {
                                        if p.line == *line && p.word_index == expected_word_idx {
                                            phrase_positions.push(p.clone());
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if all_match {
                        valid_lines
                            .entry(*line)
                            .or_default()
                            .extend(phrase_positions);
                    }
                }
            }

            if !valid_lines.is_empty() {
                result.insert(*doc_id, valid_lines);
            }
        }

        result
    }

    /// Find documents with words matching a wildcard pattern (e.g., "hel*").
    fn find_wildcard(&self, pattern: &str) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        // Convert glob pattern to regex
        let regex_pattern = format!("^{}$", pattern.replace('*', ".*"));
        let re = match Regex::new(&regex_pattern) {
            Ok(r) => r,
            Err(_) => return HashMap::new(),
        };

        let mut result: HashMap<usize, HashMap<usize, Vec<WordPosition>>> = HashMap::new();

        for (word, posting) in &self.index {
            if re.is_match(word) {
                for (doc_id, positions) in posting {
                    let entry = result.entry(*doc_id).or_default();
                    for pos in positions {
                        entry.entry(pos.line).or_default().push(pos.clone());
                    }
                }
            }
        }

        result
    }

    /// Find documents with lines matching a regex pattern.
    fn find_regex(&self, pattern: &str) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        let re = match Regex::new(pattern) {
            Ok(r) => r,
            Err(_) => return HashMap::new(),
        };

        let mut result = HashMap::new();

        for (doc_id, doc) in self.docs.iter().enumerate() {
            if self.path_to_doc.get(&doc.path) != Some(&doc_id) {
                continue;
            }
            let mut lines: HashMap<usize, Vec<WordPosition>> = HashMap::new();
            for (line_idx, line) in doc.lines.iter().enumerate() {
                if doc.import_line_indices.contains(&line_idx) {
                    continue;
                }
                for m in re.find_iter(line) {
                    lines.entry(line_idx).or_default().push(WordPosition {
                        line: line_idx,
                        word_index: 0,
                        char_start: m.start(),
                        char_end: m.end(),
                    });
                }
            }
            if !lines.is_empty() {
                result.insert(doc_id, lines);
            }
        }

        result
    }

    /// Find documents matching a filter (path:, tag:, file:).
    fn find_filter(
        &self,
        kind: &FilterKind,
        value: &str,
    ) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        let value_lower = value.to_lowercase();
        let mut result = HashMap::new();

        for (doc_id, doc) in self.docs.iter().enumerate() {
            if self.path_to_doc.get(&doc.path) != Some(&doc_id) {
                continue;
            }

            let matches = match kind {
                FilterKind::Path => {
                    doc.path.to_string_lossy().to_lowercase().contains(&value_lower)
                }
                FilterKind::File => {
                    doc.file_name.to_lowercase().contains(&value_lower)
                }
                FilterKind::Tag => {
                    doc.tags.iter().any(|t| t.to_lowercase().contains(&value_lower))
                }
                FilterKind::Section => {
                    // Match notes with a heading (lowercased) containing
                    // the value as a substring. Heading text is collected
                    // at index time from `=`-prefix lines.
                    doc.headings.iter().any(|h| h.contains(&value_lower))
                }
                FilterKind::Property => {
                    // Two forms:
                    //   `property:name` — notes where the key exists
                    //   `property:name=value` — key exists AND one of
                    //     its stringified values contains `value`
                    //     (case-insensitive substring). Matching by
                    //     substring lets partial queries like
                    //     `property:status=draft` hit `draft`,
                    //     `drafts`, etc., which is the usual intent.
                    if let Some(eq_idx) = value_lower.find('=') {
                        let key = value_lower[..eq_idx].trim();
                        let needle = value_lower[eq_idx + 1..].trim();
                        if key.is_empty() {
                            false
                        } else if let Some(values) = doc.property_values.get(key) {
                            if needle.is_empty() {
                                true
                            } else {
                                values.iter().any(|v| v.contains(needle))
                            }
                        } else {
                            false
                        }
                    } else {
                        doc.property_keys
                            .iter()
                            .any(|k| k.contains(&value_lower))
                    }
                }
            };

            if matches {
                // For `tag:` filters, jump to the actual `#tag("…")`
                // call site (recorded by the AST projection) rather
                // than picking a representative line — otherwise the
                // result would land on whichever non-empty line came
                // first, typically inside the `#note(...)` properties
                // block.
                let mut lines: HashMap<usize, Vec<WordPosition>> = HashMap::new();
                if let FilterKind::Tag = kind {
                    for (tag_name, tag_lines) in &doc.tag_locations {
                        if tag_name.contains(&value_lower) {
                            for &line_idx in tag_lines {
                                if doc.import_line_indices.contains(&line_idx) {
                                    continue;
                                }
                                lines.entry(line_idx).or_default().push(WordPosition {
                                    line: line_idx,
                                    word_index: 0,
                                    char_start: 0,
                                    char_end: 0,
                                });
                            }
                        }
                    }
                }

                // Fallback (and the only path for non-tag filters):
                // pick the first non-empty, non-import line as a
                // representative. Also covers the rare case where a
                // tag was set in `#note(tags: (...))` syntax but the
                // body contains no `#tag(...)` call — the doc still
                // matches the filter, just lacks a precise location.
                if lines.is_empty() {
                    let representative = doc
                        .lines
                        .iter()
                        .enumerate()
                        .find(|(idx, line)| {
                            !doc.import_line_indices.contains(idx)
                                && !line.trim().is_empty()
                        })
                        .map(|(idx, _)| idx)
                        .unwrap_or(0);
                    lines.insert(
                        representative,
                        vec![WordPosition {
                            line: representative,
                            word_index: 0,
                            char_start: 0,
                            char_end: 0,
                        }],
                    );
                }
                result.insert(doc_id, lines);
            }
        }

        result
    }

    /// Find documents where two terms appear within N words of each other.
    fn find_proximity(
        &self,
        left: &str,
        right: &str,
        distance: usize,
        ordered: bool,
    ) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        let left_matches = self.find_term(left);
        let right_postings: HashMap<usize, Vec<WordPosition>> = self
            .index
            .get(right)
            .map(|posting| {
                posting
                    .iter()
                    .map(|(doc_id, positions)| (*doc_id, positions.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let mut result = HashMap::new();

        for (doc_id, left_lines) in &left_matches {
            if let Some(right_positions) = right_postings.get(doc_id) {
                let mut valid_lines: HashMap<usize, Vec<WordPosition>> = HashMap::new();

                for (line, left_poss) in left_lines {
                    for lp in left_poss {
                        for rp in right_positions {
                            if rp.line != *line {
                                continue;
                            }
                            let dist = if ordered {
                                if rp.word_index > lp.word_index {
                                    rp.word_index - lp.word_index
                                } else {
                                    continue;
                                }
                            } else {
                                let a = lp.word_index;
                                let b = rp.word_index;
                                if a > b { a - b } else { b - a }
                            };
                            if dist <= distance {
                                valid_lines
                                    .entry(*line)
                                    .or_default()
                                    .extend(vec![lp.clone(), rp.clone()]);
                            }
                        }
                    }
                }

                if !valid_lines.is_empty() {
                    result.insert(*doc_id, valid_lines);
                }
            }
        }

        result
    }

    /// Quick check: does a query match a given text string? (for filename/title scoring)
    fn query_matches_text(&self, node: &QueryNode, text: &str) -> bool {
        match node {
            QueryNode::Term(t) => text.contains(t.as_str()),
            QueryNode::Phrase(words) => {
                let joined = words.join(" ");
                text.contains(&joined)
            }
            QueryNode::Wildcard(pattern) => {
                let regex_pattern = format!("^{}$", pattern.replace('*', ".*"));
                Regex::new(&regex_pattern)
                    .map(|re| re.is_match(text))
                    .unwrap_or(false)
            }
            QueryNode::And(l, r) => {
                self.query_matches_text(l, text) && self.query_matches_text(r, text)
            }
            QueryNode::Or(l, r) => {
                self.query_matches_text(l, text) || self.query_matches_text(r, text)
            }
            QueryNode::Not(inner) => !self.query_matches_text(inner, text),
            _ => false,
        }
    }

    /// Perform search-and-replace across specified files.
    /// Returns the list of files modified and replacement counts.
    pub fn search_and_replace(
        &self,
        query: &str,
        replacement: &str,
        file_paths: &[PathBuf],
        case_sensitive: bool,
    ) -> Vec<(PathBuf, String, usize)> {
        // Build a regex for the literal search query
        let escaped = regex::escape(query);
        let pattern = if case_sensitive {
            escaped
        } else {
            format!("(?i){}", escaped)
        };
        let re = match Regex::new(&pattern) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        file_paths
            .par_iter()
            .filter_map(|path| {
                if let Some(&doc_id) = self.path_to_doc.get(path) {
                    let doc = &self.docs[doc_id];
                    let original = doc.lines.join("\n");
                    let new_content = re.replace_all(&original, replacement).to_string();
                    if new_content != original {
                        let count = re.find_iter(&original).count();
                        Some((path.clone(), new_content, count))
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect()
    }
}

/// Wrapper for persisting the search engine to disk alongside a timestamp
/// so stale entries can be detected on next load.
#[derive(Serialize, Deserialize)]
pub struct PersistedSearchIndex {
    pub engine: SearchEngine,
    /// Unix timestamp (seconds) when the engine was last saved. Files with
    /// mtime > saved_at need their search entries rebuilt.
    pub saved_at: i64,
}

impl PersistedSearchIndex {
    pub fn save_to_file(&self, path: &Path) {
        let encoded = match bincode::serialize(self) {
            Ok(data) => data,
            Err(err) => {
                log::warn!("search index: serialization failed: {err}");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(err) = std::fs::write(path, encoded) {
            log::warn!("search index: write failed at {}: {err}", path.display());
        }
    }

    /// Save a borrowed engine with a given timestamp. Avoids cloning the
    /// engine when called from the debounced write-through path.
    pub fn save_borrowed(engine: &SearchEngine, saved_at: i64, path: &Path) {
        #[derive(Serialize)]
        struct Ref<'a> {
            engine: &'a SearchEngine,
            saved_at: i64,
        }
        let wrapper = Ref { engine, saved_at };
        let encoded = match bincode::serialize(&wrapper) {
            Ok(data) => data,
            Err(err) => {
                log::warn!("search index: serialization failed: {err}");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(err) = std::fs::write(path, encoded) {
            log::warn!("search index: write failed at {}: {err}", path.display());
        }
    }

    pub fn load_from_file(path: &Path) -> Option<Self> {
        let data = std::fs::read(path).ok()?;
        bincode::deserialize(&data).ok()
    }
}

/// Output of `build_doc`: a [`DocEntry`] paired with the per-word positions
/// the engine still needs to merge into its inverted index.
struct DocBuild {
    entry: DocEntry,
    word_positions: Vec<(String, Vec<WordPosition>)>,
}

/// Tokenize a single document into the structures the engine consumes.
///
/// Indexing is driven by [`text_projection::project`] — a Typst-AST walk
/// that emits one token per *rendered word*, with markup wrappers
/// (`_…_`, `*…*`, `#strong[…]`, `#highlight[…]`, headings, list items,
/// nested content-bracket calls, …) automatically stripped because they
/// are structural nodes around the text leaves rather than part of
/// them. This is what makes a search for `italicize` find content
/// authored as `_italicize_`, and a search for the body of a
/// `#highlight[yellow]` find `yellow`.
///
/// `doc.lines` still holds the raw source so result snippets show what
/// the user wrote, and `match_ranges` from the index continue to point
/// at byte offsets inside the raw line. The auto-injected vault import
/// line is skipped from indexing (so users searching for `vault` or
/// `import` don't get every note back) but kept in `lines` so result
/// line numbers stay aligned with the source.
fn build_doc(
    path: PathBuf,
    content: &str,
    tags: Vec<String>,
    title: Option<String>,
    property_keys: Vec<String>,
    property_values: HashMap<String, Vec<String>>,
    modified_time: i64,
    created_time: i64,
) -> DocBuild {
    let file_name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let mut import_line_indices: Vec<usize> = Vec::new();
    for (line_idx, line) in lines.iter().enumerate() {
        if crate::vault_package::is_vault_import_line(line) {
            import_line_indices.push(line_idx);
        }
    }

    let projection = crate::search::text_projection::project(content);

    // Build the inverted-index entries, assigning per-line word indices
    // in source order so phrase search ("a b c") keeps working: words
    // 0, 1, 2 must be consecutive on the same line.
    let mut local_index: HashMap<String, Vec<WordPosition>> = HashMap::new();
    let mut word_count = 0usize;
    let mut per_line_word_idx: HashMap<usize, usize> = HashMap::new();

    for token in &projection.tokens {
        if import_line_indices.contains(&token.line) {
            continue;
        }
        let word_idx = per_line_word_idx.entry(token.line).or_insert(0);
        let pos = WordPosition {
            line: token.line,
            word_index: *word_idx,
            char_start: token.char_start,
            char_end: token.char_end,
        };
        *word_idx += 1;
        word_count += 1;
        local_index.entry(token.word.clone()).or_default().push(pos);
    }

    let property_keys_lower: Vec<String> =
        property_keys.iter().map(|k| k.to_lowercase()).collect();

    DocBuild {
        entry: DocEntry {
            path,
            file_name,
            title,
            tags,
            property_keys: property_keys_lower,
            property_values,
            lines,
            word_count,
            headings: projection.headings,
            import_line_indices,
            tag_locations: projection.tag_locations,
            modified_time,
            created_time,
        },
        word_positions: local_index.into_iter().collect(),
    }
}

/// Collect up to `window` lines of context before and after `line_idx`,
/// skipping vault-import lines. The returned tuples preserve source
/// order — `before` runs from earliest to nearest, `after` runs from
/// nearest to latest.
fn collect_context(
    lines: &[String],
    import_indices: &[usize],
    line_idx: usize,
    window: usize,
) -> (Vec<String>, Vec<String>) {
    let mut before: Vec<String> = Vec::new();
    if line_idx > 0 {
        let mut idx = line_idx;
        while idx > 0 && before.len() < window {
            idx -= 1;
            if import_indices.contains(&idx) {
                continue;
            }
            if let Some(text) = lines.get(idx) {
                before.push(text.clone());
            }
        }
        before.reverse();
    }

    let mut after: Vec<String> = Vec::new();
    let mut idx = line_idx + 1;
    while idx < lines.len() && after.len() < window {
        if !import_indices.contains(&idx) {
            if let Some(text) = lines.get(idx) {
                after.push(text.clone());
            }
        }
        idx += 1;
    }

    (before, after)
}

/// Read filesystem mtime/ctime for a note. Errors are absorbed and surfaced
/// as `(0, 0)` — sort order will simply group missing values together.
fn file_timestamps(path: &Path) -> (i64, i64) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, 0);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let ctime = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(mtime);
    (mtime, ctime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::query::parse_query;

    fn make_engine() -> SearchEngine {
        SearchEngine::build(vec![
            (
                PathBuf::from("/vault/note1.md"),
                "# Hello World\nThis is a test note about Rust programming.\nRust is great for systems.".to_string(),
                vec!["rust".to_string(), "programming".to_string()],
                Some("Hello World".to_string()),
                Vec::new(),
                HashMap::new(),
            ),
            (
                PathBuf::from("/vault/note2.md"),
                "# Another Note\nPython is also a great language.\nBut Rust is faster.".to_string(),
                vec!["python".to_string()],
                Some("Another Note".to_string()),
                Vec::new(),
                HashMap::new(),
            ),
            (
                PathBuf::from("/vault/daily/2024-01-01.md"),
                "# Daily Note\nToday I learned about search engines.\nFull-text search is powerful.".to_string(),
                vec!["daily".to_string()],
                None,
                Vec::new(),
                HashMap::new(),
            ),
        ])
    }

    /// Distinct files among the result rows. Engine `search` emits one
    /// row per matched line, so tests that care about file-level recall
    /// need to deduplicate by path.
    fn unique_paths(results: &[SearchResult]) -> usize {
        let mut paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
        paths.sort();
        paths.dedup();
        paths.len()
    }

    #[test]
    fn test_simple_search() {
        let engine = make_engine();
        let query = parse_query("rust").unwrap();
        let results = engine.search(&query, 10);
        // note1 mentions Rust on two lines, note2 on one line — three
        // result rows, two distinct files.
        assert_eq!(results.len(), 3);
        assert_eq!(unique_paths(&results), 2);
    }

    #[test]
    fn test_phrase_search() {
        let engine = make_engine();
        let query = parse_query("\"hello world\"").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(results.len(), 1);
        assert!(results[0].path.contains("note1"));
    }

    #[test]
    fn test_and_search() {
        let engine = make_engine();
        let query = parse_query("rust programming").unwrap();
        let results = engine.search(&query, 10);
        // Only note1 has both — `rust` appears on two lines while
        // `programming` appears on one; the AND merge produces two rows
        // for that file.
        assert_eq!(unique_paths(&results), 1);
        assert!(results.iter().all(|r| r.path.contains("note1")));
    }

    #[test]
    fn test_or_search() {
        let engine = make_engine();
        let query = parse_query("python OR daily").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(results.len(), 2); // note2 and daily
    }

    #[test]
    fn test_not_search() {
        let engine = make_engine();
        let query = parse_query("rust NOT python").unwrap();
        let results = engine.search(&query, 10);
        // note1 has rust without python
        assert!(results.iter().any(|r| r.path.contains("note1")));
        assert!(!results.iter().any(|r| r.path.contains("note2")));
    }

    #[test]
    fn test_property_value_filter() {
        // Two notes share a `status` key but with different values.
        // `property:status=draft` should match only the first; multi-word
        // values require quoting in the query.
        let mut values1: HashMap<String, Vec<String>> = HashMap::new();
        values1.insert("status".to_string(), vec!["draft".to_string()]);
        let mut values2: HashMap<String, Vec<String>> = HashMap::new();
        values2.insert("status".to_string(), vec!["in progress".to_string()]);
        let engine = SearchEngine::build(vec![
            (
                PathBuf::from("/a.md"),
                "body a".to_string(),
                Vec::new(),
                None,
                vec!["status".to_string()],
                values1,
            ),
            (
                PathBuf::from("/b.md"),
                "body b".to_string(),
                Vec::new(),
                None,
                vec!["status".to_string()],
                values2,
            ),
        ]);

        let q = parse_query("property:status=draft").unwrap();
        let r = engine.search(&q, 10);
        assert_eq!(r.len(), 1);
        assert!(r[0].path.ends_with("a.md"));

        // Multi-word values must be quoted; an unquoted second word is
        // parsed as a separate term and AND-composes with the filter.
        let q = parse_query("property:status=\"in progress\"").unwrap();
        let r = engine.search(&q, 10);
        assert_eq!(r.len(), 1);
        assert!(r[0].path.ends_with("b.md"));

        // Quoted form composing with another filter — verifies that
        // the property: branch doesn't eat the remainder of the query
        // when the value is quoted.
        let q = parse_query("property:status=\"draft\" path:a").unwrap();
        let r = engine.search(&q, 10);
        assert_eq!(r.len(), 1);
        assert!(r[0].path.ends_with("a.md"));

        // Key-existence form still works.
        let q = parse_query("property:status").unwrap();
        let r = engine.search(&q, 10);
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn test_tag_filter() {
        let engine = make_engine();
        let query = parse_query("tag:python").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(results.len(), 1);
        assert!(results[0].path.contains("note2"));
    }

    #[test]
    fn test_path_filter() {
        let engine = make_engine();
        let query = parse_query("path:daily").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(results.len(), 1);
        assert!(results[0].path.contains("daily"));
    }

    #[test]
    fn test_wildcard() {
        let engine = make_engine();
        let query = parse_query("prog*").unwrap();
        let results = engine.search(&query, 10);
        assert!(!results.is_empty());
    }

    #[test]
    fn test_search_and_replace() {
        let engine = make_engine();
        let paths = vec![PathBuf::from("/vault/note1.md")];
        let replacements = engine.search_and_replace("Rust", "Go", &paths, true);
        assert_eq!(replacements.len(), 1);
        assert!(replacements[0].1.contains("Go"));
        assert_eq!(replacements[0].2, 2); // "Rust" appears twice in note1
    }

    #[test]
    fn test_update_doc() {
        let mut engine = make_engine();
        engine.update_doc(
            Path::new("/vault/note1.md"),
            "# Updated\nNew content about TypeScript.",
            vec!["typescript".to_string()],
            Some("Updated".to_string()),
            Vec::new(),
            HashMap::new(),
        );
        let query = parse_query("typescript").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(results.len(), 1);

        // Old content should not match
        let query2 = parse_query("\"rust programming\"").unwrap();
        let results2 = engine.search(&query2, 10);
        assert!(results2.is_empty() || !results2.iter().any(|r| r.path.contains("note1")));
    }

}
