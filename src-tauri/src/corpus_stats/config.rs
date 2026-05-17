//! Configuration for the mycelial corpus analysis engine.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MycelialConfig {
    /// Minimum number of documents a term must appear in to be considered.
    pub min_doc_freq: usize,
    /// Maximum ratio of documents containing a term (skip if too common).
    pub max_doc_freq_ratio: f64,
    /// Minimum corpus-wide frequency for bigrams.
    pub bigram_min_freq: usize,
    /// Whether to include single-word emergent concepts.
    pub include_unigrams: bool,
    /// Whether to include two-word (bigram) emergent concepts.
    pub include_bigrams: bool,
    /// Whether to include three-word (trigram) emergent concepts.
    pub include_trigrams: bool,
    /// Minimum number of documents a trigram must appear in to be considered.
    pub trigram_min_freq: usize,
    /// Score multiplier for trigrams — three-word phrases that recur are the
    /// strongest "unnamed concept" signal, so they rank above bigrams.
    pub trigram_boost: f64,
    /// Number of top suggestions to return.
    pub top_k: usize,
    /// Minimum number of notes in the notebox before suggestions activate.
    pub min_corpus_size: usize,
    /// Weight for PMI score in composite ranking (bigrams).
    pub pmi_weight: f64,
    /// Weight for TF-IDF score in composite ranking (unigrams).
    pub tfidf_weight: f64,
    /// Weight for graph proximity (neighborhood presence ratio).
    pub proximity_weight: f64,
    /// How many semantically-similar notes to widen the neighborhood with,
    /// beyond the link graph. Lets a sparsely-linked note still surface
    /// concepts that emerge from its *context*, not just its own vocabulary.
    pub semantic_neighbors: usize,
    /// Minimum number of neighborhood notes an emergent concept must appear
    /// in. A term in a single note is just a word, not an emergent concept.
    pub min_neighborhood_presence: usize,
    /// Score multiplier for bigrams — multi-word phrases are the "unnamed
    /// concepts" the view is really after, so they rank above bare words.
    pub bigram_boost: f64,
}

impl Default for MycelialConfig {
    fn default() -> Self {
        Self {
            min_doc_freq: 3,
            max_doc_freq_ratio: 0.6,
            bigram_min_freq: 3,
            include_unigrams: true,
            include_bigrams: true,
            include_trigrams: true,
            trigram_min_freq: 2,
            trigram_boost: 2.0,
            top_k: 12,
            min_corpus_size: 20,
            pmi_weight: 0.4,
            tfidf_weight: 0.3,
            proximity_weight: 0.3,
            semantic_neighbors: 12,
            min_neighborhood_presence: 2,
            bigram_boost: 1.6,
        }
    }
}
