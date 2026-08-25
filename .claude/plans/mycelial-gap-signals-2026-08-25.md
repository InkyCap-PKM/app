# Mycelial View: scoring rework + small-notebox utility + gap signals

**Date:** 2026-08-25
**Scope agreed with user:** items 1, 2, 3 (scoring), 5, 6 (small noteboxes), plus three
gap signals: under-developed hubs, similar-but-unconnected notes, open questions.
**Explicitly skipped:** suggestion snooze/dismiss (item 4).
**Dangling wikilinks (section 2.2): implemented, then REVERTED 2026-08-25 after
in-app testing.** The user clarified that latency specifically means an *unlinked
mention of a page that exists*; dangling wikilinks stay out of the Mycelial View
entirely (the editor already surfaces them inline). Section 2.2 is retained below
as a design record only — none of it is in the codebase.

**Objective (user-stated):** the view exists to find gaps and development
opportunities in the user's thinking, not to visualize existing links. Every change
below is judged by that.

**Diagnosis this plan responds to** (see memory `project-mycelial-view` and the
2026-08-25 session): raw PMI is corpus-global and unbounded, so it dominates the
composite score and produces a near-fixed leaderboard regardless of anchor; the only
anchor-sensitive inputs are a weak flat proximity term and a presence gate that
heavily-overlapping neighbourhoods almost always pass. `min_corpus_size: 20` blanks
the whole analysis on small noteboxes even though latent links need no statistics.

---

## Phase 1 — Scoring rework (repetition fix)

All in `src-tauri/src/corpus_stats/mod.rs` + `config.rs`; command changes in
`src-tauri/src/commands/mycelial.rs`.

### 1.1 NPMI instead of raw PMI

- Add `npmi(&self, bigram_key) -> f64`: `pmi / (−log₂ p_bigram)`, clamped to `[0, 1]`
  (negative association is never a concept signal). Keep `pmi()` for tests/reference.
- Trigram cohesion becomes `min(npmi(w1w2), npmi(w2w3))`.

### 1.2 Component normalization before blending

Restructure `analyze_neighborhood` into two passes:

1. **Gather** candidates (term, n-gram class, raw components: `avg_tfidf`, `npmi`,
   weighted proximity, source notes, neighbourhood count) applying only the hard
   gates (df window, stopwords, presence).
2. **Score**: min-max normalize each component to `[0, 1]` *across the candidate
   pool of this analysis*, then blend with the config weights and apply the n-gram
   boosts, then stitch shingles, then MMR-select (1.4).

This is what makes `pmi_weight/tfidf_weight/proximity_weight` genuinely meaningful
and lets unigrams compete instead of being structurally locked out (raw avg_tfidf is
~idf/word_count ≈ 0.001–0.01 vs raw PMI 5–10).

Normalization is per-run and deterministic; ties broken by term as today.

### 1.3 Anchor-weighted proximity

- Add `similarity_map(&self, center: &Path, paths: &[PathBuf]) -> HashMap<PathBuf, f64>`:
  cosine of each neighbourhood note against the center (same vector math as
  `similar_docs`, restricted to the given set; one pass).
- The command layer builds a **note-weight map**: for each neighbourhood note,
  `w = max(cosine_to_center, depth_decay)` where `depth_decay = 0.9^bfs_depth`
  (BFS depth is already on `FlowNode.depth`; semantic-only notes have no depth and
  use cosine alone). Center itself w = 1.
- `analyze_neighborhood` signature changes from `&[PathBuf]` to accepting the weight
  map. Weighted proximity = Σ w(notes containing term) / Σ w(all notes). The
  `min_neighborhood_presence` gate stays on the raw count.

Different anchors now produce genuinely different rankings: "present in the notes
closest to *this* note" replaces "present anywhere in the blob".

### 1.4 MMR diversity selection

- After stitching, fill the `top_k` emergent slots greedily:
  `next = argmax(score − λ · max_jaccard(source_set, each selected source_set))`,
  `λ = diversity_lambda` (new config field, default 0.5).
- Latent candidates get the same MMR pass **in the command layer**, after the
  already-linked mention filtering (that filtering changes the effective source
  sets), before truncation to `top_k`.

