//! Corpus statistics engine for the Mycelial View.
//!
//! Maintains unigram and bigram frequency tables across the notebox corpus,
//! enabling TF-IDF scoring and PMI-based collocation detection. These
//! statistics surface "emergent concepts" — terms that recur frequently
//! across connected notes but have no dedicated page yet.
//!
//! # Theory
//!
//! - **TF-IDF** (Term Frequency–Inverse Document Frequency): scores terms by
//!   local importance (frequent in a note) modulated by global rarity (not
//!   everywhere). High TF-IDF = distinctive vocabulary of a document cluster.
//!
//! - **PMI** (Pointwise Mutual Information): measures whether a bigram co-occurs
//!   more than independent chance predicts. High PMI = a meaningful phrase
//!   ("epistemic humility") rather than accidental adjacency ("the reason").
//!
//! - **Composite scoring**: for a given note's neighborhood (N-hop link graph),
//!   candidate terms are ranked by a weighted combination of TF-IDF (signal
//!   strength), PMI (phrase cohesion, bigrams only), and proximity (fraction of
//!   neighborhood documents containing the term).

pub mod config;
pub mod stopwords;
mod stopwords_data;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::search::text_projection::TextToken;
pub use config::MycelialConfig;

/// Separator used in bigram keys: "word1\x1fword2"
const BIGRAM_SEP: char = '\x1f';

/// The corpus-wide frequency statistics index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusStats {
    pub total_docs: usize,
    /// term → number of documents containing it
    pub doc_freq: HashMap<String, usize>,
    /// bigram key → number of documents containing the adjacent pair
    pub bigram_doc_freq: HashMap<String, usize>,
    /// bigram key → total corpus-wide occurrence count
    pub bigram_count: HashMap<String, usize>,
    /// term → total corpus-wide occurrence count
    pub unigram_count: HashMap<String, usize>,
    /// Total number of unigram tokens across the corpus (cached for PMI denominator)
    pub total_unigrams: usize,
    /// Total number of bigram token pairs across the corpus
    pub total_bigrams: usize,
    /// Per-document unique unigram sets (for neighborhood membership queries)
    doc_unigrams: HashMap<PathBuf, HashSet<String>>,
    /// Per-document bigram occurrence lists (for count subtraction on removal)
    doc_bigrams: HashMap<PathBuf, Vec<String>>,
    /// Per-document unique bigram sets (for fast neighborhood membership queries)
    doc_bigram_sets: HashMap<PathBuf, HashSet<String>>,
    /// Per-document total word count (for accurate TF-IDF)
    doc_word_count: HashMap<PathBuf, usize>,
    /// Active stopword set
    #[serde(skip)]
    stopwords: HashSet<String>,
}

/// A scored emergent concept suggestion — a recurring term/phrase that has
/// no page of its own yet.
#[derive(Debug, Clone, Serialize)]
pub struct EmergentConcept {
    pub term: String,
    pub score: f64,
    pub source_notes: Vec<String>,
    pub doc_count: usize,
    pub is_bigram: bool,
}

/// A scored latent-link candidate — a recurring term/phrase that *already*
/// matches an existing page, surfaced so the user can connect the notes that
/// mention it without a wikilink. `target_path` is the existing page; the
/// command layer filters `source_notes` down to notes that don't link it yet.
#[derive(Debug, Clone, Serialize)]
pub struct LatentCandidate {
    pub term: String,
    pub target_path: String,
    pub score: f64,
    pub source_notes: Vec<String>,
    pub doc_count: usize,
    pub is_bigram: bool,
}

/// The two kinds of growth signal surfaced for a note's neighborhood.
pub struct NeighborhoodAnalysis {
    pub emergent: Vec<EmergentConcept>,
    pub latent: Vec<LatentCandidate>,
}

