// In-memory inverted index for full-text notebox search.
// Built on notebox open, incrementally updated on file changes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::note::PropertyValue;
use crate::search::query::{FilterKind, QueryNode};
use crate::search::results::{compute_score, SearchResult};
use crate::storage::to_frontend_string;

/// How a search treats text inside `#annotation[…]` / `#suggestion[…]` marks.
/// Drives the SearchPanel's tri-state annotation toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationScope {
    /// Search everything — body prose and annotation/suggestion text alike.
    #[default]
    All,
    /// Restrict matches to lines within an annotation/suggestion (the
    /// "Annotations only" scope; an empty query browses every annotation).
    Only,
    /// Hide matches that fall inside an annotation/suggestion — search only
    /// the surrounding body prose.
    Exclude,
}

impl AnnotationScope {
    /// True when `line_idx` (a line carrying an annotation/suggestion call)
    /// should be kept under this scope.
    fn keeps_annotation_line(self, is_annotation_line: bool) -> bool {
        match self {
            AnnotationScope::All => true,
            AnnotationScope::Only => is_annotation_line,
            AnnotationScope::Exclude => !is_annotation_line,
        }
    }
}

/// A note's properties as `key → [values]` for `property:key=value` filters.
/// Values are lowercased; `file.*` properties are skipped.
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

/// Collection members for `collection:` filters: lowercased name → note paths.
/// The command layer resolves this; the engine only intersects it. Empty when a
/// query names no collections.
pub type CollectionMembership = HashMap<String, HashSet<PathBuf>>;

/// Position of a word within a document: (line_number, word_offset_in_line, char_start, char_end).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WordPosition {
    line: usize,
    word_index: usize,
    char_start: usize,
    char_end: usize,
}

/// Index data for one document. `Default` is a tombstone: an empty entry in a
/// freed slot until reused. Its empty path never matches `path_to_doc`, so
/// iterations skip it (see `remove_doc`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DocEntry {
    path: PathBuf,
    file_name: String,
    /// Title from the `#note(title: ...)` property, if any.
    title: Option<String>,
    /// Lowercased first level-1 heading, used for the title bonus when `title`
    /// isn't set.
    first_h1: Option<String>,
    /// Tags extracted from the document.
    tags: Vec<String>,
    /// Lowercased property keys, so `property:name` filters can be checked
    /// here.
    property_keys: Vec<String>,
    /// Lowercased property values by key, for `property:key=value` (substring
    /// match).
    property_values: HashMap<String, Vec<String>>,
    /// Lines of the document (for context retrieval).
    lines: Vec<String>,
    /// Total word count.
    word_count: usize,
    /// Heading text (lowercased) extracted from `=`-prefix lines. Used by
    /// the `section:` filter.
    headings: Vec<String>,
    /// Lines that are the notebox import. Kept in `lines` so line numbers match
    /// the source, but excluded from indexing, matching, snippets and context.
    import_line_indices: Vec<usize>,
    /// Tag name → line indices of its `#tag("…")` calls, so `tag:` results open
    /// on the tag.
    tag_locations: HashMap<String, Vec<usize>>,
    /// Lines inside `#annotation[…]` / `#suggestion[…]`, for the Annotations
    /// scope and `annotation:` filter. `#[serde(default)]` keeps older saved
    /// indexes loadable.
    #[serde(default)]
    annotation_lines: Vec<usize>,
    /// Concatenated, lowercased body prose of every annotation/suggestion in
    /// the doc, for the `annotation:` filter's substring match.
    #[serde(default)]
    annotation_text: String,
    /// Filesystem modification time, Unix seconds. Defaulted to 0 if the
    /// file's metadata could not be read.
    modified_time: i64,
    /// Filesystem creation time, Unix seconds. Falls back to
    /// `modified_time` on platforms that don't expose creation time.
    created_time: i64,
}

/// The inverted index: word → list of (doc_id, positions).
type PostingList = Vec<(usize, Vec<WordPosition>)>;

/// Compile a search pattern with a size limit, since patterns can come from
/// shared queries. The `regex` crate doesn't backtrack, so size is the only
/// risk. `None` for invalid or oversized patterns, which match nothing.
fn compile_bounded_regex(pattern: &str) -> Option<Regex> {
    const SIZE_LIMIT: usize = 1 << 20; // 1 MiB compiled program
    const DFA_SIZE_LIMIT: usize = 1 << 20; // 1 MiB lazy-DFA cache
    regex::RegexBuilder::new(pattern)
        .size_limit(SIZE_LIMIT)
        .dfa_size_limit(DFA_SIZE_LIMIT)
        .build()
        .ok()
}

/// Full-text search engine with an in-memory inverted index.
#[derive(Serialize, Deserialize)]
pub struct SearchEngine {
    /// Documents by id. Freed slots hold a tombstone and are listed in
    /// `free_ids`; the vec never shrinks, so ids stay valid in posting lists.
    docs: Vec<DocEntry>,
    /// Path → doc index for fast lookup.
    path_to_doc: HashMap<PathBuf, usize>,
    /// Inverted index: lowercase word → posting list.
    index: HashMap<String, PostingList>,
    /// Per doc id, the words it added, so `remove_doc` only touches those
    /// posting lists. Empty for tombstones.
    #[serde(default)]
    doc_words: Vec<Vec<String>>,
    /// Freed doc ids, reused so `docs` doesn't grow while one note is reindexed
    /// repeatedly.
    #[serde(default)]
    free_ids: Vec<usize>,
}