Stops one dense note-pair from supplying half the graph, which is a large part of
the "same paths over and over" feel.

### Config additions (Phase 1)

`diversity_lambda: f64 = 0.5`. No persisted `CorpusStats` fields change, so the
bincode cache stays valid (verify: no struct fields added in this phase).

---

## Phase 2 — Small-notebox utility

### 2.1 Latent links decoupled from corpus size (item 5)

Restructure latent detection to be **name-driven** instead of a side effect of the
corpus-frequency loops:

- Iterate `existing_pages` (1–3-word names; longer names are out of reach of the
  n-gram sets and are skipped in v1), look each name up in
  `doc_unigrams`/`doc_bigram_sets`/`doc_trigram_sets` to find mentioning notes in
  the neighbourhood.
- **No `min_doc_freq` gate, no stopword gate, no `min_corpus_size` gate** (only
  requirement: ≥2 docs indexed). Keep the `max_doc_freq_ratio` guard so a page named
  a ubiquitous word doesn't spam (applies only when N is large enough for the ratio
  to mean something, say N ≥ 20).
- Score = weighted proximity + a small idf bonus, normalized with the same
  Phase 1 machinery.

Side benefit: latent links stop being limited to names that happened to clear
df ≥ 3 as corpus n-grams; any mentioned page name in the window is found.

### 2.2 Dangling wikilinks fold into Latent Links