impl CorpusStats {
    /// Create a new empty instance with stopwords loaded.
    pub fn new(notebox_root: Option<&Path>) -> Self {
        Self {
            total_docs: 0,
            doc_freq: HashMap::new(),
            bigram_doc_freq: HashMap::new(),
            bigram_count: HashMap::new(),
            unigram_count: HashMap::new(),
            total_unigrams: 0,
            total_bigrams: 0,
            doc_unigrams: HashMap::new(),
            doc_bigrams: HashMap::new(),
            doc_bigram_sets: HashMap::new(),
            doc_word_count: HashMap::new(),
            stopwords: stopwords::build_stopwords(notebox_root),
        }
    }

    /// Reload stopwords (e.g., after user edits the stopword/dictionary files).
    pub fn reload_stopwords(&mut self, notebox_root: Option<&Path>) {
        self.stopwords = stopwords::build_stopwords(notebox_root);
    }

    /// Build from a full set of documents (cold start).
    pub fn build(docs: &[(PathBuf, &str)], notebox_root: Option<&Path>) -> Self {
        let mut stats = Self::new(notebox_root);
        for (path, content) in docs {
            let tokens = crate::search::text_projection::project(content);
            stats.add_doc(path, &tokens.tokens);
        }
        stats
    }

    /// Add a document's contribution to corpus statistics.
    fn add_doc(&mut self, path: &Path, tokens: &[TextToken]) {
        self.total_docs += 1;

        let words: Vec<String> = tokens
            .iter()
            .map(|t| t.word.to_lowercase())
            .filter(|w| w.len() >= 2 && !self.stopwords.contains(w.as_str()))
            .collect();

        let word_count = words.len();
        self.total_unigrams += word_count;
        self.doc_word_count.insert(path.to_path_buf(), word_count);

        // Unigram document frequency + corpus counts
        let mut seen_unigrams: HashSet<String> = HashSet::new();
        for word in &words {
            *self.unigram_count.entry(word.clone()).or_insert(0) += 1;
            seen_unigrams.insert(word.clone());
        }
        for word in &seen_unigrams {
            *self.doc_freq.entry(word.clone()).or_insert(0) += 1;
        }

        // Bigrams: adjacent non-stopword tokens on the same line
        let bigrams_vec = extract_bigrams_from_tokens(tokens, &self.stopwords);
        self.total_bigrams += bigrams_vec.len();
        let mut seen_bigrams: HashSet<String> = HashSet::new();
        for bg in &bigrams_vec {
            *self.bigram_count.entry(bg.clone()).or_insert(0) += 1;
            seen_bigrams.insert(bg.clone());
        }
        for bg in &seen_bigrams {
            *self.bigram_doc_freq.entry(bg.clone()).or_insert(0) += 1;
        }

        // Store for incremental subtraction and neighborhood queries
        self.doc_unigrams.insert(path.to_path_buf(), seen_unigrams);
        self.doc_bigrams.insert(path.to_path_buf(), bigrams_vec);
        self.doc_bigram_sets.insert(path.to_path_buf(), seen_bigrams);
    }

