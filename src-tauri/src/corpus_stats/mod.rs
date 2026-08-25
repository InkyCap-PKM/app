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
//! - **Composite scoring**: for a given note's neighborhood (link graph ∪
//!   semantic neighbors), candidate terms are ranked by a weighted blend of
//!   TF-IDF (distinctiveness, max-normalized per run), NPMI (phrase cohesion,
//!   n-grams), and *anchor-weighted* proximity — each neighborhood note's
//!   vote counts in proportion to its similarity to the anchor, so different
//!   anchors rank differently. The final suggestion slots are filled by MMR
//!   selection to spread suggestions across the neighborhood.

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
/// `BIGRAM_SEP` as a `&str`, for `join` call sites.
const BIGRAM_SEP_STR: &str = "\x1f";

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
    /// trigram key → number of documents containing the adjacent triple
    pub trigram_doc_freq: HashMap<String, usize>,
    /// trigram key → total corpus-wide occurrence count
    pub trigram_count: HashMap<String, usize>,
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
    /// Per-document trigram occurrence lists (for count subtraction on removal)
    doc_trigrams: HashMap<PathBuf, Vec<String>>,
    /// Per-document unique trigram sets (for fast neighborhood membership queries)
    doc_trigram_sets: HashMap<PathBuf, HashSet<String>>,
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

/// A term that *would* have surfaced as an emergent concept (it clears the same
/// document-frequency and neighborhood-recurrence bars) but was dropped because
/// it is a stopword. Surfaced so the user can see what the filter suppressed and
/// rescue a word that actually matters in their notebox.
#[derive(Debug, Clone, Serialize)]
pub struct ExcludedTerm {
    pub term: String,
    pub score: f64,
    /// Neighborhood notes the term recurs in — the "is this worth rescuing?"
    /// signal shown to the user.
    pub doc_count: usize,
    /// Which layer filtered it — `"builtin"` (the bundled EN/FR lists, rescued
    /// by force-including via `dictionary.txt`) or `"user"` (the notebox's
    /// `mycelial-stopwords.txt`, rescued by removing the line). Drives which
    /// rescue action the UI offers.
    pub source: String,
}

/// The growth signals surfaced for a note's neighborhood, plus the terms the
/// stopword filter held back (so the UI can make that filtering visible).
pub struct NeighborhoodAnalysis {
    pub emergent: Vec<EmergentConcept>,
    pub latent: Vec<LatentCandidate>,
    pub excluded: Vec<ExcludedTerm>,
}