A dangling wikilink (`#wikilink("Name")` whose target page doesn't exist) becomes a
latent link with no target file: "a page you've referenced but never written".
Placed in Phase 2 deliberately — like name-driven latent links, it needs zero
statistical mass and is high-value on small noteboxes.

- **`LinkIndex` extension** (`src-tauri/src/link_index/mod.rs`): add
  `unresolved: HashMap<NoteId, Vec<String>>`, populated in
  `resolve_and_build_backlinks` and `resolve_note_links` when `StemIndex::resolve`
  returns `None` (today those targets are silently dropped). Accessor
  `get_unresolved_targets(&self, note) -> Vec<String>`. `remove_note` clears the
  entry.
- **Command layer**: for each neighbourhood note, collect unresolved targets;
  normalize (trim, strip `::heading` / `#heading` suffixes, lowercase for
  grouping, keep first-seen casing for display); **drop any name that matches
  `existing_pages`** (stem/title/alias — those resolve conceptually even if the
  stem index missed them, so they are not dangling). Group by name into a latent
  candidate: mentions = the referencing notes, located by scanning each note's
  source for the `wikilink("Name"` call site (the projector emits prose only, so
  `resolve_mention` can't find these; a dedicated small locator returns line +
  byte range of the call).
- **Data model**: `LatentLink.target_path` becomes `Option<String>` plus
  `page_exists: bool`. Scoring joins the latent bucket via the same Phase 1
  normalization; the mention-count and weighted-proximity components apply
  unchanged. A page wikilinked from several notes and never created ranks high,
  which is exactly right.
- **Frontend**: same amber latent box kind (no new legend entry); a "not created
  yet" chip distinguishes it. Click action differs: instead of the mention picker,
  it **creates the page** through the same scaffold path the editor uses when a
  dangling wikilink is clicked (links already exist, so no backfill needed; the
  mention list still shows in the box/panel for context).
- **Tests**: unresolved tracking survives re-resolution and note removal;
  title/alias-named wikilinks are not misclassified as dangling; the wikilink
  call-site locator handles UTF-8 names.

### 2.3 Corpus-size-scaled thresholds (item 6)

- Effective thresholds derived inside `analyze_neighborhood`:
  - `N < 10`: emergent concepts off (latent links still on).
  - `10 ≤ N < 50`: `min_doc_freq = 2`, `bigram_min_freq = 2`, `trigram_min_freq = 2`.
  - `N ≥ 50`: current defaults.
- `MycelialData` gains `total_docs: usize` so the frontend can label confidence.
- Frontend: when `10 ≤ N < 50`, the view shows a one-line "early growth" notice
  (suggestions are tentative on a small notebox); the < 10-notes empty state keeps
  the current "still growing" message but now latent links render if any exist.
- `min_corpus_size` config field is retired in favour of the schedule above
  (kept in the struct for serde compatibility, ignored, doc-commented as such).

---

## Phase 3 — Gap signals (backend)

New data on `MycelialData`; all computed in the command layer per analysis, nothing
new persisted.

### 3.1 Under-developed hubs

- Candidates: neighbourhood notes (BFS part; they must be *linked* to have
  in-degree). For each: `backlinks = link_index.get_backlinks(p).len()`,
  `words = corpus_stats.doc_word_count[p]`.
- A hub qualifies when `backlinks ≥ hub_min_backlinks` (default 3) and
  `words ≤ hub_max_words` (default 200). Rank by `backlinks / (words + 50)`,
  cap at 6.
- Payload: `weak_hubs: Vec<WeakHub { path, name, backlink_count, word_count }>`.

### 3.2 Similar-but-unconnected notes ("kindred")

- Extend `similar_docs` with a scored variant (`similar_docs_scored`) returning
  `(PathBuf, f64)`.
- Kindred = top cosine-similar notes to the center that are **not reachable in the
  BFS link graph at the chosen depth**, not the center, not already latent targets.
  Floor `kindred_min_similarity` (default 0.15, tune empirically), cap
  `kindred_max` (default 3).
- For each, compute **shared distinctive terms**: intersection of the two notes'
  unigram sets minus stopwords, ranked by idf, top 5. This is the "why are these
  kindred" explanation and doubles as writing-prompt material.
- Payload: `kindred_notes: Vec<KindredNote { path, name, similarity, shared_terms }>`.
- Cluster-level detection (two whole clusters that never touch) is deferred;
  note-level relative to the anchor covers the actionable case without new
  graph-wide machinery.

### 3.3 Open questions

- Extend `TextProjection` with `question_spans: Vec<QuestionSpan { line, char_start,
  char_end }>`: a span covers the sentence tokens accumulated since the last
  sentence terminator when the projector encounters `?` in the discarded separator
  text (the same place `gap_breaks_phrase` already inspects punctuation). Not
  persisted anywhere; the search index ignores the field.
- Command layer: for neighbourhood notes ordered by note weight (closest first,
  cap ~30 notes), read + project (same cost profile as `resolve_mention`, which
  already does this per mention) and collect question sentences.
- Quality gates: ≥ `question_min_words` tokens (default 4) so fragments and
  rhetorical one-worders drop; ≤ `question_max_per_note` (default 3) and
  ≤ `question_max_total` (default 12).
- Payload: `open_questions: Vec<NoteQuestions { path, name, questions: Vec<{ text,
  line, char_start, char_end }> }>` — text is the raw sentence (UTF-8-safe slicing
  via the token byte offsets; snippet-trimmed like `trim_snippet`).

### Config additions (Phase 3)

`hub_min_backlinks = 3`, `hub_max_words = 200`, `kindred_min_similarity = 0.15`,
`kindred_max = 3`, `question_min_words = 4`, `question_max_per_note = 3`,
`question_max_total = 12`.

---

## Phase 4 — Display design (frontend)

Guiding decision (recorded preference, learned from the horizon-ring failure):
**secondary data lives in panels, not the graph.** Only one of the three new
signals earns graph presence.

### 4.1 Kindred notes → in the graph (the one new node kind)

The whole message of this signal is a *relationship that doesn't exist*, which only
a graph can say. Changes:

- `mycelial-layout.ts`: `BoxKind` gains `"kindred"`, `ConnectionKind` gains
  `"kindred"`; kindred boxes sized like source boxes, one dashed edge each,
  straight to the center.
- `MycelialView.tsx`: legend entry (filterable like the others), distinct colour
  token (new `--mycelial-kindred` in `themes.css`, following the existing mycelial
  token family; visually distinct from amber/brown; dashed edge with a wider dash
  than latent so the two dashed styles don't read as one).
- Box content: note name + "similar, not linked" subtitle + the shared terms as a
  small chip row (the explanation *is* the payload).
- Click → recenter on that note (same interaction as source notes), which is
  exactly the "go look at the other circle of thought" action.
- Cap of 3 keeps the graph readable; the legend filter hides them entirely when
  unwanted.

### 4.2 Under-developed hubs → panel section + badge on existing nodes

Hubs are notes the user already knows; the insight is an *attribute* (thin +
heavily referenced), not a new relationship. So:

- No new node kind. If a hub already appears in the graph (as center or source), its
  box gets a small badge (sprout icon) with tooltip "N backlinks · M words".
- Panel: listed in the new **Growth** tab (4.4) as rows "name · N backlinks ·
  M words", click opens the note. Hubs that are only in the Linked Context list also
  get the badge there.

### 4.3 Open questions → panel only

Question sentences are text snippets; as graph boxes they would dwarf every other
node and wreck the layout. Panel-only:

- Growth tab section "Open questions", grouped by note (reusing the
  `search-panel__file-group` expandable pattern the Linked Context list already
  uses), each question row click-navigates to the exact line via the existing
  mention deep-link mechanics.

### 4.4 Right-panel structure

`RightPanel.tsx`: the mycelial sub-tab pair (Linked Context, Concept Filtering)
becomes a trio with **Growth** (sections: Under-developed pages, Open questions).
State cached per tab in `stores/mycelial.ts` alongside the existing view cache.

### 4.5 i18n

New keys under `mycelial.*` and `rightPanel.mycelial.*` in `en.json` **and**
`fr-CA.json` (parity enforced by `npm run i18n:check`). Legend labels, tab title,
section headings, badge tooltip, early-growth notice, empty states.

---

## Phase 5 — Docs, tests, validation

### Tests (Rust, `corpus_stats` + command layer)

- `npmi` bounds and a hand-computed value; trigram cohesion via NPMI.
- Component normalization: weights change ranking as expected on a synthetic corpus.
- Anchor sensitivity: two synthetic clusters; the same corpus analyzed from anchors
  in different clusters must produce different top concepts (this is the regression
  test for the whole repetition complaint).
- MMR: with λ > 0, selected concepts' source sets overlap less than score-only
  selection.
- Latent links at N = 5 (page name mentioned in one other note, no link → found).
- Threshold schedule at N = 9 / 15 / 60.
- Hub detection thresholds; kindred excludes BFS-reachable notes.
- Question extraction: basic, multi-byte UTF-8 before `?`, min-word gate,
  markup-heavy lines (question mark inside code/math must not fire — projector
  only sees prose, verify).

### Docs

- `documentation/developer/subsystems/mycelial-view.md`: scoring section (NPMI,
  normalization, weighted proximity, MMR), new signals, new config table, updated
  pipeline diagram; also fix the stale "horizon ring" wording (context notes live
  in the right panel).
- Manual note `4 - Views and Navigation/5 - Mycelial View.typ`: the "fewer than 20
  notes" callout must be rewritten (latent links now work on small noteboxes;
  emergent concepts from 10 notes, tentative below 50); legend gains kindred; new
  Growth tab section; compile-validate the note.

### Gates

`cargo test`, `cargo clippy`, `npm test`, `npm run i18n:check`, plus an in-app pass
on the user's real notebox (the repetition complaint is only truly falsifiable
there: open the view from several unrelated anchors and confirm the suggestion sets
diverge).

---

## Sequencing and risk notes

- Phases 1–2 are pure backend and independently shippable; Phase 3 backend and
  Phase 4 frontend land together (payload + display).
- No `CorpusStats` persisted-schema changes anywhere; the bincode cache survives.
  (`TextProjection.question_spans` is transient.)
- `analyze_neighborhood`'s signature change (weight map) touches only the one call
  site in `mycelial.rs`.
- Perf: `similarity_map` is one restricted cosine pass; question extraction reads
  ≤ 30 neighbourhood files per analysis, comparable to existing `resolve_mention`
  traffic. Watch total command time on the 2k-note box; the command is already the
  heaviest read-side path.
- Tuning constants (`kindred_min_similarity`, hub thresholds, λ) are best-guess
  defaults; expect one calibration pass against the user's real notebox.