    /// Remove a document's contribution from corpus statistics.
    fn remove_doc(&mut self, path: &Path) {
        if self.total_docs > 0 {
            self.total_docs -= 1;
        }

        // Subtract total word count
        if let Some(wc) = self.doc_word_count.remove(path) {
            self.total_unigrams = self.total_unigrams.saturating_sub(wc);
        }

        // Subtract unigram doc_freq
        if let Some(unigrams) = self.doc_unigrams.remove(path) {
            for word in &unigrams {
                if let Some(count) = self.doc_freq.get_mut(word) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        self.doc_freq.remove(word);
                        self.unigram_count.remove(word);
                    }
                }
            }
        }

        // Subtract bigram counts using the full occurrence list
        if let Some(bigrams) = self.doc_bigrams.remove(path) {
            self.total_bigrams = self.total_bigrams.saturating_sub(bigrams.len());
            for bg in &bigrams {
                if let Some(count) = self.bigram_count.get_mut(bg) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        self.bigram_count.remove(bg);
                    }
                }
            }
        }
        // Subtract bigram doc_freq using the unique set
        if let Some(bigram_set) = self.doc_bigram_sets.remove(path) {
            for bg in &bigram_set {
                if let Some(count) = self.bigram_doc_freq.get_mut(bg) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        self.bigram_doc_freq.remove(bg);
                    }
                }
            }
        }
    }

    /// Incrementally update statistics when a document changes.
    pub fn update_doc(&mut self, path: &Path, tokens: &[TextToken]) {
        self.remove_doc(path);
        self.add_doc(path, tokens);
    }

    /// Remove a document entirely (on file deletion).
    pub fn delete_doc(&mut self, path: &Path) {
        self.remove_doc(path);
    }

    /// Compute TF-IDF for a term in a specific document context.
    pub fn tfidf(&self, term: &str, term_count_in_doc: usize, doc_word_count: usize) -> f64 {
        if doc_word_count == 0 || self.total_docs == 0 {
            return 0.0;
        }
        let tf = term_count_in_doc as f64 / doc_word_count as f64;
        let df = self.doc_freq.get(term).copied().unwrap_or(0);
        if df == 0 {
            return 0.0;
        }
        let idf = (self.total_docs as f64 / df as f64).ln();
        tf * idf
    }

    /// Compute Pointwise Mutual Information for a bigram.
    pub fn pmi(&self, bigram_key: &str) -> f64 {
        if self.total_bigrams == 0 || self.total_unigrams == 0 {
            return 0.0;
        }
        let parts: Vec<&str> = bigram_key.split(BIGRAM_SEP).collect();
        if parts.len() != 2 {
            return 0.0;
        }
        let (w1, w2) = (parts[0], parts[1]);

        let p_bigram = self.bigram_count.get(bigram_key).copied().unwrap_or(0) as f64
            / self.total_bigrams as f64;
        let total_uni = self.total_unigrams as f64;
        let p_w1 = self.unigram_count.get(w1).copied().unwrap_or(0) as f64 / total_uni;
        let p_w2 = self.unigram_count.get(w2).copied().unwrap_or(0) as f64 / total_uni;

        if p_w1 == 0.0 || p_w2 == 0.0 || p_bigram == 0.0 {
            return 0.0;
        }

        (p_bigram / (p_w1 * p_w2)).log2()
    }

    /// Rank the `m` documents most semantically similar to `center` by
    /// cosine similarity over TF-IDF vectors. This widens a note's
    /// neighborhood beyond its (possibly sparse) link graph, so emergent
    /// concepts can be drawn from notes that are topologically distant but
    /// thematically related.
    pub fn similar_docs(&self, center: &Path, m: usize) -> Vec<PathBuf> {
        if self.total_docs == 0 || m == 0 {
            return Vec::new();
        }
        let Some(center_terms) = self.doc_unigrams.get(center) else {
            return Vec::new();
        };
        let idf = |term: &str| -> f64 {
            let df = self.doc_freq.get(term).copied().unwrap_or(0);
            if df == 0 {
                0.0
            } else {
                (self.total_docs as f64 / df as f64).ln()
            }
        };
        // doc_unigrams stores unique term *sets*, so per-doc term frequency is
        // approximated as 1/word_count — consistent with avg_tfidf_in_neighborhood.
        let center_wc = self
            .doc_word_count
            .get(center)
            .copied()
            .unwrap_or(1)
            .max(1) as f64;
        let center_vec: HashMap<&str, f64> = center_terms
            .iter()
            .map(|t| (t.as_str(), idf(t) / center_wc))
            .collect();
        let center_norm: f64 = center_vec.values().map(|w| w * w).sum::<f64>().sqrt();
        if center_norm == 0.0 {
            return Vec::new();
        }

        let mut scored: Vec<(f64, &PathBuf)> = Vec::new();
        for (path, terms) in &self.doc_unigrams {
            if path.as_path() == center {
                continue;
            }
            let wc = self.doc_word_count.get(path).copied().unwrap_or(1).max(1) as f64;
            let mut dot = 0.0;
            let mut norm_sq = 0.0;
            for t in terms {
                let w = idf(t) / wc;
                norm_sq += w * w;
                if let Some(cw) = center_vec.get(t.as_str()) {
                    dot += w * cw;
                }
            }
            let norm = norm_sq.sqrt();
            if norm == 0.0 {
                continue;
            }
            let cosine = dot / (center_norm * norm);
            if cosine > 0.0 {
                scored.push((cosine, path));
            }
        }
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.into_iter().take(m).map(|(_, p)| p.clone()).collect()
    }

    /// Analyze a note's neighborhood, splitting recurring terms into two
    /// growth signals: **emergent concepts** (no page yet) and **latent
    /// links** (a page already exists, but the notes mentioning it haven't
    /// linked to it). `existing_pages` maps a lowercased page stem to the
    /// page's path; a term that hits the map becomes a latent candidate.
    pub fn analyze_neighborhood(
        &self,
        neighborhood_paths: &[PathBuf],
        existing_pages: &HashMap<String, String>,
        config: &MycelialConfig,
    ) -> NeighborhoodAnalysis {
        let empty = || NeighborhoodAnalysis {
            emergent: Vec::new(),
            latent: Vec::new(),
        };
        if self.total_docs < config.min_corpus_size {
            return empty();
        }
        let neighborhood_size = neighborhood_paths.len();
        if neighborhood_size == 0 {
            return empty();
        }

        let max_doc_freq = (self.total_docs as f64 * config.max_doc_freq_ratio) as usize;
        let neighborhood_set: HashSet<&PathBuf> = neighborhood_paths.iter().collect();

        let mut emergent: Vec<EmergentConcept> = Vec::new();
        let mut latent: Vec<LatentCandidate> = Vec::new();

        // Score unigrams.
        if config.include_unigrams {
            for (term, &df) in &self.doc_freq {
                if df < config.min_doc_freq || df > max_doc_freq {
                    continue;
                }
                if self.stopwords.contains(term) {
                    continue;
                }
                let neighborhood_count =
                    self.count_neighborhood_presence(term, &neighborhood_set, false);
                if neighborhood_count == 0 {
                    continue;
                }
                let proximity = neighborhood_count as f64 / neighborhood_size as f64;
                let avg_tfidf = self.avg_tfidf_in_neighborhood(term, &neighborhood_set);
                let score = config.tfidf_weight * avg_tfidf + config.proximity_weight * proximity;
                if score <= 0.0 {
                    continue;
                }
                let source_notes = self.source_notes_for_term(term, &neighborhood_set, false);
                match existing_pages.get(term) {
                    Some(target) => latent.push(LatentCandidate {
                        term: term.clone(),
                        target_path: target.clone(),
                        score,
                        source_notes,
                        doc_count: neighborhood_count,
                        is_bigram: false,
                    }),
                    // An emergent concept must recur across the neighborhood —
                    // a term in a single note is just a word.
                    None if neighborhood_count >= config.min_neighborhood_presence => {
                        emergent.push(EmergentConcept {
                            term: term.clone(),
                            score,
                            source_notes,
                            doc_count: neighborhood_count,
                            is_bigram: false,
                        })
                    }
                    None => {}
                }
            }
        }

        // Score bigrams.
        if config.include_bigrams {
            for (bigram_key, &count) in &self.bigram_count {
                if count < config.bigram_min_freq {
                    continue;
                }
                let df = self.bigram_doc_freq.get(bigram_key).copied().unwrap_or(0);
                if df < config.min_doc_freq || df > max_doc_freq {
                    continue;
                }
                let display_term = bigram_key.replace(BIGRAM_SEP, " ");
                let neighborhood_count =
                    self.count_neighborhood_presence(bigram_key, &neighborhood_set, true);
                if neighborhood_count == 0 {
                    continue;
                }
                let proximity = neighborhood_count as f64 / neighborhood_size as f64;
                let pmi = self.pmi(bigram_key);
                // Bigrams are the multi-word "unnamed concepts" the view is
                // really after, so their composite score is boosted.
                let score = config.bigram_boost
                    * (config.pmi_weight * pmi.max(0.0)
                        + config.proximity_weight * proximity);
                if score <= 0.0 {
                    continue;
                }
                let source_notes =
                    self.source_notes_for_term(bigram_key, &neighborhood_set, true);
                match existing_pages.get(&display_term) {
                    Some(target) => latent.push(LatentCandidate {
                        term: display_term,
                        target_path: target.clone(),
                        score,
                        source_notes,
                        doc_count: neighborhood_count,
                        is_bigram: true,
                    }),
                    None if neighborhood_count >= config.min_neighborhood_presence => {
                        emergent.push(EmergentConcept {
                            term: display_term,
                            score,
                            source_notes,
                            doc_count: neighborhood_count,
                            is_bigram: true,
                        })
                    }
                    None => {}
                }
            }
        }

        // Sort each bucket by score descending, truncate, normalize to [0, 1].
        // Latent keeps extra headroom: the command layer drops candidates
        // whose mentions all turn out to already be linked.
        emergent.sort_by(|a, b| {
            b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
        });
        emergent.truncate(config.top_k);
        normalize_scores(emergent.iter_mut().map(|c| &mut c.score));

        latent.sort_by(|a, b| {
            b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
        });
        latent.truncate(config.top_k * 3);
        normalize_scores(latent.iter_mut().map(|c| &mut c.score));

        NeighborhoodAnalysis { emergent, latent }
    }

    fn count_neighborhood_presence(
        &self,
        term: &str,
        neighborhood: &HashSet<&PathBuf>,
        is_bigram: bool,
    ) -> usize {
        let term_owned = term.to_owned();
        if is_bigram {
            neighborhood.iter()
                .filter(|path| {
                    self.doc_bigram_sets.get(path.as_path()).map_or(false, |s| s.contains(&term_owned))
                })
                .count()
        } else {
            neighborhood.iter()
                .filter(|path| {
                    self.doc_unigrams.get(path.as_path()).map_or(false, |s| s.contains(&term_owned))
                })
                .count()
        }
    }

    fn source_notes_for_term(
        &self,
        term: &str,
        neighborhood: &HashSet<&PathBuf>,
        is_bigram: bool,
    ) -> Vec<String> {
        let term_owned = term.to_owned();
        if is_bigram {
            neighborhood.iter()
                .filter(|path| {
                    self.doc_bigram_sets.get(path.as_path()).map_or(false, |s| s.contains(&term_owned))
                })
                .map(|path| path.display().to_string())
                .collect()
        } else {
            neighborhood.iter()
                .filter(|path| {
                    self.doc_unigrams.get(path.as_path()).map_or(false, |s| s.contains(&term_owned))
                })
                .map(|path| path.display().to_string())
                .collect()
        }
    }

    fn avg_tfidf_in_neighborhood(
        &self,
        term: &str,
        neighborhood: &HashSet<&PathBuf>,
    ) -> f64 {
        let term_owned = term.to_owned();
        let mut sum = 0.0;
        let mut count = 0usize;

        for path in neighborhood {
            let Some(unigrams) = self.doc_unigrams.get(path.as_path()) else { continue };
            if !unigrams.contains(&term_owned) {
                continue;
            }
            let doc_wc = self.doc_word_count.get(path.as_path()).copied().unwrap_or(1).max(1);
            let tfidf = self.tfidf(term, 1, doc_wc);
            sum += tfidf;
            count += 1;
        }

        if count == 0 {
            0.0
        } else {
            sum / count as f64
        }
    }
}