impl Default for SearchEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SearchEngine {
    pub fn new() -> Self {
        Self {
            docs: Vec::new(),
            path_to_doc: HashMap::new(),
            index: HashMap::new(),
            doc_words: Vec::new(),
            free_ids: Vec::new(),
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

    pub fn all_indexed_paths(&self) -> Vec<PathBuf> {
        self.path_to_doc.keys().cloned().collect()
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
            .map(
                |(path, content, tags, title, property_keys, property_values)| {
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
                },
            )
            .collect();

        for built in processed {
            let doc_id = engine.docs.len();
            engine.path_to_doc.insert(built.entry.path.clone(), doc_id);
            engine.docs.push(built.entry);
            let mut words = Vec::with_capacity(built.word_positions.len());
            for (word, positions) in built.word_positions {
                words.push(word.clone());
                engine
                    .index
                    .entry(word)
                    .or_default()
                    .push((doc_id, positions));
            }
            engine.doc_words.push(words);
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
        // Remove old entry if it exists (frees its slot for reuse below).
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

        // Reuse a freed slot when one is available so `docs` (and the per-doc
        // `lines` it holds) doesn't grow on every re-index; otherwise append.
        let doc_id = match self.free_ids.pop() {
            Some(id) => {
                self.docs[id] = built.entry;
                id
            }
            None => {
                let id = self.docs.len();
                self.docs.push(built.entry);
                self.doc_words.push(Vec::new());
                id
            }
        };
        self.path_to_doc.insert(path.to_path_buf(), doc_id);

        let mut words = Vec::with_capacity(built.word_positions.len());
        for (word, positions) in built.word_positions {
            words.push(word.clone());
            self.index
                .entry(word)
                .or_default()
                .push((doc_id, positions));
        }
        self.doc_words[doc_id] = words;
    }

    /// Remove a document. Only the posting lists of its own words (`doc_words`)
    /// are touched, so cost scales with the note, not the notebox. Its slot is
    /// tombstoned for reuse, and empty posting lists are dropped.
    pub fn remove_doc(&mut self, path: &Path) {
        let Some(doc_id) = self.path_to_doc.remove(path) else {
            return;
        };
        // Take the word list out so we can mutate `self.index` without an
        // overlapping borrow of `self.doc_words`.
        let words = self
            .doc_words
            .get_mut(doc_id)
            .map(std::mem::take)
            .unwrap_or_default();
        for word in &words {
            let now_empty = if let Some(posting) = self.index.get_mut(word) {
                if let Some(pos) = posting.iter().position(|(id, _)| *id == doc_id) {
                    posting.swap_remove(pos);
                }
                posting.is_empty()
            } else {
                false
            };
            if now_empty {
                self.index.remove(word);
            }
        }
        // Free the heavy DocEntry payload (notably its `lines`) and mark the
        // slot reusable; the vec keeps its length so existing doc-ids stay valid.
        if let Some(slot) = self.docs.get_mut(doc_id) {
            *slot = DocEntry::default();
        }
        self.free_ids.push(doc_id);
    }

    /// Run a query and return ranked results, one per matching line (the
    /// frontend groups by file). Notebox import lines are excluded.
    pub fn search(&self, query: &QueryNode, max_results: usize) -> Vec<SearchResult> {
        // Without collection data here, a `collection:` filter matches nothing.
        let empty = CollectionMembership::new();
        let mut results = self.collect_ranked_results(query, AnnotationScope::All, None, &empty);
        results.truncate(max_results);
        results
    }

    /// Like [`search`], with the total count before truncation and an offset
    /// for paging. `annotation_scope` searches annotation and suggestion lines
    /// too, not at all, or only (the Annotations toggle).
    ///
    /// `verify_span` makes the search case-sensitive: lines are found
    /// case-insensitively, then each matched span is checked with it. Done
    /// before counting, so `total_count` matches the pages.
    pub fn search_paginated(
        &self,
        query: &QueryNode,
        offset: usize,
        limit: usize,
        annotation_scope: AnnotationScope,
        verify_span: Option<&dyn Fn(&str) -> bool>,
        collections: &CollectionMembership,
    ) -> (Vec<SearchResult>, usize) {
        let results =
            self.collect_ranked_results(query, annotation_scope, verify_span, collections);
        let total_count = results.len();
        let page = results.into_iter().skip(offset).take(limit).collect();
        (page, total_count)
    }

    /// Evaluate the query and build results sorted by score. `annotation_scope`
    /// filters lines by annotation membership. With `verify_span`, rejected
    /// spans are removed and a line with none left is dropped.
    fn collect_ranked_results(
        &self,
        query: &QueryNode,
        annotation_scope: AnnotationScope,
        verify_span: Option<&dyn Fn(&str) -> bool>,
        collections: &CollectionMembership,
    ) -> Vec<SearchResult> {
        let matches = self.evaluate(query, collections);
        let mut results: Vec<SearchResult> = Vec::new();

        for (doc_id, line_matches) in &matches {
            let doc = match self.docs.get(*doc_id) {
                Some(d) => d,
                None => continue,
            };
            if self.path_to_doc.get(&doc.path) != Some(doc_id) {
                continue;
            }

            // Per-document score factors, shared by its lines.
            let total_match_count: usize = line_matches.values().map(|v| v.len()).sum();
            let match_in_filename = {
                let fname_lower = doc.file_name.to_lowercase();
                self.query_matches_text(query, &fname_lower)
            };
            // The title bonus applies once if the query matches the
            // `#note(title: …)` or the first level-1 heading.
            let match_in_title = {
                let in_property = doc.title.as_ref().is_some_and(|t| {
                    let t_lower = t.to_lowercase();
                    self.query_matches_text(query, &t_lower)
                });
                in_property
                    || doc
                        .first_h1
                        .as_ref()
                        .is_some_and(|t| self.query_matches_text(query, t))
            };
            let doc_score = compute_score(
                match_in_filename,
                match_in_title,
                total_match_count,
                doc.word_count,
            );

            // Where the query matches the file name, for highlighting.
            let file_name_ranges = query_filename_ranges(query, &doc.file_name);

            // Walk matches in source order so the UI shows them in the
            // same order they appear in the file.
            let mut sorted_lines: Vec<(usize, &Vec<WordPosition>)> = line_matches
                .iter()
                .filter(|(line_idx, _)| !doc.import_line_indices.contains(line_idx))
                .filter(|(line_idx, _)| {
                    annotation_scope.keeps_annotation_line(doc.annotation_lines.contains(line_idx))
                })
                .map(|(line, positions)| (*line, positions))
                .collect();
            sorted_lines.sort_by_key(|(line, _)| *line);

            for (line_idx, positions) in sorted_lines {
                let line_text = doc.lines.get(line_idx).cloned().unwrap_or_default();
                let mut match_ranges: Vec<(usize, usize)> = positions
                    .iter()
                    .map(|p| (p.char_start, p.char_end))
                    .collect();

                // Case-sensitive check. `char_start` / `char_end` are byte
                // offsets here (converted to UTF-16 later), so the slice lands
                // on char boundaries.
                if let Some(verify) = verify_span {
                    match_ranges.retain(|(s, e)| line_text.get(*s..*e).is_some_and(verify));
                    if match_ranges.is_empty() {
                        continue;
                    }
                }

                let (context_before, context_after) =
                    collect_context(&doc.lines, &doc.import_line_indices, line_idx, 2);

                results.push(SearchResult {
                    path: to_frontend_string(&doc.path),
                    file_name: doc.file_name.clone(),
                    line_number: line_idx + 1,
                    line_text,
                    match_ranges,
                    file_name_ranges: file_name_ranges.clone(),
                    // A small per-match bonus ranks the busier lines of a file
                    // slightly higher.
                    score: doc_score + (positions.len() as f64) * 0.01,
                    modified_time: doc.modified_time,
                    created_time: doc.created_time,
                    // Filled in by the command layer, which holds the
                    // property index.
                    zid: None,
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
        results
    }

    /// Evaluate a query node, returning matching doc_ids with per-line positions.
    fn evaluate(
        &self,
        node: &QueryNode,
        collections: &CollectionMembership,
    ) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        match node {
            QueryNode::Term(term) => self.find_term(term),
            QueryNode::Phrase(words) => self.find_phrase(words),
            QueryNode::Wildcard(pattern) => self.find_wildcard(pattern),
            QueryNode::Regex(pattern) => self.find_regex(pattern),
            QueryNode::Filter { kind, value } => self.find_filter(kind, value, collections),
            QueryNode::And(left, right) => {
                // `foo -bar`: evaluate the positive side and subtract the
                // excluded documents, rather than building a notebox-wide
                // complement for `Not`.
                if let QueryNode::Not(inner) = right.as_ref() {
                    return self.evaluate_and_not(left, inner, collections);
                }
                if let QueryNode::Not(inner) = left.as_ref() {
                    return self.evaluate_and_not(right, inner, collections);
                }
                let left_matches = self.evaluate(left, collections);
                let right_matches = self.evaluate(right, collections);
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
                let mut result = self.evaluate(left, collections);
                let right_matches = self.evaluate(right, collections);
                for (doc_id, lines) in right_matches {
                    let entry = result.entry(doc_id).or_default();
                    for (line, positions) in lines {
                        entry.entry(line).or_default().extend(positions);
                    }
                }
                result
            }
            QueryNode::Not(inner) => {
                let exclude = self.evaluate(inner, collections);
                // Return all docs NOT in the exclude set
                let mut result = HashMap::new();
                for (doc_id, doc) in self.docs.iter().enumerate() {
                    if !exclude.contains_key(&doc_id)
                        && self.path_to_doc.get(&doc.path) == Some(&doc_id)
                    {
                        // Include with first line as placeholder
                        let mut lines = HashMap::new();
                        if !doc.lines.is_empty() {
                            lines.insert(
                                0,
                                vec![WordPosition {
                                    line: 0,
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
            QueryNode::Proximity {
                left,
                right,
                distance,
                ordered,
            } => self.find_proximity(left, right, *distance, *ordered),
        }
    }

    /// `positive AND NOT excluded`: keep the positive matches, minus the
    /// documents the excluded side matches.
    fn evaluate_and_not(
        &self,
        positive: &QueryNode,
        excluded: &QueryNode,
        collections: &CollectionMembership,
    ) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        let mut matches = self.evaluate(positive, collections);
        let exclude = self.evaluate(excluded, collections);
        matches.retain(|doc_id, _| !exclude.contains_key(doc_id));
        matches
    }

    /// Documents whose body contains `term`. [`find_term`] also matches file
    /// names; phrase matching uses this directly.
    fn find_term_body(&self, term: &str) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
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

    /// Documents containing `term` in the body or file name. A file-name-only
    /// match is shown with a representative line and gets the file-name bonus.
    /// File names match whole words, like the body: `ink` finds "Ink and
    /// Switch" but not "Linked thinking"; `ink*` widens it. (`file:` keeps its
    /// substring rule.)
    fn find_term(&self, term: &str) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        // `term` is already lowercased by the query parser.
        let mut result = self.find_term_body(term);
        self.add_filename_matches(&mut result, |name| {
            !filename_word_ranges(name, |word| word == term).is_empty()
        });
        result
    }

    /// A placeholder match for a document matched as a whole (a filter or file
    /// name): the first non-empty, non-import line with an empty range.
    fn representative_line_match(&self, doc: &DocEntry) -> HashMap<usize, Vec<WordPosition>> {
        let representative = doc
            .lines
            .iter()
            .enumerate()
            .find(|(idx, line)| !doc.import_line_indices.contains(idx) && !line.trim().is_empty())
            .map(|(idx, _)| idx)
            .unwrap_or(0);
        let mut lines = HashMap::new();
        lines.insert(
            representative,
            vec![WordPosition {
                line: representative,
                word_index: 0,
                char_start: 0,
                char_end: 0,
            }],
        );
        lines
    }

    /// Add documents whose lowercased file name satisfies `matches_name`.
    /// Existing matches keep their positions; new ones get a representative
    /// line. Shadowed duplicate paths are skipped.
    fn add_filename_matches(
        &self,
        result: &mut HashMap<usize, HashMap<usize, Vec<WordPosition>>>,
        matches_name: impl Fn(&str) -> bool,
    ) {
        for (doc_id, doc) in self.docs.iter().enumerate() {
            if self.path_to_doc.get(&doc.path) != Some(&doc_id) {
                continue;
            }
            if result.contains_key(&doc_id) {
                continue;
            }
            if matches_name(&doc.file_name.to_lowercase()) {
                result.insert(doc_id, self.representative_line_match(doc));
            }
        }
    }

    /// Find documents containing an exact phrase (sequence of words on the same line).
    fn find_phrase(&self, words: &[String]) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        if words.is_empty() {
            return HashMap::new();
        }

        // Seed from body positions; file names have no word positions, so
        // phrase matches on names are added at the end.
        let first_matches = self.find_term_body(&words[0]);
        let mut result = HashMap::new();

        for (doc_id, line_positions) in &first_matches {
            // Per document, map (line, word index) → position for each later
            // phrase word, scanning each posting list once.
            let tail_maps: Vec<HashMap<(usize, usize), &WordPosition>> = words[1..]
                .iter()
                .map(|word| {
                    let mut map = HashMap::new();
                    if let Some(posting) = self.index.get(word.as_str()) {
                        if let Some((_, poss)) = posting.iter().find(|(did, _)| did == doc_id) {
                            for p in poss {
                                map.insert((p.line, p.word_index), p);
                            }
                        }
                    }
                    map
                })
                .collect();

            // If any tail word never appears in this doc, no phrase can match.
            if tail_maps.iter().any(|m| m.is_empty()) {
                continue;
            }

            let mut valid_lines: HashMap<usize, Vec<WordPosition>> = HashMap::new();
            for (line, positions) in line_positions {
                for start_pos in positions {
                    let mut phrase_positions = vec![start_pos.clone()];
                    let mut all_match = true;
                    for (offset, map) in tail_maps.iter().enumerate() {
                        let expected = (*line, start_pos.word_index + offset + 1);
                        match map.get(&expected) {
                            Some(p) => phrase_positions.push((*p).clone()),
                            None => {
                                all_match = false;
                                break;
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

        // Also match the phrase as consecutive whole words of the file name.
        self.add_filename_matches(&mut result, |name| {
            !filename_phrase_ranges(name, words).is_empty()
        });

        result
    }

    /// Find documents with words matching a wildcard pattern (e.g., "hel*").
    fn find_wildcard(&self, pattern: &str) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        // Convert glob pattern to regex
        let regex_pattern = format!("^{}$", pattern.replace('*', ".*"));
        let re = match compile_bounded_regex(&regex_pattern) {
            Some(r) => r,
            None => return HashMap::new(),
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

        // Match file names a word at a time, as body words are, so `ink*`
        // doesn't match and highlight whole names.
        self.add_filename_matches(&mut result, |name| {
            !filename_word_ranges(name, |word| re.is_match(word)).is_empty()
        });

        result
    }

    /// Find documents with lines matching a regex pattern.
    fn find_regex(&self, pattern: &str) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        let re = match compile_bounded_regex(pattern) {
            Some(r) => r,
            None => return HashMap::new(),
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
        collections: &CollectionMembership,
    ) -> HashMap<usize, HashMap<usize, Vec<WordPosition>>> {
        let value_lower = value.to_lowercase();
        // Compare paths with forward slashes on both sides, so a folder from
        // the file tree matches on Windows too.
        let path_value = value_lower.replace('\\', "/");
        let mut result = HashMap::new();

        for (doc_id, doc) in self.docs.iter().enumerate() {
            if self.path_to_doc.get(&doc.path) != Some(&doc_id) {
                continue;
            }

            let matches = match kind {
                FilterKind::Path => to_frontend_string(&doc.path)
                    .to_lowercase()
                    .contains(&path_value),
                FilterKind::File => doc.file_name.to_lowercase().contains(&value_lower),
                FilterKind::Tag => doc
                    .tags
                    .iter()
                    .any(|t| t.to_lowercase().contains(&value_lower)),
                FilterKind::Section => {
                    // Notes with a heading containing the value. Headings are
                    // collected when indexing.
                    doc.headings.iter().any(|h| h.contains(&value_lower))
                }
                FilterKind::Property => {
                    // `property:name` matches notes with the key;
                    // `property:name=value` also needs one of its values to
                    // contain `value` (case-insensitive), so `draft` matches
                    // `drafts` too.
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
                        doc.property_keys.iter().any(|k| k.contains(&value_lower))
                    }
                }
                FilterKind::Annotation => {
                    // `annotation:` matches any note with an annotation;
                    // `annotation:foo` one whose annotation contains `foo`.
                    if value_lower.is_empty() {
                        !doc.annotation_lines.is_empty()
                    } else {
                        doc.annotation_text.contains(&value_lower)
                    }
                }
                FilterKind::Collection => {
                    // Membership comes from the command layer.
                    collections
                        .get(&value_lower)
                        .is_some_and(|members| members.contains(&doc.path))
                }
            };

            if matches {
                // `tag:` results open on the `#tag("…")` call rather than the
                // first line, which is usually in `#note(...)`.
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
                // `annotation:` results open on the matching annotation lines
                // (all of them for a bare `annotation:`).
                if let FilterKind::Annotation = kind {
                    for &line_idx in &doc.annotation_lines {
                        if doc.import_line_indices.contains(&line_idx) {
                            continue;
                        }
                        let hit = value_lower.is_empty()
                            || doc
                                .lines
                                .get(line_idx)
                                .is_some_and(|l| l.to_lowercase().contains(&value_lower));
                        if hit {
                            lines.entry(line_idx).or_default().push(WordPosition {
                                line: line_idx,
                                word_index: 0,
                                char_start: 0,
                                char_end: 0,
                            });
                        }
                    }
                }

                // Otherwise use the first non-empty, non-import line. Also
                // covers a tag set only in `#note(tags: …)`.
                if lines.is_empty() {
                    lines = self.representative_line_match(doc);
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
                                a.abs_diff(b)
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
                compile_bounded_regex(&regex_pattern)
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
        use_regex: bool,
    ) -> Vec<(PathBuf, String, usize)> {
        let base = if use_regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let pattern = if case_sensitive {
            base
        } else {
            format!("(?i){}", base)
        };
        let re = match compile_bounded_regex(&pattern) {
            Some(r) => r,
            None => return Vec::new(),
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

/// Byte ranges of the whole words in `text` that satisfy `pred`, each word
/// lowercased before the test. Uses the body index's word rules
/// (`text_projection::word_boundaries`), so a term matches a file name as a
/// whole word, and only the matching word is highlighted.
fn filename_word_ranges(text: &str, pred: impl Fn(&str) -> bool) -> Vec<(usize, usize)> {
    crate::search::text_projection::word_boundaries(text)
        .into_iter()
        .filter(|(_, word)| pred(&word.to_lowercase()))
        .map(|(offset, word)| (offset, offset + word.len()))
        .collect()
}

/// Byte ranges in `text` where `words` occur as a consecutive run of whole
/// words — the file-name counterpart of a body phrase match.
fn filename_phrase_ranges(text: &str, words: &[String]) -> Vec<(usize, usize)> {
    if words.is_empty() {
        return Vec::new();
    }
    let found = crate::search::text_projection::word_boundaries(text);
    let mut out = Vec::new();
    for run in found.windows(words.len()) {
        if run
            .iter()
            .zip(words)
            .all(|((_, word), wanted)| word.to_lowercase() == *wanted)
        {
            let (start, _) = run[0];
            let (last_offset, last_word) = run[run.len() - 1];
            out.push((start, last_offset + last_word.len()));
        }
    }
    out
}

/// Byte ranges in `text` matched by the query's literal words
/// (case-insensitive, overlaps merged), for highlighting file names. Filters,
/// negations, proximity and regex add nothing.
fn query_filename_ranges(node: &QueryNode, text: &str) -> Vec<(usize, usize)> {
    let mut ranges = collect_filename_ranges(node, text);
    merge_ranges(&mut ranges);
    ranges
}

fn collect_filename_ranges(node: &QueryNode, text: &str) -> Vec<(usize, usize)> {
    match node {
        QueryNode::Term(term) => filename_word_ranges(text, |word| word == term),
        QueryNode::Phrase(words) => filename_phrase_ranges(text, words),
        QueryNode::Wildcard(pattern) => {
            // Highlight only the words the pattern matched (`ink*` marks
            // "InkyCap", not the whole name), as `find_wildcard` matches.
            let anchored = format!("^{}$", pattern.replace('*', ".*"));
            match compile_bounded_regex(&anchored) {
                Some(re) => filename_word_ranges(text, |word| re.is_match(word)),
                None => Vec::new(),
            }
        }
        QueryNode::And(left, right) | QueryNode::Or(left, right) => {
            let mut out = collect_filename_ranges(left, text);
            out.extend(collect_filename_ranges(right, text));
            out
        }
        _ => Vec::new(),
    }
}

/// Sort and merge overlapping or touching ranges so the frontend's
/// left-to-right slicer never double-counts a character.
fn merge_ranges(ranges: &mut Vec<(usize, usize)>) {
    ranges.sort_by_key(|(start, _)| *start);
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges.drain(..) {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    *ranges = merged;
}

/// Tokenize one document for the engine.
///
/// Words come from [`text_projection::project`], which walks the Typst syntax
/// tree and yields rendered words, so markup is stripped: `_italicize_` is
/// found by `italicize`, `#highlight[yellow]` by `yellow`.
///
/// `doc.lines` keeps the raw source for snippets, and match ranges are byte
/// offsets in it. The notebox import line isn't indexed but stays in `lines`
/// so line numbers match the source.
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
        if crate::notebox_package::is_notebox_import_line(line) {
            import_line_indices.push(line_idx);
        }
    }

    let projection = crate::search::text_projection::project(content);

    // Word indices per line in source order, so phrase search can check
    // adjacency.
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

    let property_keys_lower: Vec<String> = property_keys.iter().map(|k| k.to_lowercase()).collect();

    DocBuild {
        entry: DocEntry {
            path,
            file_name,
            title,
            first_h1: projection.first_h1,
            tags,
            property_keys: property_keys_lower,
            property_values,
            lines,
            word_count,
            headings: projection.headings,
            import_line_indices,
            tag_locations: projection.tag_locations,
            annotation_lines: projection.annotation_lines,
            annotation_text: projection.annotation_text,
            modified_time,
            created_time,
        },
        word_positions: local_index.into_iter().collect(),
    }
}

/// Up to `window` lines either side of `line_idx`, skipping import lines, in
/// source order.
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
                PathBuf::from("/notebox/note1.md"),
                "# Hello World\nThis is a test note about Rust programming.\nRust is great for systems.".to_string(),
                vec!["rust".to_string(), "programming".to_string()],
                Some("Hello World".to_string()),
                Vec::new(),
                HashMap::new(),
            ),
            (
                PathBuf::from("/notebox/note2.md"),
                "# Another Note\nPython is also a great language.\nBut Rust is faster.".to_string(),
                vec!["python".to_string()],
                Some("Another Note".to_string()),
                Vec::new(),
                HashMap::new(),
            ),
            (
                PathBuf::from("/notebox/daily/2024-01-01.md"),
                "# Daily Note\nToday I learned about search engines.\nFull-text search is powerful.".to_string(),
                vec!["daily".to_string()],
                None,
                Vec::new(),
                HashMap::new(),
            ),
        ])
    }

    /// Distinct files among the results (search returns one row per line).
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
    fn annotation_filter_and_scope() {
        // "citation" appears on a plain body line AND inside an annotation.
        let engine = SearchEngine::build(vec![(
            PathBuf::from("/notebox/n.md"),
            "Plain body mentions citation here.\n\n#annotation[please add a citation]\n"
                .to_string(),
            Vec::new(),
            None,
            Vec::new(),
            HashMap::new(),
        )]);

        // `annotation:citation` matches the annotation body.
        let q = parse_query("annotation:citation").unwrap();
        assert_eq!(unique_paths(&engine.search(&q, 10)), 1);

        // A word only in plain prose isn't an annotation match.
        let q = parse_query("annotation:mentions").unwrap();
        assert!(engine.search(&q, 10).is_empty());

        // Bare annotation filter (empty value) → any note with an annotation.
        let q = QueryNode::Filter {
            kind: FilterKind::Annotation,
            value: String::new(),
        };
        assert_eq!(unique_paths(&engine.search(&q, 10)), 1);

        // Plain "citation" matches both the body and the annotation line.
        let q = parse_query("citation").unwrap();
        let no_collections = CollectionMembership::new();
        let (all, _) =
            engine.search_paginated(&q, 0, 50, AnnotationScope::All, None, &no_collections);
        assert_eq!(all.len(), 2);

        // With the annotations-only scope, only the annotation line survives.
        let (scoped, _) =
            engine.search_paginated(&q, 0, 50, AnnotationScope::Only, None, &no_collections);
        assert_eq!(scoped.len(), 1);
        assert!(scoped[0].line_text.contains("#annotation["));

        // The exclude scope is the complement: the annotation line drops out,
        // leaving only the plain-prose hit.
        let (excluded, _) =
            engine.search_paginated(&q, 0, 50, AnnotationScope::Exclude, None, &no_collections);
        assert_eq!(excluded.len(), 1);
        assert!(!excluded[0].line_text.contains("#annotation["));
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
        // Only note1 has both words; `rust` is on two of its lines, so two
        // rows.
        assert_eq!(unique_paths(&results), 1);
        assert!(results.iter().all(|r| r.path.contains("note1")));
    }

    #[test]
    fn plain_term_matches_filename() {
        let engine = make_engine();
        // "note1" is in the file name note1.md but appears on no body line.
        let query = parse_query("note1").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(unique_paths(&results), 1);
        assert!(results[0].path.contains("note1"));
        // The placeholder points at a real, non-empty body line so the
        // result still shows a readable snippet.
        assert!(!results[0].line_text.trim().is_empty());
    }

    #[test]
    fn filename_match_composes_with_boolean_query() {
        let engine = make_engine();
        // `note1` matches only the file name and `rust` the bodies of note1 and
        // note2; the AND keeps note1, so file-name hits combine like any other
        // match.
        let query = parse_query("note1 rust").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(unique_paths(&results), 1);
        assert!(results.iter().all(|r| r.path.contains("note1")));

        // A word in neither any body nor any filename matches nothing.
        let query = parse_query("nonexistentname").unwrap();
        assert!(engine.search(&query, 10).is_empty());
    }

    #[test]
    fn filename_ranges_mark_the_matched_span() {
        let engine = make_engine();
        // "note1" sits at the start of the file stem "note1"; the highlight
        // range should cover exactly those five characters.
        let query = parse_query("note1").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(unique_paths(&results), 1);
        assert_eq!(results[0].file_name_ranges, vec![(0, 5)]);

        // A filter-only query highlights nothing in the file name.
        let query = parse_query("tag:rust").unwrap();
        let results = engine.search(&query, 10);
        assert!(results.iter().all(|r| r.file_name_ranges.is_empty()));
    }

    #[test]
    fn filename_ranges_survive_boolean_and_overlap() {
        // The screenshot case: `path:"…" km` — the path filter contributes no
        // highlight, the plain term highlights "km" in the file name.
        let engine = SearchEngine::build(vec![(
            PathBuf::from("/notebox/Consultations/KM about things.md"),
            "#note(title: \"KM\")\nBody text without the term.".to_string(),
            Vec::new(),
            Some("KM".to_string()),
            Vec::new(),
            HashMap::new(),
        )]);
        let query = parse_query("path:\"Consultations/\" km").unwrap();
        let results = engine.search(&query, 10);
        assert_eq!(unique_paths(&results), 1);
        // "KM" is the first two characters of the file stem.
        assert_eq!(results[0].file_name_ranges, vec![(0, 2)]);
    }

    #[test]
    fn filename_match_ranks_by_filename_bonus() {
        let engine = make_engine();
        // "note2" is only in note2's filename; the filename bonus should make
        // it the top result even though other notes mention "note" in prose.
        let query = parse_query("note2").unwrap();
        let results = engine.search(&query, 10);
        assert!(!results.is_empty());
        assert!(results[0].path.contains("note2"));
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
        // Same key, different values: `property:status=draft` matches only the
        // first.
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

        // A quoted value doesn't swallow the rest of the query.
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
    fn path_filter_matches_across_separators() {
        // Indexed paths carry the OS-native separator; the filter value comes
        // from the file tree (or the user) with forward slashes.
        let engine = SearchEngine::build(vec![(
            PathBuf::from(r"C:\notebox\Archive\2024\note.md"),
            "body".to_string(),
            Vec::new(),
            None,
            Vec::new(),
            HashMap::new(),
        )]);
        for query in [
            "path:\"archive/2024/\"",
            "path:archive",
            r"path:archive\2024",
        ] {
            let node = parse_query(query).unwrap();
            assert_eq!(engine.search(&node, 10).len(), 1, "{query} should match");
        }
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
        let paths = vec![PathBuf::from("/notebox/note1.md")];
        let replacements = engine.search_and_replace("Rust", "Go", &paths, true, false);
        assert_eq!(replacements.len(), 1);
        assert!(replacements[0].1.contains("Go"));
        assert_eq!(replacements[0].2, 2); // "Rust" appears twice in note1
    }

    #[test]
    fn test_update_doc() {
        let mut engine = make_engine();
        engine.update_doc(
            Path::new("/notebox/note1.md"),
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

    #[test]
    fn remove_doc_prunes_empty_postings_and_frees_slot() {
        let mut engine = make_engine();
        let doc_count = engine.docs.len();

        // Removing note2 must drop `python` from the index, not leave an empty
        // posting list.
        engine.remove_doc(Path::new("/notebox/note2.md"));
        assert!(!engine.index.contains_key("python"));
        assert!(!engine
            .path_to_doc
            .contains_key(Path::new("/notebox/note2.md")));
        assert_eq!(engine.free_ids.len(), 1, "freed slot should be reusable");
        // The slot vec must not shrink (existing doc-ids stay valid).
        assert_eq!(engine.docs.len(), doc_count);

        // A search for the removed word finds nothing; other docs unaffected.
        assert!(engine
            .search(&parse_query("python").unwrap(), 10)
            .is_empty());
        assert!(!engine.search(&parse_query("rust").unwrap(), 10).is_empty());

        // Re-indexing a new note reuses the freed slot rather than growing docs.
        engine.update_doc(
            Path::new("/notebox/note4.md"),
            "# Fresh\nGo is a compiled language.",
            vec!["go".to_string()],
            Some("Fresh".to_string()),
            Vec::new(),
            HashMap::new(),
        );
        assert_eq!(
            engine.docs.len(),
            doc_count,
            "slot was reused, not appended"
        );
        assert!(engine.free_ids.is_empty());
        assert_eq!(
            unique_paths(&engine.search(&parse_query("go").unwrap(), 10)),
            1
        );
    }

    #[test]
    fn and_not_excludes_without_materializing_complement() {
        let engine = make_engine();
        // `rust -python`: note1 has rust and not python → kept; note2 has both
        // rust and python → excluded.
        let results = engine.search(&parse_query("rust -python").unwrap(), 10);
        assert!(results.iter().all(|r| r.path.contains("note1")));
        assert_eq!(unique_paths(&results), 1);
    }

    #[test]
    fn test_search_and_replace_empty_replacement() {
        let engine = make_engine();
        let paths = vec![PathBuf::from("/notebox/note1.md")];
        // Replace "Rust" with empty string (deletion)
        let replacements = engine.search_and_replace("Rust", "", &paths, true, false);
        assert_eq!(replacements.len(), 1, "Should have replaced in 1 file");
        assert!(
            !replacements[0].1.contains("Rust"),
            "Rust should be removed"
        );
        assert_eq!(replacements[0].2, 2);
    }

    #[test]
    fn test_search_and_replace_regex_empty_replacement() {
        let engine = make_engine();
        let paths = vec![PathBuf::from("/notebox/note1.md")];
        let replacements = engine.search_and_replace("Rust", "", &paths, true, true);
        assert_eq!(replacements.len(), 1, "Should have replaced in 1 file");
        assert!(
            !replacements[0].1.contains("Rust"),
            "Rust should be removed"
        );
    }

    /// Notes whose *names* exercise the whole-word rule. Bodies are unrelated
    /// so every assertion below is about file-name matching alone.
    fn name_engine() -> SearchEngine {
        let names = [
            "InkyCap",
            "Ink and Switch",
            "InkyCap - Build Binaries",
            "Linked thinking",
            "inkycapping notes",
        ];
        SearchEngine::build(
            names
                .iter()
                .map(|n| {
                    (
                        PathBuf::from(format!("/notebox/{n}.md")),
                        "unrelated body text\n".to_string(),
                        Vec::new(),
                        None,
                        Vec::new(),
                        HashMap::new(),
                    )
                })
                .collect(),
        )
    }

    /// File name stems of the matched notes, sorted.
    fn matched_names(engine: &SearchEngine, query: &str) -> Vec<String> {
        let node = parse_query(query).unwrap();
        let mut names: Vec<String> = engine
            .search(&node, 100)
            .iter()
            .map(|r| {
                r.path
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .trim_end_matches(".md")
                    .to_string()
            })
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// The matched note's name with its highlight ranges bracketed.
    fn highlighted_name(engine: &SearchEngine, query: &str, stem: &str) -> String {
        let node = parse_query(query).unwrap();
        let results = engine.search(&node, 100);
        let hit = results
            .iter()
            .find(|r| r.path.contains(stem))
            .unwrap_or_else(|| panic!("{query} did not match {stem}"));
        let name = stem;
        let mut out = String::new();
        let mut cursor = 0;
        for (start, end) in &hit.file_name_ranges {
            out.push_str(&name[cursor..*start]);
            out.push('[');
            out.push_str(&name[*start..*end]);
            out.push(']');
            cursor = *end;
        }
        out.push_str(&name[cursor..]);
        out
    }

    #[test]
    fn bare_term_matches_a_file_name_a_whole_word_at_a_time() {
        // A bare term matches file names as whole words, like body text.
        let engine = name_engine();
        assert_eq!(matched_names(&engine, "ink"), vec!["Ink and Switch"]);
        assert_eq!(
            matched_names(&engine, "inkycap"),
            vec!["InkyCap", "InkyCap - Build Binaries"]
        );
    }

    #[test]
    fn a_wildcard_is_how_a_partial_file_name_word_is_matched() {
        let engine = name_engine();
        assert_eq!(
            matched_names(&engine, "ink*"),
            vec![
                "Ink and Switch",
                "InkyCap",
                "InkyCap - Build Binaries",
                "inkycapping notes",
            ]
        );
        // Trailing wildcard, too — the pattern is anchored to the word, not
        // to the start of the name.
        assert_eq!(
            matched_names(&engine, "*cap"),
            vec!["InkyCap", "InkyCap - Build Binaries"]
        );
    }

    #[test]
    fn a_file_name_highlight_covers_only_the_word_that_matched() {
        let engine = name_engine();
        // A wildcard highlights only the matched word, not the whole name.
        assert_eq!(
            highlighted_name(&engine, "ink*", "InkyCap - Build Binaries"),
            "[InkyCap] - Build Binaries"
        );
        assert_eq!(
            highlighted_name(&engine, "inkycap", "InkyCap - Build Binaries"),
            "[InkyCap] - Build Binaries"
        );
    }

    #[test]
    fn a_quoted_phrase_matches_a_run_of_whole_file_name_words() {
        let engine = name_engine();
        assert_eq!(
            highlighted_name(&engine, "\"ink and switch\"", "Ink and Switch"),
            "[Ink and Switch]"
        );
    }

    #[test]
    fn the_file_filter_keeps_its_substring_rule() {
        // `file:` is explicit and scoped, and documented as substring — the
        // whole-word default applies to bare terms, not to this.
        let engine = name_engine();
        assert_eq!(matched_names(&engine, "file:ink").len(), 5);
    }
}