impl CorpusStats {
    /// Create a new empty instance with stopwords loaded.
    pub fn new(notebox_root: Option<&Path>) -> Self {
        Self {
            total_docs: 0,
            doc_freq: HashMap::new(),
            bigram_doc_freq: HashMap::new(),
            bigram_count: HashMap::new(),
            trigram_doc_freq: HashMap::new(),
            trigram_count: HashMap::new(),
            unigram_count: HashMap::new(),
            total_unigrams: 0,
            total_bigrams: 0,
            doc_unigrams: HashMap::new(),
            doc_bigrams: HashMap::new(),
            doc_bigram_sets: HashMap::new(),
            doc_trigrams: HashMap::new(),
            doc_trigram_sets: HashMap::new(),
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

        // Trigrams: three adjacent non-stopword tokens on the same line.
        let trigrams_vec = extract_trigrams_from_tokens(tokens, &self.stopwords);
        let mut seen_trigrams: HashSet<String> = HashSet::new();
        for tg in &trigrams_vec {
            *self.trigram_count.entry(tg.clone()).or_insert(0) += 1;
            seen_trigrams.insert(tg.clone());
        }
        for tg in &seen_trigrams {
            *self.trigram_doc_freq.entry(tg.clone()).or_insert(0) += 1;
        }

        // Store for incremental subtraction and neighborhood queries
        self.doc_unigrams.insert(path.to_path_buf(), seen_unigrams);
        self.doc_bigrams.insert(path.to_path_buf(), bigrams_vec);
        self.doc_bigram_sets
            .insert(path.to_path_buf(), seen_bigrams);
        self.doc_trigrams.insert(path.to_path_buf(), trigrams_vec);
        self.doc_trigram_sets
            .insert(path.to_path_buf(), seen_trigrams);
    }

    /// Remove a document's contribution from corpus statistics.
    fn remove_doc(&mut self, path: &Path) {
        // Only count a removal when the document is actually present. `update_doc`
        // is remove-then-add, so using it to ADD a brand-new document must not
        // decrement `total_docs` — otherwise the spurious decrement cancels the
        // `add_doc` increment and the counter never grows. A corpus built
        // entirely through `update_doc` (e.g. a bulk markdown import reindexing
        // thousands of files into a fresh corpus) would otherwise leave
        // `total_docs` stuck near 1 while the per-doc maps fill up, tripping the
        // `total_docs < min_corpus_size` guard in `analyze_neighborhood`.
        // `doc_word_count` is the canonical presence map (`add_doc` always
        // populates it; `contains_doc` reads it).
        if self.doc_word_count.contains_key(path) && self.total_docs > 0 {
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

        // Subtract trigram counts using the full occurrence list
        if let Some(trigrams) = self.doc_trigrams.remove(path) {
            for tg in &trigrams {
                if let Some(count) = self.trigram_count.get_mut(tg) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        self.trigram_count.remove(tg);
                    }
                }
            }
        }
        // Subtract trigram doc_freq using the unique set
        if let Some(trigram_set) = self.doc_trigram_sets.remove(path) {
            for tg in &trigram_set {
                if let Some(count) = self.trigram_doc_freq.get_mut(tg) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        self.trigram_doc_freq.remove(tg);
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

    /// Paths currently indexed — one entry per document. Used to reconcile a
    /// persisted snapshot against the current notebox on load.
    pub fn indexed_paths(&self) -> Vec<PathBuf> {
        self.doc_word_count.keys().cloned().collect()
    }

    /// Whether a document is currently indexed.
    pub fn contains_doc(&self, path: &Path) -> bool {
        self.doc_word_count.contains_key(path)
    }

    /// Re-derive `total_docs` from the per-document maps. The invariant is
    /// `total_docs == doc_word_count.len()` (one entry per indexed document);
    /// call this after loading a persisted snapshot to repair any historical
    /// desync — notably snapshots written before the `remove_doc`
    /// over-decrement fix, where a corpus built via `update_doc` (bulk import)
    /// left the counter stuck near 1 while the maps were fully populated.
    pub fn resync_total_docs(&mut self) {
        self.total_docs = self.doc_word_count.len();
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

    /// Normalized PMI for a bigram: `pmi / (−log₂ P(bigram))`, clamped to
    /// `[0, 1]`.
    ///
    /// Raw PMI is unbounded (a genuine collocation easily reaches 8–12 bits)
    /// while every other composite-score component lives in `[0, 1]`, so raw
    /// PMI dominated the blend and made the ranking effectively corpus-global
    /// — the root cause of the "same suggestions from every anchor" failure.
    /// NPMI preserves the ordering among collocations but shares the others'
    /// scale, so the config weights genuinely arbitrate. Negative association
    /// (co-occurring less than chance) clamps to 0 — never a concept signal.
    pub fn npmi(&self, bigram_key: &str) -> f64 {
        if self.total_bigrams == 0 {
            return 0.0;
        }
        let count = self.bigram_count.get(bigram_key).copied().unwrap_or(0);
        if count == 0 {
            return 0.0;
        }
        let p_bigram = count as f64 / self.total_bigrams as f64;
        let denom = -p_bigram.log2();
        if denom <= 0.0 {
            // A one-bigram corpus: the pair is trivially fully cohesive.
            return 1.0;
        }
        (self.pmi(bigram_key) / denom).clamp(0.0, 1.0)
    }

    /// Inverse document frequency of a term (0 when unknown).
    fn idf(&self, term: &str) -> f64 {
        let df = self.doc_freq.get(term).copied().unwrap_or(0);
        if df == 0 || self.total_docs == 0 {
            0.0
        } else {
            (self.total_docs as f64 / df as f64).ln()
        }
    }

    /// TF-IDF weight vector and its Euclidean norm for one document.
    /// `doc_unigrams` stores unique term *sets*, so per-doc term frequency is
    /// approximated as 1/word_count — consistent with
    /// `avg_tfidf_in_neighborhood`. `None` when the doc is unindexed or empty.
    fn doc_vector(&self, path: &Path) -> Option<(HashMap<&str, f64>, f64)> {
        let terms = self.doc_unigrams.get(path)?;
        let wc = self.doc_word_count.get(path).copied().unwrap_or(1).max(1) as f64;
        let vec: HashMap<&str, f64> = terms
            .iter()
            .map(|t| (t.as_str(), self.idf(t) / wc))
            .collect();
        let norm: f64 = vec.values().map(|w| w * w).sum::<f64>().sqrt();
        if norm == 0.0 {
            None
        } else {
            Some((vec, norm))
        }
    }

    /// Cosine similarity of `path`'s TF-IDF vector against a prepared center
    /// vector. 0 when the doc is unindexed or empty.
    fn cosine_against(
        &self,
        center_vec: &HashMap<&str, f64>,
        center_norm: f64,
        path: &Path,
    ) -> f64 {
        let Some(terms) = self.doc_unigrams.get(path) else {
            return 0.0;
        };
        let wc = self.doc_word_count.get(path).copied().unwrap_or(1).max(1) as f64;
        let mut dot = 0.0;
        let mut norm_sq = 0.0;
        for t in terms {
            let w = self.idf(t) / wc;
            norm_sq += w * w;
            if let Some(cw) = center_vec.get(t.as_str()) {
                dot += w * cw;
            }
        }
        let norm = norm_sq.sqrt();
        if norm == 0.0 {
            0.0
        } else {
            dot / (center_norm * norm)
        }
    }

    /// Rank the `m` documents most semantically similar to `center` by
    /// cosine similarity over TF-IDF vectors, with scores. This widens a
    /// note's neighborhood beyond its (possibly sparse) link graph, and the
    /// scored form also feeds kindred-note detection (similar but unlinked).
    pub fn similar_docs_scored(&self, center: &Path, m: usize) -> Vec<(PathBuf, f64)> {
        if self.total_docs == 0 || m == 0 {
            return Vec::new();
        }
        let Some((center_vec, center_norm)) = self.doc_vector(center) else {
            return Vec::new();
        };
        let mut scored: Vec<(f64, &PathBuf)> = Vec::new();
        for path in self.doc_unigrams.keys() {
            if path.as_path() == center {
                continue;
            }
            let cosine = self.cosine_against(&center_vec, center_norm, path);
            if cosine > 0.0 {
                scored.push((cosine, path));
            }
        }
        // Path tiebreak keeps equal-similarity results deterministic.
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.1.cmp(b.1))
        });
        scored
            .into_iter()
            .take(m)
            .map(|(s, p)| (p.clone(), s))
            .collect()
    }

    /// [`Self::similar_docs_scored`] without the scores.
    pub fn similar_docs(&self, center: &Path, m: usize) -> Vec<PathBuf> {
        self.similar_docs_scored(center, m)
            .into_iter()
            .map(|(p, _)| p)
            .collect()
    }

    /// Cosine similarity of each of `paths` against `center` — the input for
    /// anchor-weighted proximity, where a neighborhood note's vote counts in
    /// proportion to how related it is to the note under analysis. The center
    /// itself maps to 1.0; unindexed notes map to 0.
    pub fn similarity_map(&self, center: &Path, paths: &[PathBuf]) -> HashMap<PathBuf, f64> {
        let center_data = self.doc_vector(center);
        paths
            .iter()
            .map(|p| {
                let s = if p.as_path() == center {
                    1.0
                } else if let Some((ref vec, norm)) = center_data {
                    self.cosine_against(vec, norm, p)
                } else {
                    0.0
                };
                (p.clone(), s)
            })
            .collect()
    }

    /// Indexed prose word count of a document (stopword-filtered tokens), if
    /// the document is indexed. Feeds under-developed-hub detection.
    pub fn word_count_of(&self, path: &Path) -> Option<usize> {
        self.doc_word_count.get(path).copied()
    }

    /// The most distinctive vocabulary two documents share: the intersection
    /// of their unique-term sets ranked by idf (rarest first). This is the
    /// "why are these two notes kindred" explanation the Mycelial View shows,
    /// and doubles as writing-prompt material.
    pub fn shared_distinctive_terms(&self, a: &Path, b: &Path, k: usize) -> Vec<String> {
        let (Some(sa), Some(sb)) = (self.doc_unigrams.get(a), self.doc_unigrams.get(b)) else {
            return Vec::new();
        };
        let (small, large) = if sa.len() <= sb.len() {
            (sa, sb)
        } else {
            (sb, sa)
        };
        let mut shared: Vec<&String> = small
            .iter()
            .filter(|t| large.contains(*t) && !self.stopwords.contains(t.as_str()))
            .collect();
        shared.sort_by(|x, y| {
            self.idf(y)
                .partial_cmp(&self.idf(x))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| x.cmp(y))
        });
        shared.into_iter().take(k).cloned().collect()
    }

