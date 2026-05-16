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
    /// Whether to include multi-word (bigram) emergent concepts.
    pub include_bigrams: bool,
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
}

impl Default for MycelialConfig {
    fn default() -> Self {
        Self {
            min_doc_freq: 3,
            max_doc_freq_ratio: 0.6,
            bigram_min_freq: 3,
            include_unigrams: true,
            include_bigrams: true,
            top_k: 12,
            min_corpus_size: 20,
            pmi_weight: 0.4,
            tfidf_weight: 0.3,
            proximity_weight: 0.3,
        }
    }
}
