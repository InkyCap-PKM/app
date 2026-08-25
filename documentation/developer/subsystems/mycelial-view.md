# The Mycelial View

> **Audience:** developers and researchers extending or studying InkyCap's
> emergent-concept visualization.
> **Status:** living reference. Update it when the corpus engine, the command,
> or the layout changes.

The Mycelial View is InkyCap's answer to "where does my knowledge want to grow
next?" It is **not** a backlink graph — its job is finding *gaps*: areas the
user could expand or develop. It surfaces five things a plain link graph
cannot:

- **Latent links**: existing notes you *mention by name* across your writing
  but never actually wikilinked. Missed connections. (Dangling wikilinks —
  links to pages never created — are deliberately **not** part of this
  signal: latency means an *unlinked mention of a page that exists*, and the
  editor already surfaces dangling links inline. Recorded 2026-08-25.)
- **Emergent concepts**: recurring terms and phrases that appear across several
  related notes but have **no page of their own**: ideas you have developed
  implicitly without yet naming them.
- **Kindred notes**: notes semantically close to the anchor with *no link path*
  to it — two circles of thought that never touch.
- **Under-developed hubs**: notes referenced often but barely written (high
  backlink count, low word count) — surfaced in the Growth panel plus a badge.
- **Open questions**: question sentences left across the neighborhood's prose
  — surfaced in the Growth panel.

The metaphor: in a forest, mycelial threads route nutrients along paths that
form *organically* in response to what is actually in the soil, not along a
fixed map. The view shows the connections that formed in your notebox without
you deliberately building them.

This document describes what the code actually does today. The techniques are
deliberately classical (TF-IDF from the 1970s, PMI from information theory).
The system counts statistical patterns; *you* decide which ones mean something.

---

## 1. Pipeline overview

```
 note source (.typ)
      │  text_projection::project()  - Typst AST → prose tokens
      ▼
 CorpusStats  (corpus_stats/)        - TF-IDF, PMI, cosine; incremental
      │
      ▼
 get_mycelial_data(path, depth)      - commands/mycelial.rs
   neighborhood = link-graph BFS  ∪  semantically-similar notes
   → latent links + emergent concepts + node/edge roles
      │  IPC (MycelialData)
      ▼
 MycelialView.tsx + mycelial-layout.ts
   force-directed layout → boxes + connections, interactions
```

Two halves: a **Rust corpus engine** that maintains per-notebox statistics
incrementally, and a **frontend view** that requests an analysis for one note
and lays it out.

---

## 2. The corpus engine (`src-tauri/src/corpus_stats/`)

### 2.1 What it counts

`CorpusStats` (in `mod.rs`) maintains, for the whole notebox:

- **Unigram, bigram, and trigram** document-frequencies and corpus-wide counts.
- Per-document *occurrence lists* (for exact subtraction on edit) **and** per-
  document *unique sets* (for fast neighborhood-membership tests). Both are kept
  for bigrams and trigrams because they answer different questions.
- Per-document word counts and the corpus totals that PMI's denominators need.

The token stream comes from `search::text_projection::project()`, which walks
the **parsed Typst AST** and emits only prose text leaves. This is why the
engine never sees markup keywords or the `#note(...)` metadata block, the AST
projection excludes the metadata call and import lines by construction, not by a
keyword denylist. **This exclusion is by design:** properties like `title` and
`description` are *explicit* knowledge you already named; feeding them in would
drown out the latent signal the view exists to surface.

### 2.2 The scores

- **TF-IDF**: `tf = term_count / doc_word_count`, `idf = ln(total_docs /
  doc_freq)`. Distinctiveness: a term frequent in one note but rare across the
  notebox scores high; a term that is everywhere scores ~0.
- **NPMI** (bigrams): `pmi / (−log₂ P(w₁w₂))`, clamped to `[0, 1]`, where
  `pmi = log₂( P(w₁w₂) / (P(w₁)·P(w₂)) )`. How much more often two words
  co-occur than chance predicts — the signal that two words are a *phrase*
  ("social epistemology") not two independent words. The normalization is
  load-bearing: raw PMI is unbounded (8–12 bits for a real collocation) and
  used to dominate the blend, making the ranking effectively corpus-global —
  the historical "same suggestions from every anchor" failure.
- **Cosine similarity** (`similar_docs_scored` / `similarity_map`): ranks
  notes by the cosine of their TF-IDF vectors. This is what gives an
  *unlinked* note a meaningful neighborhood, and (scored) what feeds
  anchor-weighted proximity and kindred-note detection.
- **Anchor-weighted proximity**: each neighborhood note's "contains the term"
  vote is weighted by `max(cosine-to-center, 0.9^BFS-depth)` (weights built by
  the command layer). Presence in the notes *closest to this anchor* counts
  most — the reason two different anchors rank differently.