/// Normalize a set of scores in place so the largest becomes 1.0. The
/// candidates must be pre-sorted descending (the first score is the max).
fn normalize_scores<'a>(scores: impl Iterator<Item = &'a mut f64>) {
    let mut scores: Vec<&mut f64> = scores.collect();
    let max = scores.first().map(|s| **s).unwrap_or(0.0);
    if max > 0.0 {
        for s in &mut scores {
            **s /= max;
        }
    }
}

/// Extract bigram keys from a token stream.
/// Adjacent tokens on the same line, both passing the stopword filter.
pub fn extract_bigrams_from_tokens(
    tokens: &[TextToken],
    stopwords: &HashSet<String>,
) -> Vec<String> {
    let mut bigrams = Vec::new();
    let mut prev_word: Option<String> = None;
    let mut prev_line: usize = usize::MAX;

    for token in tokens {
        let word = token.word.to_lowercase();
        if word.len() < 2 || stopwords.contains(&word) {
            prev_word = None;
            continue;
        }

        if let Some(ref pw) = prev_word {
            if prev_line == token.line {
                let mut key = String::with_capacity(pw.len() + 1 + word.len());
                key.push_str(pw);
                key.push(BIGRAM_SEP);
                key.push_str(&word);
                bigrams.push(key);
            }
        }

        prev_line = token.line;
        prev_word = Some(word);
    }

    bigrams
}

