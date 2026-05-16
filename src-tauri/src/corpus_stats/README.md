# Corpus Statistics Engine

The corpus statistics module powers the **Mycelial View** — InkyCap's knowledge-graph visualization that surfaces emergent concepts from a user's notebox.

## Theory

The engine applies two well-established computational linguistics techniques to identify terms and phrases that a user has implicitly developed across their notes but hasn't yet formalized into dedicated pages:

### TF-IDF (Term Frequency–Inverse Document Frequency)

Scores terms by *local importance* (how frequent in a specific note or neighborhood) modulated by *global rarity* (how uncommon across the whole notebox).

```
TF(t, d) = count(t in d) / total_words(d)
IDF(t) = ln(total_docs / docs_containing(t))
TF-IDF(t, d) = TF(t, d) × IDF(t)
```

High TF-IDF = a term that is distinctive to a cluster of notes, not just frequent everywhere. This surfaces domain-specific vocabulary the user uses repeatedly in a localized area of their knowledge graph.

### PMI (Pointwise Mutual Information)

Measures whether a bigram (two-word phrase) co-occurs more than independent chance would predict.

```
PMI(w1, w2) = log₂(P(w1, w2) / (P(w1) × P(w2)))
```

Where probabilities are estimated from corpus-wide counts. High PMI = a meaningful phrase ("epistemic humility", "soil chemistry") rather than accidental adjacency ("the reason", "it was").

### Composite Scoring

For a given note's neighborhood (all notes within N hops on the link graph), candidate terms are ranked by:

```
score = pmi_weight × normalized_pmi        (bigrams only)
      + tfidf_weight × avg_tfidf_in_neighborhood
      + proximity_weight × (neighborhood_docs_containing / neighborhood_size)

bigrams additionally × bigram_boost         (multi-word phrases rank higher)
```

Default weights: PMI 0.4, TF-IDF 0.3, proximity 0.3, bigram_boost 1.6. These
can be tuned via `MycelialConfig`.

### The neighborhood

The "neighborhood" a candidate is scored over is **not** just the N-hop link
graph. A sparsely-linked note has an almost-empty link graph, which collapses
emergent detection into single-note keyword extraction. So the neighborhood is
the link graph **unioned with the `semantic_neighbors` most similar notes** —
ranked by `similar_docs`, a cosine similarity over per-document TF-IDF vectors.
This lets concepts emerge from notes that are topologically distant but
thematically related.

An emergent concept must additionally appear in at least
`min_neighborhood_presence` (default 2) neighborhood notes — a term in a single
note is just a word, not a concept.

## Architecture

```
corpus_stats/
├── mod.rs           — CorpusStats struct, scoring algorithms, incremental updates
├── config.rs        — MycelialConfig with tunable parameters
├── stopwords.rs     — Layered stopword system (built-in + user files)
├── stopwords_data.rs — Embedded EN/FR const arrays (1263 + 661 words)
└── README.md        — This file
```

## Stopword System (Three Layers)

1. **Built-in** — English (1263 words) + French (661 words) + Typst structural (~22 terms). Sourced from [stopwords-iso](https://github.com/stopwords-iso/stopwords-iso) (MIT license). Merged unconditionally.

2. **User stopwords** — `<notebox>/.inkycap/mycelial-stopwords.txt`. One word/phrase per line, `#` comments. Terms the user finds uninteresting in their domain (university name, project codename, etc.).

3. **User dictionary** — `<notebox>/.inkycap/dictionary.txt`. Force-includes that override stopword membership. For unusual spellings, technical neologisms, or proper nouns the user considers valid concepts. Also serves as a future spell-check allowlist.

## Incremental Updates

The engine is designed for the `reindex_note()` hot path:

- **On note edit:** `update_doc(path, tokens)` subtracts the old document's contributions (from stored per-doc word/bigram lists) and adds the new ones. O(words_in_document).
- **On note delete:** `delete_doc(path)` removes all contributions.
- **On notebox open:** `build(docs, root)` computes statistics from all cached content in one pass.

Per-document word and bigram lists are stored in memory (~50 bytes/word × avg 200 unique words/note = ~10KB/note, ~10MB for a 1000-note notebox).

## Configuration

All parameters have sensible defaults. Users rarely need to change them:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `min_doc_freq` | 3 | Term must appear in 3+ notes to be considered |
| `max_doc_freq_ratio` | 0.6 | Skip terms appearing in >60% of notes (too generic) |
| `bigram_min_freq` | 3 | Bigram needs 3+ corpus-wide occurrences |
| `include_unigrams` | true | Show single-word suggestions |
| `include_bigrams` | true | Show multi-word phrase suggestions |
| `top_k` | 12 | Maximum suggestions returned |
| `min_corpus_size` | 20 | No suggestions below this notebox size |
| `pmi_weight` | 0.4 | PMI contribution to composite score |
| `tfidf_weight` | 0.3 | TF-IDF contribution to composite score |
| `proximity_weight` | 0.3 | Neighborhood presence contribution |

## Integration Points

- **AppState** — `corpus_stats: RwLock<CorpusStats>` field, built during `build_indexes()`, updated in `reindex_note()` and `remove_from_indices()`.
- **Text extraction** — Piggybacks on `search::text_projection::project()` which tokenizes Typst source via AST walking.
- **Link graph** — Neighborhood defined by `LinkIndex` BFS (same as the node graph in the Mycelial View).
- **Page-stem filtering** — Existing note filenames (from `PropertyIndex`) are excluded from suggestions.

## Evolving This Module

**Adding a language:** Add a new `const` array to `stopwords_data.rs` and merge it in `stopwords.rs::build_stopwords()`.

**Improving scoring:** The composite formula lives in `CorpusStats::top_emergent_concepts()`. You can add new signal dimensions (recency weighting, tag-based clustering, co-citation analysis) by extending the score computation there.

**Persistence:** Currently rebuilt from content on each notebox open (sub-second for <1000 notes). If noteboxes grow much larger, add bincode persistence following the `PersistedSearchIndex` pattern — the struct is already `Serialize`/`Deserialize`.