- **Composite concept score**, computed in two passes: gather raw components,
  then blend after normalizing the TF-IDF component by the run's maximum (its
  raw scale is idf/word-count units; NPMI and proximity already live in
  `[0, 1]`). Unigrams blend `tfidf_weight·tfidf_n + proximity_weight·wprox`;
  n-grams blend `pmi_weight·npmi + proximity_weight·wprox` with a **bigram
  boost (≈1.6×)** and **trigram boost (≈2.0×)** so real multi-word phrases
  outrank bare words (but no longer infinitely — a distinctive unigram
  everywhere in a tight neighborhood can beat a weak collocation).
- **MMR selection**: the final `top_k` slots are filled greedily by
  `score − diversity_lambda · max-Jaccard-overlap(source notes, already
  selected)`, so one dense pair of notes can't supply every suggestion.

### 2.2b The threshold schedule

The old hard `min_corpus_size` cliff is replaced by corpus-size bands
(`SPARSE_CORPUS_DOCS = 10`, `GROWING_CORPUS_DOCS = 50`):

| Corpus size | Emergent concepts | Frequency floors |
|---|---|---|
| < 10 docs | off (statistics are noise) | — |
| 10–49 docs | on, flagged "early growth" in the UI | `min_doc_freq` etc. relax to 2 |
| ≥ 50 docs | on | config defaults |

**Latent links are exempt** from all of it (they run from 2 docs up): they are
name matching, not statistics, and a small notebox is exactly where connecting
the first pages matters. Latent detection is *name-driven* — each existing
page name (1–3 words, all words ≥ 2 chars and non-stopword) is looked up
directly in the per-doc n-gram sets — rather than filtered out of the corpus
frequency tables, so no frequency gate applies.

### 2.3 Phrase boundaries and shingle stitching

Two refinements keep multi-word output meaningful:

- **Punctuation-aware n-grams.** `TextToken` carries a `phrase_break_before`
  flag, set by the projector when it discards a structural punctuation mark
  (comma, paren, slash, colon, spaced em-dash …). The n-gram extractors break a
  run at a phrase break exactly as they break at a stopword. This is the fix for
  the classic failure where a parenthetical list like *"4 institutes (CIADI,
  Milieux, NextGen Cities, AppliedAI)"* produced garbage trigrams sliding across
  comma boundaries. With breaks honoured, "CIADI, Milieux" was never a bigram;
  the members fall back to scoring on their own.
- **Shingle stitching.** Overlapping windows ("a b c", "b c d", "c d e") over
  one genuine run are fused by `stitch_overlapping_shingles()` into the single
  longest phrase, keeping the best score and the union of source notes. The
  command layer re-verifies the stitched phrase appears verbatim in a source
  note before trusting it.

### 2.4 Stopwords and dictionary: three layers

`stopwords.rs` builds the active stopword set from:

1. **Built-in** English + French lists (from
   [stopwords-iso](https://github.com/stopwords-iso/stopwords-iso), MIT),
   merged unconditionally; false positives merely suppress a non-interesting
   tendril, so language detection is unnecessary.
2. **`<notebox>/.inkycap/mycelial-stopwords.txt`**: user-excluded terms (one
   per line, `#` comments). Their domain boilerplate: a university name, a
   project codename.
3. **`<notebox>/.inkycap/dictionary.txt`**: force-*included* terms that
   override stopword membership (also the spell-check allowlist).

`is_builtin_stopword()` lets the UI distinguish "rescue by removing your line"
from "rescue by adding to the dictionary" when a user wants a suppressed term
back.

### 2.5 Incremental updates and persistence

The engine updates per save: `update_doc(path, tokens)` is remove-then-add, so
a re-index subtracts the document's old contribution and adds the new one in
O(words). `remove_doc` only decrements `total_docs` when the document was
actually present, a guard that prevents bulk re-imports (which call
`update_doc` for never-seen docs) from leaving the counter stuck; a
`resync_total_docs()` repairs older persisted snapshots.

State is serialized with `bincode` to the OS cache directory keyed by a hash of
the notebox root (alongside the search index, **not** inside the notebox).
Stopwords are `#[serde(skip)]` and reloaded from the notebox files after
deserialization.

### 2.6 Config (`config.rs`)

`MycelialConfig` holds the tunables. The defaults that shape output most:

| Field | Default | Meaning |
|---|---|---|
| `min_doc_freq` | 3 | a term must appear in ≥3 notes to count (relaxed to 2 under 50 docs) |
| `max_doc_freq_ratio` | 0.6 | skip terms in >60% of notes (too generic) |
| `min_corpus_size` | 20 | **retired** — superseded by the threshold schedule (kept for serde) |
| `min_neighborhood_presence` | 2 | a concept must recur in ≥2 neighborhood notes |
| `semantic_neighbors` | 12 | how many cosine-similar notes join the neighborhood |
| `top_k` | 12 | max suggestions returned |
| `pmi/tfidf/proximity_weight` | 0.4 / 0.3 / 0.3 | composite-score blend |
| `bigram_boost` / `trigram_boost` | 1.6 / 2.0 | phrase-over-word multipliers |
| `diversity_lambda` | 0.5 | MMR overlap penalty (0 = pure score order) |
| `kindred_min_similarity` / `kindred_max` | 0.15 / 3 | kindred-note floor and graph cap |
| `hub_min_backlinks` / `hub_max_words` | 3 / 200 | under-developed-hub thresholds |
| `question_min_words` / `_max_per_note` / `_max_total` | 4 / 3 / 12 | open-question gates |

Below 10 docs the command returns an empty *concept* set (latent links still
run) and the UI says the notebox is still growing; between 10 and 49 docs the
view carries an "early growth" notice. Intentional honesty, not a stub.

---

## 3. The command (`src-tauri/src/commands/mycelial.rs`)

`get_mycelial_data(path, max_depth)` builds one analysis centred on `path`:

1. **Link-graph BFS** (shared `bfs_link_graph()` helper, depth clamped to 3)
   over forward + back links → the explicit-link part of the neighborhood,
   with per-note depths for the weighting below.
2. **Existing-pages map** from the `PropertyIndex`: every note's stem, `title`,
   and aliases, lowercased. This is how a candidate is classified: matches an
   existing page → *latent link*; matches nothing → *emergent concept*.
3. **Neighborhood = link-graph ∪ `similar_docs_scored(center,
   semantic_neighbors)`**, plus an **anchor-weight map**: each note weighs
   `max(cosine-to-center, 0.9^depth)` (center = 1.0). The union is the key
   design correction over a naive "neighborhood = link graph"; the weights are
   what make the analysis anchor-specific. Kindred candidates and hub word
   counts are gathered in the same corpus-lock scope.
4. **Link-index snapshot** (one lock scope, never held across file I/O):
   forward links for the already-linked filter and backlink counts for hubs.
5. **Latent links**: candidates' mentions filtered to notes that don't
   already wikilink the target (located via `resolve_mention`), then
   MMR-selected and normalized (the analyzer returns raw scores so this
   layer owns final selection).
6. **Emergent concepts**: scored candidates with their source mentions
   resolved; concepts with no resolvable mention are dropped.
7. **Role partition**: notes split into **source notes** (provenance: where a
   signal emerged) and **context notes** (wikilink neighbours that surfaced
   *no* signal — listed in the right panel's Linked Context tab, not drawn in
   the graph).
8. **Kindred notes**: semantically-similar candidates with no link path within
   the BFS depth, kept only if not already rendered in another role, capped at
   `kindred_max`, each with its top shared distinctive terms.
9. **Under-developed hubs**: linked-neighborhood notes with
   `backlinks ≥ hub_min_backlinks` and `words ≤ hub_max_words`, ranked by
   reference density, capped at 6.
10. **Open questions**: `extract_questions` over the highest-weighted ≤ 30
    neighborhood notes (a `?` must directly follow projected prose, with ≥
    `question_min_words` tokens since the last sentence terminator), capped
    per note and in total.

`resolve_mention()` reads a note, projects it through the *same*
`text_projection`, finds the term as consecutive tokens on a line, and returns a
~160-char snippet plus the byte range, so a click can open the note and
highlight the exact spot.

### Node roles and edge types

| Node role | Meaning |
|---|---|
| **center** | the note the analysis is built around (pinned at the layout origin) |
| **emergent** | a concept with no page yet: the payoff; click to *crystallize* it into a new note |
| **latent** | an existing page mentioned without a wikilink |
| **kindred** | a note similar to the anchor with no link path to it; shows shared vocabulary, click recenters |
| **source** | a note a signal emerged from (provenance) |
| **context** | a wikilink neighbour with no signal — listed in the Linked Context panel, not drawn |

| Edge type | Meaning |
|---|---|
| **emergent** | concept → the notes it emerged from (width ∝ score) |
| **latent** | mention → the existing page it points at (width ∝ score) |
| **kindred** | anchor → kindred note (long-dashed; width ∝ similarity) |
| **anchor** | a real wikilink among center/source notes (fixed thin weight) |

There is **no concept-to-concept edge** in the literal graph: two emergent
concepts relate only *through a shared source note*. Clusters appear wherever
source notes are shared, which is why an analysis can show two visually
separate islands (e.g. a set of notes pulled in purely by semantic similarity,
wikilinked among themselves but with no link path back to the center).

### Stopword commands

`add_mycelial_stopword`, `rescue_mycelial_term` (append to dictionary),
`remove_mycelial_stopword`, and `ensure_mycelial_stopwords_file` let the UI tune
the corpus without hand-editing files; each recomputes the view.

---

## 4. The frontend

### 4.1 Layout (`src/lib/mycelial-layout.ts`)

A hand-rolled force-directed simulation (no D3): springs along edges, pairwise
repulsion, and gentle gravity toward the origin, seeded deterministically so the
same input lays out the same way. Several constraints earn their keep:

- **Component tethering.** The spring graph is frequently *disconnected* (an
  island whose source notes never reach the center). Union-find detects each
  component; an **invisible tether spring** from the center to a representative
  node pulls every island into one cohesive graph instead of letting weak
  gravity park it offscreen (which forced fit-to-view down to unusable zoom).
- **Long-edge compaction.** A post-pass (`compactLongEdges`) hard-caps any edge
  longer than `SPRING_LENGTH × 2.2`, reeling in pendant nodes that a single
  weak spring couldn't hold against whole-cluster repulsion.
- **Overlap resolution** uses a genuinely fixed card height and radial pushes so
  boxes don't conceal each other (the cause of the old "can't click the concept
  behind another" bug).

### 4.2 The view (`src/components/MycelialView.tsx`)

- **Rendering** splits SVG edges from HTML (`foreignObject`-free) boxes on
  separate pan/zoom transforms, a deliberate workaround for a WebKitGTK
  `foreignObject` repaint issue.
- **Interactions:**
  - Click a **source note** or a **kindred note** → recenter the graph on it
    (with a history trail).
  - Click an **emergent concept** → create a new note titled with the concept,
    pre-populated with wikilinks back to its provenance notes (so the new page
    records *how it emerged*). Long (4+ word) phrases open a title editor first
    so the user can trim the page name.
  - Click a **latent link** → a mention picker (snippet + highlight) opens the
    chosen note at the exact spot to add the wikilink.
  - Right-click any note-backed box (anchor, source, kindred, latent target)
    → "Open in new tab" opens the note in the editor, since left-click is
    taken by recenter / the picker (e.g. read a kindred note to see what
    makes it kindred). Right-click an emergent concept → add to stopwords; a
    `+ stopword` control on the legend lets the user pre-empt noise terms.
  - A **sprout badge** on a note box marks an under-developed hub (tooltip:
    backlinks · words); detail lives in the Growth panel.
- **Legend filters** isolate a kind. When exactly one non-center kind is shown,
  the view synthesizes faint dotted **pathway edges** between siblings that
  share a source note, turning "hide everything else" into "show how these
  relate." Clicking the center legend entry pulses the center rather than
  blanking the canvas.
- **Per-tab caching.** Layout, zoom, pan, filters, history, and the Growth
  data are cached per tab (`src/stores/mycelial.ts`) so switching tabs and
  back is instant and two Mycelial tabs coexist. A `requestMycelialReload()`
  custom event triggers recompute after stopword edits.
- **Right panel** (when a Mycelial tab is focused): three sub-tabs — **Linked
  Context** (wikilink neighbours with no signal), **Growth**
  (`MycelialGrowthPanel`: under-developed pages + open questions, each row
  deep-linking into the note), and **Concept Filtering** (suppressed terms +
  stopword editor). This split is deliberate: secondary data lives in panels,
  not the graph — the lesson of the abandoned "horizon ring".
- **Young-notebox notice.** Below 50 indexed docs the view shows a one-line
  "early growth" banner (mirrors the backend's `GROWING_CORPUS_DOCS` band).

---

## 5. Tuning notes for a few-thousand-note notebox

- Corpus stats build during index build; it's tokenization + hashmap inserts,
  expected sub-second even at thousands of notes. Watch build time if you change
  the extraction cost.
- Too many generic suggestions → raise `min_doc_freq`. Too few → lower it.
- Crowded tendrils → depth 1 (fewer nodes, more room) is the quickest relief.
- The stopword file is the intended escape hatch once you see which domain terms
  surface that aren't interesting.

---

## 6. Key files

| Concern | Path |
|---|---|
| Corpus engine | `src-tauri/src/corpus_stats/mod.rs` |
| Config defaults | `src-tauri/src/corpus_stats/config.rs` |
| Stopwords/dictionary | `src-tauri/src/corpus_stats/stopwords.rs` |
| The command | `src-tauri/src/commands/mycelial.rs` |
| Tokenizer + question extraction | `src-tauri/src/search/text_projection.rs` |
| View | `src/components/MycelialView.tsx` |
| Growth panel | `src/components/MycelialGrowthPanel.tsx` |
| Layout | `src/lib/mycelial-layout.ts` |
| Per-tab store | `src/stores/mycelial.ts` |
| User files | `<notebox>/.inkycap/mycelial-stopwords.txt`, `dictionary.txt` |