/// Persisted form for cache serialization.
#[derive(Debug, Serialize, Deserialize)]
pub struct PersistedCorpusStats {
    pub stats: CorpusStats,
    pub saved_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_token(word: &str, line: usize) -> TextToken {
        TextToken {
            word: word.to_owned(),
            line,
            char_start: 0,
            char_end: word.len(),
        }
    }

    #[test]
    fn test_tfidf_basic() {
        let mut stats = CorpusStats::new(None);
        let tokens1 = vec![
            make_token("philosophy", 0),
            make_token("epistemology", 0),
            make_token("philosophy", 1),
        ];
        let tokens2 = vec![
            make_token("biology", 0),
            make_token("evolution", 0),
        ];
        let tokens3 = vec![
            make_token("philosophy", 0),
            make_token("metaphysics", 0),
        ];

        stats.add_doc(Path::new("note1.typ"), &tokens1);
        stats.add_doc(Path::new("note2.typ"), &tokens2);
        stats.add_doc(Path::new("note3.typ"), &tokens3);

        // "philosophy" appears in 2/3 docs, "biology" in 1/3
        assert!(stats.doc_freq["philosophy"] == 2);
        assert!(stats.doc_freq["biology"] == 1);

        // TF-IDF for "biology" should be higher than "philosophy" (rarer)
        let tfidf_bio = stats.tfidf("biology", 1, 2);
        let tfidf_phil = stats.tfidf("philosophy", 2, 3);
        assert!(tfidf_bio > tfidf_phil);
    }