    /// Analyze a note's neighborhood, splitting recurring terms into two
    /// growth signals: **emergent concepts** (no page yet) and **latent
    /// links** (a page already exists, but the notes mentioning it haven't
    /// linked to it). `existing_pages` maps a lowercased page name (stem,
    /// title, or alias) to the page's path.
    ///
    /// `note_weights` maps every neighborhood note to its anchor weight —
    /// `max(cosine-to-center, depth decay)`, built by the command layer — so a
    /// term's proximity counts notes in proportion to how related they are to
    /// the anchor. This is what makes two different anchors produce genuinely
    /// different rankings instead of filtering one corpus-global leaderboard.
    ///
    /// Scoring runs in two passes: **gather** raw components (TF-IDF, NPMI,
    /// weighted proximity) under the corpus-size threshold schedule, then
    /// **blend** after normalizing the TF-IDF component by the run's maximum
    /// (TF-IDF has no natural [0, 1] scale; NPMI and proximity already do).
    /// Emergent slots are then filled by MMR selection so one dense pair of
    /// notes can't supply every suggestion. Latent candidates return with raw
    /// blended scores — the command layer merges dangling-wikilink candidates
    /// on the same scale, MMR-selects, and normalizes at the end.
    pub fn analyze_neighborhood(
        &self,
        note_weights: &HashMap<PathBuf, f64>,
        existing_pages: &HashMap<String, String>,
        config: &MycelialConfig,
    ) -> NeighborhoodAnalysis {
        let empty = || NeighborhoodAnalysis {
            emergent: Vec::new(),
            latent: Vec::new(),
            excluded: Vec::new(),
        };
        // Latent links are name matching and work from the second note on;
        // only the *statistical* signals are gated, via the threshold
        // schedule below.
        if note_weights.is_empty() || self.total_docs < 2 {
            return empty();
        }
        let thresholds = effective_thresholds(config, self.total_docs);
        let max_doc_freq = (self.total_docs as f64 * config.max_doc_freq_ratio) as usize;

        let mut candidates: Vec<RawCandidate> = Vec::new();
        let mut excluded: Vec<ExcludedTerm> = Vec::new();

        // Latent links, name-driven: look each existing page name up in the
        // per-doc n-gram sets instead of filtering the corpus frequency
        // tables. This frees latent links from every statistical gate (a
        // single mention of an existing page is already actionable) and finds
        // names that never cleared `min_doc_freq` as corpus n-grams. Names
        // longer than 3 words, or containing a stopword or one-letter word,
        // are unreachable through the sets and are skipped — same reach the
        // frequency-table path had, minus its df gates.
        for (name, target_path) in existing_pages {
            let words: Vec<&str> = name.split_whitespace().collect();
            if words.is_empty() || words.len() > 3 {
                continue;
            }
            if words
                .iter()
                .any(|w| w.len() < 2 || self.stopwords.contains(*w))
            {
                continue;
            }
            let key = words.join(BIGRAM_SEP_STR);
            let (sets, df) = match words.len() {
                1 => (
                    &self.doc_unigrams,
                    self.doc_freq.get(&key).copied().unwrap_or(0),
                ),
                2 => (
                    &self.doc_bigram_sets,
                    self.bigram_doc_freq.get(&key).copied().unwrap_or(0),
                ),
                _ => (
                    &self.doc_trigram_sets,
                    self.trigram_doc_freq.get(&key).copied().unwrap_or(0),
                ),
            };
            if df == 0 {
                continue;
            }
            // Ubiquitous-name guard — only once the ratio has enough corpus
            // to mean something.
            if self.total_docs >= GROWING_CORPUS_DOCS / 2 && df > max_doc_freq {
                continue;
            }
            let (wprox, count, source_notes) = self.weighted_presence(&key, note_weights, sets);
            if count == 0 {
                continue;
            }
            let (distinct, distinct_is_tfidf) = match words.len() {
                1 => (self.avg_tfidf_weighted(&key, note_weights), true),
                2 => (self.npmi(&key), false),
                _ => (self.trigram_cohesion(&key), false),
            };
            candidates.push(RawCandidate {
                term: words.join(" "),
                distinct,
                distinct_is_tfidf,
                wprox,
                // No length boost: the boost favours unnamed phrases, an
                // emergent-bucket concern; latent ranks within its own bucket.
                boost: 1.0,
                source_notes,
                doc_count: count,
                is_bigram: words.len() > 1,
                latent_target: Some(target_path.clone()),
            });
        }

        // Emergent unigrams.
        if thresholds.emergent_enabled && config.include_unigrams {
            for (term, &df) in &self.doc_freq {
                if df < thresholds.min_doc_freq || df > max_doc_freq {
                    continue;
                }
                if self.stopwords.contains(term) {
                    // The term cleared the df window but is a stopword. If it
                    // also recurs across the neighborhood like a real emergent
                    // concept would (and isn't already a page), record it as a
                    // *suppressed* candidate so the UI can surface it for rescue.
                    let (wprox, count, _) =
                        self.weighted_presence(term, note_weights, &self.doc_unigrams);
                    if count >= config.min_neighborhood_presence
                        && !existing_pages.contains_key(term)
                    {
                        let avg_tfidf = self.avg_tfidf_weighted(term, note_weights);
                        let score =
                            config.tfidf_weight * avg_tfidf + config.proximity_weight * wprox;
                        if score > 0.0 {
                            excluded.push(ExcludedTerm {
                                term: term.clone(),
                                score,
                                doc_count: count,
                                source: if stopwords::is_builtin_stopword(term) {
                                    "builtin".to_string()
                                } else {
                                    "user".to_string()
                                },
                            });
                        }
                    }
                    continue;
                }
                // Existing-page names are the latent pass's business.
                if existing_pages.contains_key(term) {
                    continue;
                }
                let (wprox, count, source_notes) =
                    self.weighted_presence(term, note_weights, &self.doc_unigrams);
                // An emergent concept must recur across the neighborhood —
                // a term in a single note is just a word.
                if count < config.min_neighborhood_presence {
                    continue;
                }
                candidates.push(RawCandidate {
                    term: term.clone(),
                    distinct: self.avg_tfidf_weighted(term, note_weights),
                    distinct_is_tfidf: true,
                    wprox,
                    boost: 1.0,
                    source_notes,
                    doc_count: count,
                    is_bigram: false,
                    latent_target: None,
                });
            }
        }

        // Emergent bigrams.
        if thresholds.emergent_enabled && config.include_bigrams {
            for (bigram_key, &count) in &self.bigram_count {
                if count < thresholds.bigram_min_freq {
                    continue;
                }
                let df = self.bigram_doc_freq.get(bigram_key).copied().unwrap_or(0);
                if df < thresholds.min_doc_freq || df > max_doc_freq {
                    continue;
                }
                let display_term = bigram_key.replace(BIGRAM_SEP, " ");
                if existing_pages.contains_key(&display_term) {
                    continue;
                }
                let (wprox, n_count, source_notes) =
                    self.weighted_presence(bigram_key, note_weights, &self.doc_bigram_sets);
                if n_count < config.min_neighborhood_presence {
                    continue;
                }
                candidates.push(RawCandidate {
                    term: display_term,
                    distinct: self.npmi(bigram_key),
                    distinct_is_tfidf: false,
                    wprox,
                    // Bigrams are the multi-word "unnamed concepts" the view
                    // is really after, so their composite score is boosted.
                    boost: config.bigram_boost,
                    source_notes,
                    doc_count: n_count,
                    is_bigram: true,
                    latent_target: None,
                });
            }
        }

        // Emergent trigrams. Recurring trigrams are the strongest
        // unnamed-concept signal, hence the largest boost.
        if thresholds.emergent_enabled && config.include_trigrams {
            for trigram_key in self.trigram_count.keys() {
                let df = self.trigram_doc_freq.get(trigram_key).copied().unwrap_or(0);
                if df < thresholds.trigram_min_freq || df > max_doc_freq {
                    continue;
                }
                let display_term = trigram_key.replace(BIGRAM_SEP, " ");
                if existing_pages.contains_key(&display_term) {
                    continue;
                }
                let (wprox, n_count, source_notes) =
                    self.weighted_presence(trigram_key, note_weights, &self.doc_trigram_sets);
                if n_count < config.min_neighborhood_presence {
                    continue;
                }
                candidates.push(RawCandidate {
                    term: display_term,
                    distinct: self.trigram_cohesion(trigram_key),
                    distinct_is_tfidf: false,
                    wprox,
                    boost: config.trigram_boost,
                    source_notes,
                    doc_count: n_count,
                    is_bigram: true,
                    latent_target: None,
                });
            }
        }

        // Blend pass: normalize the TF-IDF component by the run's maximum
        // (its raw scale is idf/word-count units, meaningless next to the
        // [0, 1] NPMI and proximity components), then apply the config
        // weights and the n-gram boosts.
        let max_tfidf = candidates
            .iter()
            .filter(|c| c.distinct_is_tfidf)
            .map(|c| c.distinct)
            .fold(0.0_f64, f64::max);
        let mut emergent: Vec<EmergentConcept> = Vec::new();
        let mut latent: Vec<LatentCandidate> = Vec::new();
        for c in candidates {
            let (distinct_n, distinct_weight) = if c.distinct_is_tfidf {
                let n = if max_tfidf > 0.0 {
                    c.distinct / max_tfidf
                } else {
                    0.0
                };
                (n, config.tfidf_weight)
            } else {
                (c.distinct, config.pmi_weight)
            };
            let score =
                c.boost * (distinct_weight * distinct_n + config.proximity_weight * c.wprox);
            if score <= 0.0 {
                continue;
            }
            match c.latent_target {
                Some(target) => latent.push(LatentCandidate {
                    term: c.term,
                    target_path: target,
                    score,
                    source_notes: c.source_notes,
                    doc_count: c.doc_count,
                    is_bigram: c.is_bigram,
                }),
                None => emergent.push(EmergentConcept {
                    term: c.term,
                    score,
                    source_notes: c.source_notes,
                    doc_count: c.doc_count,
                    is_bigram: c.is_bigram,
                }),
            }
        }

        // Fuse consecutive overlapping shingles ("a b c" + "b c d" → "a b c
        // d") into one concept before ranking, so the user sees the phrase
        // rather than three near-identical windows of it.
        stitch_overlapping_shingles(&mut emergent);

        // Sort by score, then term, so equal-scoring candidates land in a
        // stable order (HashMap iteration order is otherwise non-deterministic),
        // then fill the emergent slots by MMR so the suggestions spread across
        // the neighborhood instead of one dense cluster supplying everything.
        emergent.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.term.cmp(&b.term))
        });
        let mut emergent = mmr_select(
            emergent,
            config.top_k,
            config.diversity_lambda,
            |c: &EmergentConcept| c.score,
            |c: &EmergentConcept| c.source_notes.as_slice(),
        );
        normalize_scores(emergent.iter_mut().map(|c| &mut c.score));

        // Latent keeps extra headroom and RAW scores: the command layer drops
        // candidates whose mentions all turn out to already be linked, merges
        // in dangling-wikilink candidates on the same scale, MMR-selects, and
        // normalizes at the end.
        latent.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.term.cmp(&b.term))
        });
        latent.truncate(config.top_k * 3);

        excluded.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.term.cmp(&b.term))
        });
        excluded.truncate(config.top_k);

        NeighborhoodAnalysis {
            emergent,
            latent,
            excluded,
        }
    }

    /// One pass over the neighborhood for a term: the anchor-weighted
    /// presence (Σ weight of containing notes / Σ all weights, in [0, 1]),
    /// the raw containing-note count, and the sorted containing-note list.
    /// `sets` is one of `doc_unigrams` / `doc_bigram_sets` / `doc_trigram_sets`.
    fn weighted_presence(
        &self,
        term: &str,
        note_weights: &HashMap<PathBuf, f64>,
        sets: &HashMap<PathBuf, HashSet<String>>,
    ) -> (f64, usize, Vec<String>) {
        let mut weight_sum = 0.0;
        let mut total_weight = 0.0;
        let mut count = 0usize;
        let mut notes: Vec<String> = Vec::new();
        for (path, w) in note_weights {
            total_weight += w;
            if sets.get(path.as_path()).is_some_and(|s| s.contains(term)) {
                weight_sum += w;
                count += 1;
                notes.push(crate::storage::to_frontend_string(path));
            }
        }
        // `note_weights` is a HashMap — iteration order varies per call.
        // Sort so the same notebox always yields the same result, and the
        // Mycelial View layout stays stable across recomputes.
        notes.sort();
        let wprox = if total_weight > 0.0 {
            weight_sum / total_weight
        } else {
            0.0
        };
        (wprox, count, notes)
    }

    /// Phrase cohesion of a trigram: the weaker of its two adjacent-pair
    /// NPMIs — "w1 w2 w3" holds together only if both pairs do. In [0, 1].
    fn trigram_cohesion(&self, trigram_key: &str) -> f64 {
        let parts: Vec<&str> = trigram_key.split(BIGRAM_SEP).collect();
        if parts.len() != 3 {
            return 0.0;
        }
        let a = self.npmi(&format!("{}{}{}", parts[0], BIGRAM_SEP, parts[1]));
        let b = self.npmi(&format!("{}{}{}", parts[1], BIGRAM_SEP, parts[2]));
        a.min(b)
    }

    /// Average TF-IDF of a term over the neighborhood notes containing it.
    fn avg_tfidf_weighted(&self, term: &str, note_weights: &HashMap<PathBuf, f64>) -> f64 {
        let mut sum = 0.0;
        let mut count = 0usize;

        for path in note_weights.keys() {
            let Some(unigrams) = self.doc_unigrams.get(path.as_path()) else {
                continue;
            };
            if !unigrams.contains(term) {
                continue;
            }
            let doc_wc = self
                .doc_word_count
                .get(path.as_path())
                .copied()
                .unwrap_or(1)
                .max(1);
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

/// Corpus-size bands for the emergent-concept threshold schedule. Below
/// `SPARSE_CORPUS_DOCS` the frequency statistics are pure noise, so emergent
/// concepts stay off entirely (latent links, which are name matching, still
/// run). Between the bands the frequency floors relax to 2 so a young notebox
/// surfaces *something*, flagged as tentative by the UI via `total_docs`.
pub const SPARSE_CORPUS_DOCS: usize = 10;
pub const GROWING_CORPUS_DOCS: usize = 50;

/// The thresholds actually applied for a given corpus size — the scaled
/// replacement for the old hard `min_corpus_size` cliff.
struct EffectiveThresholds {
    emergent_enabled: bool,
    min_doc_freq: usize,
    bigram_min_freq: usize,
    trigram_min_freq: usize,
}

fn effective_thresholds(config: &MycelialConfig, total_docs: usize) -> EffectiveThresholds {
    if total_docs < SPARSE_CORPUS_DOCS {
        EffectiveThresholds {
            emergent_enabled: false,
            min_doc_freq: usize::MAX,
            bigram_min_freq: usize::MAX,
            trigram_min_freq: usize::MAX,
        }
    } else if total_docs < GROWING_CORPUS_DOCS {
        EffectiveThresholds {
            emergent_enabled: true,
            min_doc_freq: 2,
            bigram_min_freq: 2,
            trigram_min_freq: 2,
        }
    } else {
        EffectiveThresholds {
            emergent_enabled: true,
            min_doc_freq: config.min_doc_freq,
            bigram_min_freq: config.bigram_min_freq,
            trigram_min_freq: config.trigram_min_freq,
        }
    }
}

/// A candidate signal gathered in the first pass of `analyze_neighborhood`,
/// carrying raw score components; blending happens once the run's TF-IDF
/// maximum is known.
struct RawCandidate {
    /// Display form (words joined with spaces, lowercased corpus form).
    term: String,
    /// Avg TF-IDF (unigrams) or NPMI / trigram cohesion (n-grams).
    distinct: f64,
    /// Whether `distinct` is a TF-IDF value needing max-normalization.
    distinct_is_tfidf: bool,
    /// Anchor-weighted neighborhood presence, already in [0, 1].
    wprox: f64,
    /// Length boost (1.0 / `bigram_boost` / `trigram_boost`).
    boost: f64,
    source_notes: Vec<String>,
    doc_count: usize,
    is_bigram: bool,
    /// `Some(path)` ⇒ latent candidate (page exists); `None` ⇒ emergent.
    latent_target: Option<String>,
}

/// Greedy Maximal-Marginal-Relevance selection: repeatedly take the candidate
/// with the best `score − λ · max Jaccard overlap` between its source-note
/// set and each already-selected candidate's. Keeps the top slots from all
/// being supplied by one dense pair of notes — the diversity half of the
/// anti-repetition work. Pass items pre-sorted (score desc, term asc) so ties
/// resolve deterministically; the output keeps selection order (best first).
pub(crate) fn mmr_select<T>(
    mut items: Vec<T>,
    k: usize,
    lambda: f64,
    score_of: impl Fn(&T) -> f64,
    sources_of: impl Fn(&T) -> &[String],
) -> Vec<T> {
    if lambda <= 0.0 {
        items.truncate(k);
        return items;
    }
    let mut selected: Vec<T> = Vec::new();
    while selected.len() < k && !items.is_empty() {
        let mut best_i = 0usize;
        let mut best_v = f64::NEG_INFINITY;
        for (i, item) in items.iter().enumerate() {
            let overlap = selected
                .iter()
                .map(|s| jaccard(sources_of(s), sources_of(item)))
                .fold(0.0_f64, f64::max);
            let v = score_of(item) - lambda * overlap;
            if v > best_v {
                best_v = v;
                best_i = i;
            }
        }
        selected.push(items.remove(best_i));
    }
    selected
}

/// Jaccard overlap of two string slices treated as sets.
fn jaccard(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let sa: HashSet<&String> = a.iter().collect();
    let sb: HashSet<&String> = b.iter().collect();
    let inter = sb.iter().filter(|s| sa.contains(*s)).count();
    let union = sa.len() + sb.len() - inter;
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// Fuse emergent concepts that are consecutive overlapping shingles of one
/// longer run — "a b c" + "b c d" + "c d e" → "a b c d e".
///
/// Two same-length n-grams chain when the suffix of one equals the prefix of
/// the next *and* they share a source note (so they are windows of the same
/// run, not a coincidental word match in unrelated notes). The stitched
/// concept keeps the best score of its parts and the union of their source
/// notes; `resolve_mention` in the command layer then verifies the run
/// actually occurs verbatim, dropping any over-eager stitch.
///
/// Same-length only: a bigram that is a prefix of a trigram ("machine
/// learning" vs "machine learning models") is a legitimately distinct
/// concept at a coarser grain and is deliberately left alone.
fn stitch_overlapping_shingles(emergent: &mut Vec<EmergentConcept>) {
    let n = emergent.len();
    if n < 2 {
        return;
    }

    let words: Vec<Vec<&str>> = emergent
        .iter()
        .map(|c| c.term.split(' ').filter(|w| !w.is_empty()).collect())
        .collect();

    let share_source = |a: usize, b: usize| -> bool {
        emergent[a]
            .source_notes
            .iter()
            .any(|s| emergent[b].source_notes.contains(s))
    };

    // successor[i] = the candidate that is the next shingle after i.
    let mut successor: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if words[i].len() < 2 {
            continue;
        }
        let wi = &words[i];
        let mut best: Option<usize> = None;
        for j in 0..n {
            if i == j || words[j].len() != wi.len() {
                continue;
            }
            // wi advanced by one word == wj.
            if wi[1..] == words[j][..words[j].len() - 1]
                && share_source(i, j)
                && best.is_none_or(|b| emergent[j].score > emergent[b].score)
            {
                best = Some(j);
            }
        }
        successor[i] = best;
    }
    let mut has_pred = vec![false; n];
    for &s in successor.iter().flatten() {
        has_pred[s] = true;
    }

    // Walk each chain from its head (a node nothing points to).
    let mut consumed = vec![false; n];
    let mut merged: Vec<EmergentConcept> = Vec::new();
    for head in 0..n {
        if has_pred[head] || consumed[head] || words[head].len() < 2 {
            continue;
        }
        let mut chain = vec![head];
        let mut cur = head;
        while let Some(next) = successor[cur] {
            if consumed[next] || chain.contains(&next) {
                break;
            }
            chain.push(next);
            cur = next;
        }
        if chain.len() < 2 {
            continue;
        }
        for &i in &chain {
            consumed[i] = true;
        }
        // Stitched term: head's words, then the last word of each later link.
        let mut stitched: Vec<&str> = words[chain[0]].clone();
        for &i in &chain[1..] {
            stitched.push(*words[i].last().unwrap());
        }
        let score = chain
            .iter()
            .map(|&i| emergent[i].score)
            .fold(0.0_f64, f64::max);
        let mut source_notes: Vec<String> = Vec::new();
        for &i in &chain {
            for s in &emergent[i].source_notes {
                if !source_notes.contains(s) {
                    source_notes.push(s.clone());
                }
            }
        }
        merged.push(EmergentConcept {
            term: stitched.join(" "),
            score,
            doc_count: source_notes.len(),
            source_notes,
            is_bigram: true,
        });
    }

    if merged.is_empty() {
        return;
    }
    let mut rebuilt: Vec<EmergentConcept> = emergent
        .drain(..)
        .enumerate()
        .filter(|(i, _)| !consumed[*i])
        .map(|(_, c)| c)
        .collect();
    rebuilt.extend(merged);
    *emergent = rebuilt;
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
        // Punctuation between this token and the last ends the phrase run —
        // a bigram must not span a comma, paren, sentence boundary, etc.
        if token.phrase_break_before {
            prev_word = None;
        }
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

/// Extract trigram keys from a token stream.
/// Three adjacent tokens on the same line, all passing the stopword filter.
pub fn extract_trigrams_from_tokens(
    tokens: &[TextToken],
    stopwords: &HashSet<String>,
) -> Vec<String> {
    let mut trigrams = Vec::new();
    // `w1`/`w2` are the two preceding non-stopword tokens; a stopword (or a
    // line break) clears the run.
    let mut w1: Option<String> = None;
    let mut w2: Option<String> = None;
    let mut line1: usize = usize::MAX;
    let mut line2: usize = usize::MAX;

    for token in tokens {
        // Punctuation ends the phrase run — a trigram must not span a comma,
        // paren, sentence boundary, etc. The break token still starts a
        // fresh run of its own.
        if token.phrase_break_before {
            w1 = None;
            w2 = None;
        }
        let word = token.word.to_lowercase();
        if word.len() < 2 || stopwords.contains(&word) {
            w1 = None;
            w2 = None;
            continue;
        }
        if let (Some(a), Some(b)) = (&w1, &w2) {
            if line1 == token.line && line2 == token.line {
                let mut key = String::with_capacity(a.len() + b.len() + word.len() + 2);
                key.push_str(a);
                key.push(BIGRAM_SEP);
                key.push_str(b);
                key.push(BIGRAM_SEP);
                key.push_str(&word);
                trigrams.push(key);
            }
        }
        w1 = w2.take();
        line1 = line2;
        w2 = Some(word);
        line2 = token.line;
    }

    trigrams
}

/// Persisted form for cache serialization. Mirrors `PersistedSearchIndex`:
/// the stats are loaded on notebox open and incrementally reconciled against
/// the current files (via `saved_at` vs file mtime) instead of rebuilt from
/// scratch — an O(corpus) re-tokenization the search index already avoids.
#[derive(Debug, Serialize, Deserialize)]
pub struct PersistedCorpusStats {
    pub stats: CorpusStats,
    pub saved_at: i64,
}

impl PersistedCorpusStats {
    /// Serialize a borrowed `CorpusStats` with a save timestamp. Best-effort:
    /// a serialization or write failure is logged and ignored (the snapshot is
    /// a cache; a missing one just rebuilds on next open).
    pub fn save_borrowed(stats: &CorpusStats, saved_at: i64, path: &Path) {
        #[derive(Serialize)]
        struct Ref<'a> {
            stats: &'a CorpusStats,
            saved_at: i64,
        }
        let encoded = match bincode::serialize(&Ref { stats, saved_at }) {
            Ok(data) => data,
            Err(err) => {
                log::warn!("corpus stats: serialization failed: {err}");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(err) = std::fs::write(path, encoded) {
            log::warn!("corpus stats: write failed at {}: {err}", path.display());
        }
    }

    /// Load a persisted snapshot, or `None` if absent/unreadable/stale-format.
    /// The `stopwords` set is `#[serde(skip)]`, so the caller must
    /// `reload_stopwords` after loading.
    pub fn load_from_file(path: &Path) -> Option<Self> {
        let data = std::fs::read(path).ok()?;
        bincode::deserialize(&data).ok()
    }
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
            phrase_break_before: false,
        }
    }

    /// One single-line doc from a word list.
    fn doc(words: &[&str]) -> Vec<TextToken> {
        words.iter().map(|w| make_token(w, 0)).collect()
    }

    /// A neighborhood weight map giving every path the same weight.
    fn uniform_weights(paths: &[&str]) -> HashMap<PathBuf, f64> {
        paths.iter().map(|p| (PathBuf::from(p), 1.0)).collect()
    }

    #[test]
    fn npmi_is_bounded_and_ranks_collocations() {
        let mut stats = CorpusStats::new(None);
        // "social epistemology" recurs adjacent in three docs; "apple" and
        // "banana" are individually frequent but adjacent only once.
        for i in 0..3 {
            stats.add_doc(
                Path::new(&format!("colloc{i}.typ")),
                &doc(&["social", "epistemology", "notes"]),
            );
        }
        stats.add_doc(Path::new("loose0.typ"), &doc(&["apple", "banana"]));
        for i in 0..4 {
            stats.add_doc(
                Path::new(&format!("apple{i}.typ")),
                &doc(&["apple", "orchard"]),
            );
            stats.add_doc(
                Path::new(&format!("banana{i}.typ")),
                &doc(&["banana", "bread"]),
            );
        }

        let colloc = format!("social{BIGRAM_SEP}epistemology");
        let loose = format!("apple{BIGRAM_SEP}banana");
        for key in [&colloc, &loose] {
            let v = stats.npmi(key);
            assert!((0.0..=1.0).contains(&v), "npmi({key:?}) = {v} out of range");
        }
        assert!(stats.npmi(&colloc) > stats.npmi(&loose));
        assert_eq!(stats.npmi("no\u{1f}such"), 0.0);
    }

    /// The regression test for the repetition complaint: the same corpus
    /// analyzed under different anchor weights must rank differently.
    #[test]
    fn analysis_is_anchor_sensitive() {
        let mut stats = CorpusStats::new(None);
        let mut a_paths: Vec<String> = Vec::new();
        let mut b_paths: Vec<String> = Vec::new();
        for i in 0..8 {
            let pa = format!("a{i}.typ");
            stats.add_doc(
                Path::new(&pa),
                &doc(&[&format!("fillera{i}"), "soil", "microbiome"]),
            );
            a_paths.push(pa);
            let pb = format!("b{i}.typ");
            stats.add_doc(
                Path::new(&pb),
                &doc(&[&format!("fillerb{i}"), "urban", "zoning"]),
            );
            b_paths.push(pb);
        }
        for i in 0..4 {
            stats.add_doc(
                Path::new(&format!("n{i}.typ")),
                &doc(&[&format!("neutral{i}"), "misc"]),
            );
        }

        let weights_toward = |heavy: &[String], light: &[String]| -> HashMap<PathBuf, f64> {
            let mut m = HashMap::new();
            for p in heavy {
                m.insert(PathBuf::from(p), 1.0);
            }
            for p in light {
                m.insert(PathBuf::from(p), 0.1);
            }
            m
        };
        let pages = HashMap::new();
        let config = MycelialConfig::default();

        let rank = |analysis: &NeighborhoodAnalysis, term: &str| -> usize {
            analysis
                .emergent
                .iter()
                .position(|c| c.term == term)
                .unwrap_or_else(|| {
                    panic!(
                        "{term:?} missing from {:?}",
                        analysis
                            .emergent
                            .iter()
                            .map(|c| &c.term)
                            .collect::<Vec<_>>()
                    )
                })
        };

        let toward_a =
            stats.analyze_neighborhood(&weights_toward(&a_paths, &b_paths), &pages, &config);
        let toward_b =
            stats.analyze_neighborhood(&weights_toward(&b_paths, &a_paths), &pages, &config);

        assert!(rank(&toward_a, "soil microbiome") < rank(&toward_a, "urban zoning"));
        assert!(rank(&toward_b, "urban zoning") < rank(&toward_b, "soil microbiome"));
    }

    #[test]
    fn mmr_select_spreads_source_sets() {
        let c = |term: &str, score: f64, sources: &[&str]| EmergentConcept {
            term: term.into(),
            score,
            source_notes: sources.iter().map(|s| s.to_string()).collect(),
            doc_count: sources.len(),
            is_bigram: false,
        };
        let items = vec![
            c("first", 1.0, &["a", "b"]),
            c("twin", 0.9, &["a", "b"]),
            c("other", 0.7, &["c", "d"]),
        ];
        let picked = mmr_select(
            items,
            2,
            0.5,
            |x: &EmergentConcept| x.score,
            |x: &EmergentConcept| x.source_notes.as_slice(),
        );
        let terms: Vec<&str> = picked.iter().map(|c| c.term.as_str()).collect();
        // "twin" duplicates "first"'s sources (penalty 0.5), so the diverse
        // "other" wins the second slot despite the lower raw score.
        assert_eq!(terms, vec!["first", "other"]);
    }

    /// Latent links are name matching, not statistics: they must surface in
    /// a corpus far below every emergent-concept gate.
    #[test]
    fn latent_links_surface_in_tiny_corpus() {
        let mut stats = CorpusStats::new(None);
        stats.add_doc(Path::new("Kombucha.typ"), &doc(&["kombucha", "brewing"]));
        stats.add_doc(
            Path::new("journal.typ"),
            &doc(&["started", "kombucha", "again"]),
        );
        stats.add_doc(Path::new("misc.typ"), &doc(&["unrelated", "words"]));

        let mut pages = HashMap::new();
        pages.insert("kombucha".to_string(), "Kombucha.typ".to_string());
        let weights = uniform_weights(&["Kombucha.typ", "journal.typ", "misc.typ"]);
        let analysis = stats.analyze_neighborhood(&weights, &pages, &MycelialConfig::default());

        assert!(
            analysis.emergent.is_empty(),
            "3 docs is far below the emergent gate"
        );
        assert_eq!(analysis.latent.len(), 1);
        assert_eq!(analysis.latent[0].term, "kombucha");
        assert!(analysis.latent[0]
            .source_notes
            .iter()
            .any(|s| s.ends_with("journal.typ")));
    }

    #[test]
    fn threshold_schedule_relaxes_then_uses_defaults() {
        // 15 docs: the growing band relaxes min_doc_freq to 2, so a term in
        // exactly two docs surfaces (the default floor of 3 would drop it).
        let mut stats = CorpusStats::new(None);
        let mut paths: Vec<String> = Vec::new();
        for i in 0..15 {
            let p = format!("n{i}.typ");
            let filler = format!("filler{i}");
            let words: Vec<&str> = if i < 2 {
                vec![filler.as_str(), "mycelium"]
            } else {
                vec![filler.as_str(), "other"]
            };
            stats.add_doc(Path::new(&p), &doc(&words));
            paths.push(p);
        }
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        let analysis = stats.analyze_neighborhood(
            &uniform_weights(&refs),
            &HashMap::new(),
            &MycelialConfig::default(),
        );
        assert!(
            analysis.emergent.iter().any(|c| c.term == "mycelium"),
            "df=2 term should surface in the 10–49 doc band: {:?}",
            analysis
                .emergent
                .iter()
                .map(|c| &c.term)
                .collect::<Vec<_>>()
        );

        // 9 docs: below the sparse floor, emergent stays off entirely.
        let mut small = CorpusStats::new(None);
        let mut small_paths: Vec<String> = Vec::new();
        for i in 0..9 {
            let p = format!("s{i}.typ");
            small.add_doc(Path::new(&p), &doc(&["mycelium", "threads"]));
            small_paths.push(p);
        }
        let refs: Vec<&str> = small_paths.iter().map(|s| s.as_str()).collect();
        let analysis = small.analyze_neighborhood(
            &uniform_weights(&refs),
            &HashMap::new(),
            &MycelialConfig::default(),
        );
        assert!(analysis.emergent.is_empty());
    }

    #[test]
    fn test_tfidf_basic() {
        let mut stats = CorpusStats::new(None);
        let tokens1 = vec![
            make_token("philosophy", 0),
            make_token("epistemology", 0),
            make_token("philosophy", 1),
        ];
        let tokens2 = vec![make_token("biology", 0), make_token("evolution", 0)];
        let tokens3 = vec![make_token("philosophy", 0), make_token("metaphysics", 0)];

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
    fn update_doc_on_new_docs_grows_total_docs() {
        // Regression: `update_doc` is remove-then-add. Using it to ADD brand-new
        // documents — exactly what a bulk markdown import does when it reindexes
        // every file into a fresh corpus — must still grow `total_docs`. A prior
        // over-decrement in `remove_doc` cancelled the `add_doc` increment, so a
        // whole imported notebox ended up with `total_docs == 1` while the
        // per-doc maps were fully populated, tripping the `min_corpus_size` guard
        // in `analyze_neighborhood` and disabling latent/emergent detection.
        let mut stats = CorpusStats::new(None);
        for i in 0..50 {
            let tokens = vec![make_token("alpha", 0), make_token(&format!("term{i}"), 0)];
            stats.update_doc(Path::new(&format!("note{i}.typ")), &tokens);
        }
        assert_eq!(stats.total_docs, 50);
        assert_eq!(stats.total_docs, stats.indexed_paths().len());
    }

    #[test]
    fn resync_total_docs_repairs_a_desynced_counter() {
        // Repairs historical snapshots written with the over-decrement bug.
        let mut stats = CorpusStats::new(None);
        for i in 0..10 {
            stats.add_doc(Path::new(&format!("note{i}.typ")), &[make_token("x", 0)]);
        }
        stats.total_docs = 1; // simulate a desynced persisted counter
        stats.resync_total_docs();
        assert_eq!(stats.total_docs, 10);
    }

    fn concept(term: &str, score: f64, sources: &[&str]) -> EmergentConcept {
        EmergentConcept {
            term: term.to_owned(),
            score,
            source_notes: sources.iter().map(|s| s.to_string()).collect(),
            doc_count: sources.len(),
            is_bigram: true,
        }
    }

    #[test]
    fn stitch_merges_consecutive_shingles() {
        let mut emergent = vec![
            concept("a b c", 0.5, &["n1.typ"]),
            concept("b c d", 0.8, &["n1.typ"]),
            concept("c d e", 0.6, &["n1.typ"]),
            concept("unrelated phrase", 0.4, &["n2.typ"]),
        ];
        stitch_overlapping_shingles(&mut emergent);
        // The three windows fuse into one run; the unrelated bigram stays.
        assert_eq!(emergent.len(), 2, "got: {:?}", emergent);
        let run = emergent
            .iter()
            .find(|c| c.term == "a b c d e")
            .expect("stitched run");
        assert!((run.score - 0.8).abs() < 1e-9, "keeps the best score");
        assert!(emergent.iter().any(|c| c.term == "unrelated phrase"));
    }

    #[test]
    fn stitch_requires_a_shared_source_note() {
        // Same word overlap, but the windows come from different notes —
        // a coincidental match, not one run. Leave them apart.
        let mut emergent = vec![
            concept("a b c", 0.5, &["n1.typ"]),
            concept("b c d", 0.8, &["n2.typ"]),
        ];
        stitch_overlapping_shingles(&mut emergent);
        assert_eq!(emergent.len(), 2);
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