    #[test]
    fn test_pmi_basic() {
        let mut stats = CorpusStats::new(None);
        // Create a corpus where "epistemic humility" co-occurs frequently
        for i in 0..10 {
            let tokens = vec![
                make_token("epistemic", 0),
                make_token("humility", 0),
                make_token("random", 1),
                make_token("words", 1),
            ];
            stats.add_doc(Path::new(&format!("note{i}.typ")), &tokens);
        }
        // Add some docs with only one of the words
        let tokens_e = vec![make_token("epistemic", 0), make_token("knowledge", 0)];
        stats.add_doc(Path::new("note_e.typ"), &tokens_e);

        let key = format!("epistemic{BIGRAM_SEP}humility");
        let pmi = stats.pmi(&key);
        // PMI should be positive (co-occur more than chance)
        assert!(pmi > 0.0, "PMI was {pmi}, expected > 0");
    }

    #[test]
    fn test_incremental_update() {
        let mut stats = CorpusStats::new(None);
        let path = Path::new("test.typ");
        let tokens_v1 = vec![make_token("alpha", 0), make_token("beta", 0)];
        let tokens_v2 = vec![make_token("gamma", 0), make_token("delta", 0)];

        stats.add_doc(path, &tokens_v1);
        assert_eq!(stats.doc_freq.get("alpha"), Some(&1));
        assert_eq!(stats.total_docs, 1);

        stats.update_doc(path, &tokens_v2);
        assert_eq!(stats.doc_freq.get("alpha"), None);
        assert_eq!(stats.doc_freq.get("gamma"), Some(&1));
        assert_eq!(stats.total_docs, 1);
    }

    #[test]
    fn test_delete_doc() {
        let mut stats = CorpusStats::new(None);
        let path = Path::new("test.typ");
        let tokens = vec![make_token("concept", 0), make_token("theory", 0)];

        stats.add_doc(path, &tokens);
        assert_eq!(stats.total_docs, 1);

        stats.delete_doc(path);
        assert_eq!(stats.total_docs, 0);
        assert_eq!(stats.doc_freq.get("concept"), None);
    }
}
