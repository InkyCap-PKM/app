//! Mycelial View command.
//!
//! The Mycelial View is not a link-graph browser — backlinks and forward
//! links are deliberately *not* the point. It surfaces where a notebox wants
//! to grow next (gaps to fill, ideas to develop), via signals computed over a
//! note's neighborhood:
//!
//! - **Latent links** — an existing page is mentioned in other notes as plain
//!   text, with no wikilink. Clicking one lets the user go connect them.
//!   (Dangling wikilinks — links to pages never created — are deliberately
//!   NOT part of this signal: latency is about *unlinked mentions of pages
//!   that exist*, and the editor already surfaces dangling links inline.)
//! - **Emergent concepts** — a recurring term/phrase with no page of its own,
//!   representing knowledge the user has developed implicitly. Clicking one
//!   creates a new page seeded with the connections it emerged from.
//! - **Kindred notes** — semantically close to the anchor with no link path
//!   to it; the one gap signal rendered as its own graph node kind.
//! - **Under-developed hubs** and **open questions** — Growth-panel signals
//!   (referenced-but-thin pages; question sentences left in prose).
//!
//! The neighborhood those signals are computed over is **not** just the link
//! graph: it is the link graph *unioned with the most semantically similar
//! notes*, and each note is *anchor-weighted* (cosine-to-center, floored by a
//! BFS-depth decay) so the analysis is genuinely specific to this anchor.
//!
//! Notes split into two visual roles: **source notes** (provenance — a note a
//! signal emerged from) and **context notes** (existing wikilink neighbors
//! that surface no signal — listed in the right panel for orientation).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::flow::{bfs_link_graph, FlowEdge, FlowNode};
use crate::corpus_stats::MycelialConfig;
use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::local::LocalNoteboxStorage;
use crate::storage::traits::NoteboxStorage;
use crate::storage::{sanitize_notebox_arg, to_frontend_string};

/// Maximum characters in a context snippet shown inside a mycelial box.
const SNIPPET_MAX_CHARS: usize = 160;
/// Maximum mention sites kept per latent link / emergent concept.
const MAX_MENTIONS: usize = 8;
/// Per-BFS-hop floor on a linked note's anchor weight (`0.9^depth`), so an
/// explicitly linked note never weighs zero even when its vocabulary shares
/// nothing with the center.
const DEPTH_DECAY: f64 = 0.9;
/// Shared distinctive terms shown on a kindred node.
const KINDRED_SHARED_TERMS: usize = 5;
/// Maximum under-developed hubs listed per analysis.
const MAX_WEAK_HUBS: usize = 6;
/// Maximum neighborhood notes read for open-question extraction — bounds the
/// pass's file I/O on dense neighborhoods.
const MAX_QUESTION_NOTES: usize = 30;

/// One note that mentions a term, with enough context to render a
/// search-result-style snippet and to deep-link the editor to the spot.
#[derive(Debug, Clone, Serialize)]
pub struct SourceMention {
    /// Notebox path of the mentioning note.
    pub path: String,
    /// File stem, for display below the concept phrase.
    pub name: String,
    /// Trimmed line of context where the term appears.
    pub snippet: String,
    /// 1-indexed line number of the mention.
    pub line: usize,
    /// Byte offset of the mention start within its line.
    pub char_start: usize,
    /// Byte offset of the mention end within its line.
    pub char_end: usize,
}

/// An existing page mentioned in notes that haven't linked to it yet.
#[derive(Debug, Clone, Serialize)]
pub struct LatentLink {
    /// The phrase as it recurs in note text (lowercased corpus form).
    pub term: String,
    /// Notebox path of the existing page the mentions should link to.
    pub target_path: String,
    /// Display name of the target page.
    pub target_name: String,
    pub score: f64,
    pub is_bigram: bool,
    /// Notes that mention the term without a wikilink to `target_path`.
    pub mentions: Vec<SourceMention>,
}

/// A recurring concept with no page of its own — a candidate new note.
#[derive(Debug, Clone, Serialize)]
pub struct EmergentConcept {
    /// The recurring term/phrase.
    pub term: String,
    pub score: f64,
    pub is_bigram: bool,
    /// Notes where the concept surfaced.
    pub mentions: Vec<SourceMention>,
}

/// A term the stopword filter held back that would otherwise have surfaced as
/// an emergent concept. Shown in the Concept Filtering pane so the user can see
/// what was suppressed and rescue a word that matters in their notebox.
#[derive(Debug, Clone, Serialize)]
pub struct ExcludedTerm {
    pub term: String,
    /// Neighborhood notes the term recurs in — the "worth rescuing?" signal.
    pub doc_count: usize,
    /// `"builtin"` (bundled EN/FR list — rescue via dictionary.txt) or `"user"`
    /// (the notebox's mycelial-stopwords.txt — rescue by removing the line).
    pub source: String,
}

/// A note referenced often but barely written — high backlink count, low
/// word count. Shown in the Growth panel (and as a badge on its graph node)
/// as an under-developed page worth expanding.
#[derive(Debug, Clone, Serialize)]
pub struct WeakHub {
    pub path: String,
    pub name: String,
    pub backlink_count: usize,
    pub word_count: usize,
}

/// A note semantically close to the anchor with no link path to it within
/// the BFS depth — two circles of thought that never touch. Rendered as its
/// own (dashed-edge) node kind; `shared_terms` explains *why* the two notes
/// read as kindred.
#[derive(Debug, Clone, Serialize)]
pub struct KindredNote {
    pub path: String,
    pub name: String,
    /// Cosine similarity to the anchor, in (0, 1].
    pub similarity: f64,
    /// Most distinctive vocabulary the two notes share (rarest first).
    pub shared_terms: Vec<String>,
}

/// One question sentence found in a note's prose.
#[derive(Debug, Clone, Serialize)]
pub struct OpenQuestion {
    /// The sentence text (snippet-trimmed).
    pub text: String,
    /// 1-indexed line number.
    pub line: usize,
    /// Byte offsets of the sentence within its line, for deep-link highlight.
    pub char_start: usize,
    pub char_end: usize,
}

/// The open questions of one neighborhood note, for the Growth panel.
#[derive(Debug, Clone, Serialize)]
pub struct NoteQuestions {
    pub path: String,
    pub name: String,
    pub questions: Vec<OpenQuestion>,
}

/// Complete data for the Mycelial View rendering.
#[derive(Debug, Clone, Serialize)]
pub struct MycelialData {
    pub center: String,
    /// Notes a signal emerged from — rendered as inner provenance nodes.
    pub source_notes: Vec<FlowNode>,
    /// Existing wikilink neighbors that surfaced no signal — listed in the
    /// Linked Context panel for orientation.
    pub context_notes: Vec<FlowNode>,
    /// Wikilinks among center / source / context notes — faint context.
    pub context_edges: Vec<FlowEdge>,
    pub latent_links: Vec<LatentLink>,
    pub emergent_concepts: Vec<EmergentConcept>,
    /// Terms the stopword filter suppressed (would-be concepts) — surfaced for
    /// the Concept Filtering pane.
    pub excluded_terms: Vec<ExcludedTerm>,
    /// Similar-but-unlinked notes — the one gap signal that earns graph
    /// presence (a relationship that doesn't exist is a graph's message).
    pub kindred_notes: Vec<KindredNote>,
    /// Under-developed pages in the neighborhood — Growth panel + node badge.
    pub weak_hubs: Vec<WeakHub>,
    /// Question sentences across the neighborhood — Growth panel only.
    pub open_questions: Vec<NoteQuestions>,
    /// Indexed corpus size, so the frontend can label confidence on young
    /// noteboxes ("early growth" notice below `GROWING_CORPUS_DOCS`).
    pub total_docs: usize,
    /// True when the centre note matches the notebox's Mycelial exclusion
    /// rules. It is analyzed anyway (the user opened the view on it); the
    /// frontend shows a notice explaining that.
    pub center_excluded: bool,
}

/// Build the Mycelial View graph centred on `path`: BFS the wikilink graph to
/// `max_depth`, widen it with the most semantically-similar notes (corpus
/// stats), then surface latent links and emergent concepts with their source
/// mentions. The heaviest read-side command — see the inline step comments.
#[tauri::command]
pub async fn get_mycelial_data(
    path: String,
    max_depth: Option<usize>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<MycelialData, InkyCapError> {
    let session = state.session(window.label()).await;
    let max_depth = max_depth.unwrap_or(2).min(3);
    let center_path = sanitize_notebox_arg(&path)?;
    // The centre note's id, in the same `to_frontend_string` shape every other
    // node id (and every edge endpoint) carries. The raw `path` argument is an
    // OS-native string — on Windows it may use `\` separators or a `\\?\`
    // verbatim prefix — so using it directly as the centre id makes it
    // string-unequal to its own edges in the frontend layout, which collapses
    // the graph to just the anchor. Deriving the id here keeps it consistent.
    let center_id = to_frontend_string(&center_path);
    let config = MycelialConfig::default();
    let storage = session.get_storage().await?;

    // 0. Notebox-wide note exclusions: notes matching the user's exclusion
    //    rules take no part in any calculation below — they don't appear in
    //    the graph, don't bridge links, and don't feed the corpus analysis.
    //    The centre note is the one exception: the user opened the view on
    //    it, so it always participates; `center_excluded` tells the frontend
    //    to explain that.
    let exclusion_group =
        crate::commands::mycelial_exclusions::load_exclusion_group(storage.root()).await;
    let (excluded, center_excluded) = match &exclusion_group {
        Some(group) => {
            let prop_index = session.property_index.read().await;
            let mut set = crate::commands::mycelial_exclusions::excluded_note_paths(
                &prop_index,
                group,
                storage.root(),
            );
            let center_excluded = set.remove(&center_path);
            (set, center_excluded)
        }
        None => (HashSet::new(), false),
    };

    // 1. BFS the link graph — these are the notebox's explicit connections.
    let (link_nodes, link_edges) = {
        let link_index = session.link_index.read().await;
        bfs_link_graph(&link_index, &center_path, &center_id, max_depth, &excluded)
    };

    // 2. Map every existing page name -> its path, so corpus analysis can tell
    //    a latent link (page exists) from an emergent concept (no page).
    //
    //    A page is named by its file stem *and* by its `title` property *and*
    //    by any `aliases`. Stem alone is not enough: notes with ZID-style
    //    filenames (`Some Concept 20210628145342`) carry their human-facing
    //    name only in `title`, so a stem-only check would misclassify a
    //    recurring concept as "emergent" even though its page already exists.
    let existing_pages: HashMap<String, String> = {
        let prop_index = session.property_index.read().await;
        let mut map: HashMap<String, String> = HashMap::new();
        let mut add = |name: &str, path: &str| {
            let key = name.trim().to_lowercase();
            if !key.is_empty() {
                map.entry(key).or_insert_with(|| path.to_string());
            }
        };
        for (note_path, meta) in &prop_index.notes {
            let path_str = to_frontend_string(note_path);
            if let Some(stem) = note_path.file_stem() {
                // Decode any leftover `%XX` URL-escapes (a `%20` in a file
                // name would otherwise never match the plain-text concept).
                add(&percent_decode(&stem.to_string_lossy()), &path_str);
            }
            if let Some(crate::models::note::PropertyValue::String(title)) =
                meta.properties.get("title")
            {
                add(title, &path_str);
            }
        }
        for (alias, ids) in prop_index.aliases_iter() {
            if let Some(first) = ids.first() {
                add(alias, &to_frontend_string(first));
            }
        }
        map
    };

    // 3. Build the analysis neighborhood (the link graph widened with the
    //    most semantically similar notes) and its anchor weights, and run the
    //    corpus analysis. Everything needing the corpus lock happens here.
    let (analysis, link_node_ids, note_weights, kindred_raw, word_counts, total_docs) = {
        let corpus_stats = session.corpus_stats.read().await;

        // Scored semantic neighbors — the widening set, and (scored) the
        // kindred-note candidates. Excluded notes are dropped before they can
        // widen the neighborhood or surface as kindred.
        let similar: Vec<(PathBuf, f64)> = corpus_stats
            .similar_docs_scored(&center_path, config.semantic_neighbors)
            .into_iter()
            .filter(|(p, _)| !excluded.contains(p))
            .collect();

        let mut neighborhood: HashSet<PathBuf> =
            link_nodes.iter().map(|n| PathBuf::from(&n.id)).collect();
        neighborhood.insert(center_path.clone());
        for (p, _) in &similar {
            neighborhood.insert(p.clone());
        }
        let neighborhood: Vec<PathBuf> = neighborhood.into_iter().collect();
        let link_node_ids: HashSet<String> = link_nodes.iter().map(|n| n.id.clone()).collect();

        // Anchor weights: each neighborhood note votes in proportion to its
        // cosine similarity to the center, floored for BFS notes by a depth
        // decay so an explicitly linked note never weighs zero. This is what
        // makes the analysis anchor-specific.
        let cosine = corpus_stats.similarity_map(&center_path, &neighborhood);
        let depth_of: HashMap<PathBuf, usize> = link_nodes
            .iter()
            .map(|n| (PathBuf::from(&n.id), n.depth))
            .collect();
        let mut note_weights: HashMap<PathBuf, f64> = HashMap::new();
        for p in &neighborhood {
            let w = if *p == center_path {
                1.0
            } else {
                let sim = cosine.get(p).copied().unwrap_or(0.0);
                let decay = depth_of
                    .get(p)
                    .map(|d| DEPTH_DECAY.powi(*d as i32))
                    .unwrap_or(0.0);
                sim.max(decay)
            };
            note_weights.insert(p.clone(), w);
        }

        // Kindred candidates: semantically close, no link path within the
        // BFS depth. Gathered with headroom — the final pass drops any that
        // already render as source notes or latent targets.
        let kindred_raw: Vec<(PathBuf, f64, Vec<String>)> = similar
            .iter()
            .filter(|(p, s)| {
                *s >= config.kindred_min_similarity
                    && !link_node_ids.contains(&to_frontend_string(p))
            })
            .take(config.kindred_max * 2)
            .map(|(p, s)| {
                (
                    p.clone(),
                    *s,
                    corpus_stats.shared_distinctive_terms(&center_path, p, KINDRED_SHARED_TERMS),
                )
            })
            .collect();

        // Word counts of the linked neighborhood, for hub detection.
        let word_counts: HashMap<PathBuf, usize> = link_nodes
            .iter()
            .filter_map(|n| {
                let p = PathBuf::from(&n.id);
                corpus_stats.word_count_of(&p).map(|wc| (p, wc))
            })
            .collect();

        (
            corpus_stats.analyze_neighborhood(&note_weights, &existing_pages, &config),
            link_node_ids,
            note_weights,
            kindred_raw,
            word_counts,
            corpus_stats.total_docs,
        )
    };

    // 4. Snapshot everything the latent/hub passes need from the link index
    //    in one lock scope, so the read guard is never held across the file
    //    I/O below — a concurrent reindex needs the write lock.
    let (forward_links, backlink_counts) = {
        let link_index = session.link_index.read().await;

        // Forward links of latent candidates' sources, for the
        // already-linked filter.
        let mut forward: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
        for cand in &analysis.latent {
            for src in &cand.source_notes {
                let src_path = PathBuf::from(src);
                forward
                    .entry(src_path.clone())
                    .or_insert_with(|| link_index.get_forward_links(&src_path));
            }
        }

        // Backlink counts of the linked neighborhood, for hub detection.
        let backlink_counts: HashMap<PathBuf, usize> = word_counts
            .keys()
            .map(|p| (p.clone(), link_index.get_backlinks(p).len()))
            .collect();

        (forward, backlink_counts)
    };

    // Under-developed pages the user has chosen to hide from the Growth panel.
    let hub_exclusions = load_hub_exclusions(storage.root()).await;

    // 5. Latent links: keep only notes that mention the target without a
    //    wikilink to it (the analyzer returns raw scores), then MMR-select
    //    and normalize. The draft carries the mentioning-note ids as the MMR
    //    diversity source set.
    struct LatentDraft {
        term: String,
        target_path: String,
        target_name: String,
        score: f64,
        is_bigram: bool,
        mentions: Vec<SourceMention>,
        source_ids: Vec<String>,
    }

    let mut drafts: Vec<LatentDraft> = Vec::new();
    for cand in analysis.latent {
        let target = PathBuf::from(&cand.target_path);
        // An excluded page never surfaces as a latent-link target. It stays
        // in `existing_pages`, though, so its name can't be misread as an
        // emergent concept with no page.
        if excluded.contains(&target) {
            continue;
        }
        let mut mentions: Vec<SourceMention> = Vec::new();
        for src in &cand.source_notes {
            let src_path = PathBuf::from(src);
            if src_path == target {
                continue;
            }
            let already_linked = forward_links
                .get(&src_path)
                .is_some_and(|f| f.iter().any(|p| p == &target));
            if already_linked {
                continue;
            }
            if let Some(m) = resolve_mention(storage.as_ref(), &src_path, &cand.term).await {
                mentions.push(m);
            }
            if mentions.len() >= MAX_MENTIONS {
                break;
            }
        }
        if mentions.is_empty() {
            continue;
        }
        let source_ids: Vec<String> = mentions.iter().map(|m| m.path.clone()).collect();
        drafts.push(LatentDraft {
            term: cand.term,
            target_name: stem_name(&target),
            target_path: cand.target_path,
            score: cand.score,
            is_bigram: cand.is_bigram,
            mentions,
            source_ids,
        });
    }

    drafts.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.term.cmp(&b.term))
    });
    let mut drafts = crate::corpus_stats::mmr_select(
        drafts,
        config.top_k,
        config.diversity_lambda,
        |d: &LatentDraft| d.score,
        |d: &LatentDraft| d.source_ids.as_slice(),
    );
    // Normalize for display (edge widths scale off the score). The first
    // selected draft carries the maximum raw score.
    let max_latent = drafts.first().map(|d| d.score).unwrap_or(0.0);
    if max_latent > 0.0 {
        for d in &mut drafts {
            d.score /= max_latent;
        }
    }
    let latent_links: Vec<LatentLink> = drafts
        .into_iter()
        .map(|d| LatentLink {
            term: d.term,
            target_path: d.target_path,
            target_name: d.target_name,
            score: d.score,
            is_bigram: d.is_bigram,
            mentions: d.mentions,
        })
        .collect();

    // 6. Emergent concepts: resolve a context snippet for each source note.
    let mut emergent_concepts: Vec<EmergentConcept> = Vec::new();
    for cand in analysis.emergent {
        let mut mentions: Vec<SourceMention> = Vec::new();
        for src in cand.source_notes.iter().take(MAX_MENTIONS) {
            let src_path = PathBuf::from(src);
            if let Some(m) = resolve_mention(storage.as_ref(), &src_path, &cand.term).await {
                mentions.push(m);
            }
        }
        if mentions.is_empty() {
            continue;
        }
        emergent_concepts.push(EmergentConcept {
            term: cand.term,
            score: cand.score,
            is_bigram: cand.is_bigram,
            mentions,
        });
    }

    // 7. Partition notes into provenance (source) and orientation (context).
    //    Source notes = anything a signal emerged from. Context notes =
    //    explicit wikilink neighbors that surfaced no signal — the horizon.
    let mut source_ids: HashSet<String> = HashSet::new();
    let mut latent_targets: HashSet<String> = HashSet::new();
    for ll in &latent_links {
        latent_targets.insert(ll.target_path.clone());
        for m in &ll.mentions {
            source_ids.insert(m.path.clone());
        }
    }
    for ec in &emergent_concepts {
        for m in &ec.mentions {
            source_ids.insert(m.path.clone());
        }
    }
    source_ids.remove(&center_id);

    // 8. Kindred notes: keep only candidates not already rendered in another
    //    role — kindred rescues notes that are otherwise invisible (similar,
    //    unlinked, and sourcing no signal).
    let kindred_notes: Vec<KindredNote> = kindred_raw
        .into_iter()
        .filter(|(p, _, _)| {
            let id = to_frontend_string(p);
            id != center_id && !source_ids.contains(&id) && !latent_targets.contains(&id)
        })
        .take(config.kindred_max)
        .map(|(p, similarity, shared_terms)| KindredNote {
            path: to_frontend_string(&p),
            name: stem_name(&p),
            similarity,
            shared_terms,
        })
        .collect();

    // 9. Under-developed hubs: linked-neighborhood notes referenced often but
    //    barely written. Ranked by reference density (backlinks per word).
    let mut weak_hubs: Vec<WeakHub> = word_counts
        .iter()
        .filter_map(|(p, &wc)| {
            let backlinks = backlink_counts.get(p).copied().unwrap_or(0);
            let id = to_frontend_string(p);
            if backlinks >= config.hub_min_backlinks
                && wc <= config.hub_max_words
                && !hub_exclusions.contains(&id)
            {
                Some(WeakHub {
                    name: stem_name(p),
                    path: id,
                    backlink_count: backlinks,
                    word_count: wc,
                })
            } else {
                None
            }
        })
        .collect();
    weak_hubs.sort_by(|a, b| {
        let da = a.backlink_count as f64 / (a.word_count + 50) as f64;
        let db = b.backlink_count as f64 / (b.word_count + 50) as f64;
        db.partial_cmp(&da)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    weak_hubs.truncate(MAX_WEAK_HUBS);

    // 10. Open questions: question sentences across the neighborhood,
    //     nearest (highest-weighted) notes first, hard-capped so the pass
    //     reads a bounded number of files.
    let mut by_weight: Vec<(&PathBuf, f64)> = note_weights.iter().map(|(p, w)| (p, *w)).collect();
    by_weight.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(b.0))
    });
    let mut open_questions: Vec<NoteQuestions> = Vec::new();
    let mut total_questions = 0usize;
    for (p, _) in by_weight.into_iter().take(MAX_QUESTION_NOTES) {
        if total_questions >= config.question_max_total {
            break;
        }
        let Ok(content) = storage.read_file(p).await else {
            continue;
        };
        let projection = crate::search::text_projection::project(&content);
        let spans = crate::search::text_projection::extract_questions(
            &content,
            &projection,
            config.question_min_words,
            config.question_max_per_note,
        );
        if spans.is_empty() {
            continue;
        }
        let questions: Vec<OpenQuestion> = spans
            .into_iter()
            .take(config.question_max_total - total_questions)
            .map(|q| OpenQuestion {
                text: trim_snippet(&q.text),
                line: q.line + 1,
                char_start: q.char_start,
                char_end: q.char_end,
            })
            .collect();
        total_questions += questions.len();
        open_questions.push(NoteQuestions {
            path: to_frontend_string(p),
            name: stem_name(p),
            questions,
        });
    }

    // `source_ids` / `link_node_ids` are HashSets — iteration order varies
    // per call. Sort the rendered node lists by id so the Mycelial View
    // layout (whose force simulation seeds off input order) is stable across
    // recomputes of the same notebox.
    let mut source_notes: Vec<FlowNode> = source_ids
        .iter()
        .map(|p| flow_node(p, &center_id))
        .collect();
    source_notes.sort_by(|a, b| a.id.cmp(&b.id));

    let mut context_notes: Vec<FlowNode> = link_node_ids
        .iter()
        .filter(|id| {
            **id != center_id && !source_ids.contains(*id) && !latent_targets.contains(*id)
        })
        .map(|p| flow_node(p, &center_id))
        .collect();
    context_notes.sort_by(|a, b| a.id.cmp(&b.id));

    // Faint wikilinks among the rendered notes (excludes latent targets,
    // whose connections are shown as the latent links themselves).
    let rendered: HashSet<&String> = std::iter::once(&center_id)
        .chain(source_ids.iter())
        .chain(context_notes.iter().map(|n| &n.id))
        .collect();
    let mut context_edges: Vec<FlowEdge> = link_edges
        .into_iter()
        .filter(|e| rendered.contains(&e.source) && rendered.contains(&e.target))
        .collect();
    context_edges.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.target.cmp(&b.target))
    });

    let excluded_terms: Vec<ExcludedTerm> = analysis
        .excluded
        .into_iter()
        .map(|e| ExcludedTerm {
            term: e.term,
            doc_count: e.doc_count,
            source: e.source,
        })
        .collect();

    Ok(MycelialData {
        center: center_id,
        source_notes,
        context_notes,
        context_edges,
        latent_links,
        emergent_concepts,
        excluded_terms,
        kindred_notes,
        weak_hubs,
        open_questions,
        total_docs,
        center_excluded,
    })
}

/// Build a `FlowNode` for a note path, marking the center note.
fn flow_node(id: &str, center: &str) -> FlowNode {
    let is_center = id == center;
    FlowNode {
        id: id.to_string(),
        name: stem_name(&PathBuf::from(id)),
        depth: if is_center { 0 } else { 1 },
        direction: if is_center { "center" } else { "anchor" }.to_string(),
    }
}

/// Decode `%XX` percent-escapes (e.g. a `%20` left in a file name).
///
/// Works in the byte domain so a multi-byte UTF-8 character spread across
/// several escapes reassembles correctly, then rebuilds a `String` lossily.
/// A `%` not followed by two hex digits is left verbatim.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Numeric value of a single ASCII hex digit, or `None` if not a hex digit.
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// File stem of a path, for display.
fn stem_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Read a note and locate the first occurrence of `term`, returning a
/// `SourceMention` with a context snippet and the mention's byte range.
///
/// Matching runs over `text_projection` tokens — the same projection the
/// corpus engine uses — so it inherits the exclusion of the `#note(...)`
/// metadata block and import line, and never points a snippet at a property.
async fn resolve_mention(
    storage: &LocalNoteboxStorage,
    path: &Path,
    term: &str,
) -> Option<SourceMention> {
    let content = storage.read_file(path).await.ok()?;
    let projection = crate::search::text_projection::project(&content);
    let tokens = &projection.tokens;
    let words: Vec<String> = term.split(' ').map(|w| w.to_lowercase()).collect();
    if words.is_empty() {
        return None;
    }

    let lines: Vec<&str> = content.lines().collect();
    for i in 0..tokens.len() {
        // The term's words must match consecutive tokens on a single line.
        let matched = words.iter().enumerate().all(|(k, w)| {
            tokens
                .get(i + k)
                .map(|t| t.word.to_lowercase() == *w && t.line == tokens[i].line)
                .unwrap_or(false)
        });
        if !matched {
            continue;
        }
        let first = &tokens[i];
        let last = &tokens[i + words.len() - 1];
        let snippet = lines
            .get(first.line)
            .map(|l| trim_snippet(l))
            .unwrap_or_default();
        return Some(SourceMention {
            path: to_frontend_string(path),
            name: stem_name(path),
            snippet,
            line: first.line + 1,
            char_start: first.char_start,
            char_end: last.char_end,
        });
    }
    None
}

/// Trim surrounding whitespace and truncate to a printable character budget.
/// UTF-8 safe: truncation works on `chars()`.
fn trim_snippet(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= SNIPPET_MAX_CHARS {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(SNIPPET_MAX_CHARS).collect();
    out.push('…');
    out
}

/// Append `term` (lowercased) as its own line to a word-list file (stopwords or
/// dictionary), creating the file and parent directory if needed and skipping
/// the write when the word is already present. Shared by the stopword-add,
/// term-rescue, and spellcheck add-to-dictionary commands.
pub(crate) async fn append_unique_word(path: &Path, term: &str) -> Result<(), InkyCapError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let existing = tokio::fs::read_to_string(path).await.unwrap_or_default();
    let lowered = term.to_lowercase();
    if existing
        .lines()
        .any(|line| line.trim().to_lowercase() == lowered)
    {
        return Ok(());
    }
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    let line = if existing.ends_with('\n') || existing.is_empty() {
        format!("{lowered}\n")
    } else {
        format!("\n{lowered}\n")
    };
    file.write_all(line.as_bytes()).await?;
    Ok(())
}

/// Append `term` to the notebox's `mycelial-stopwords.txt` so it stops
/// surfacing as an emergent concept, and reload the in-memory stopword set.
#[tauri::command]
pub async fn add_mycelial_stopword(
    term: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let stopwords_path = storage
        .root()
        .join(".inkycap")
        .join("mycelial-stopwords.txt");
    append_unique_word(&stopwords_path, &term).await?;

    // Reload stopwords in the corpus stats engine.
    let mut corpus = session.corpus_stats.write().await;
    corpus.reload_stopwords(Some(storage.root()));

    Ok(())
}

/// Rescue a term suppressed by a *built-in* stopword: force-include it by
/// appending to the notebox's `dictionary.txt`, which removes it from the
/// active stopword set even though a bundled list contains it. The term can
/// then surface as an emergent concept / latent link.
#[tauri::command]
pub async fn rescue_mycelial_term(
    term: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let dict_path = storage.root().join(".inkycap").join("dictionary.txt");
    append_unique_word(&dict_path, &term).await?;

    let mut corpus = session.corpus_stats.write().await;
    corpus.reload_stopwords(Some(storage.root()));

    Ok(())
}

/// Rescue a term the user themselves added to `mycelial-stopwords.txt` by
/// removing its line, rather than masking it via the dictionary. No-op if the
/// term isn't present (e.g. it was a built-in stopword — use rescue instead).
#[tauri::command]
pub async fn remove_mycelial_stopword(
    term: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let path = storage
        .root()
        .join(".inkycap")
        .join("mycelial-stopwords.txt");
    let Ok(contents) = tokio::fs::read_to_string(&path).await else {
        return Ok(());
    };
    let lowered = term.to_lowercase();
    let kept: Vec<&str> = contents
        .lines()
        .filter(|line| line.trim().to_lowercase() != lowered)
        .collect();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    tokio::fs::write(&path, out).await?;

    let mut corpus = session.corpus_stats.write().await;
    corpus.reload_stopwords(Some(storage.root()));

    Ok(())
}

/// Ensure the user's mycelial stopword file exists and return its path so the
/// frontend can open it for editing. The file is the user-editable layer on
/// top of the built-in stopword lists (one lowercase word per line, `#`
/// comments) — exposing it directly lets the user inspect and prune it without
/// a bespoke editor UI. When absent we create it with a short explanatory
/// header so the first thing the user sees is the format, not a blank file.
#[tauri::command]
pub async fn ensure_mycelial_stopwords_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let stopwords_path = storage
        .root()
        .join(".inkycap")
        .join("mycelial-stopwords.txt");

    if !stopwords_path.exists() {
        if let Some(parent) = stopwords_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let header = "# Mycelial View stopwords\n\
                      #\n\
                      # Words listed here are excluded from emergent-concept and\n\
                      # latent-link detection, in addition to the built-in lists.\n\
                      # One word per line; lines starting with # are ignored.\n\
                      # To rescue a word the built-in lists filter, add it to\n\
                      # .inkycap/dictionary.txt instead.\n\
                      #\n\
                      # Edits take effect the next time the Mycelial View loads.\n";
        tokio::fs::write(&stopwords_path, header).await?;
    }

    Ok(to_frontend_string(&stopwords_path))
}

/// Path of the notebox's under-developed-page exclusion list.
fn hub_exclusions_path(root: &Path) -> PathBuf {
    root.join(".inkycap").join("mycelial-hub-exclusions.txt")
}

/// Read the set of notebox paths the user has hidden from the Growth panel's
/// under-developed-pages list. Each line is one `to_frontend_string`-shaped
/// path — the same shape `WeakHub.path` carries — so membership is a direct
/// string compare. Missing file, blank lines, and `#` comments yield nothing.
async fn load_hub_exclusions(root: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(contents) = tokio::fs::read_to_string(hub_exclusions_path(root)).await {
        for line in contents.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                set.insert(trimmed.to_string());
            }
        }
    }
    set
}

/// Append `value` as its own line to a list file, verbatim (unlike
/// `append_unique_word`, which lowercases — a path must keep its case). Creates
/// the file and parent directory if needed; a no-op when already present.
async fn append_unique_line(path: &Path, value: &str) -> Result<(), InkyCapError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let existing = tokio::fs::read_to_string(path).await.unwrap_or_default();
    if existing.lines().any(|line| line.trim() == value) {
        return Ok(());
    }
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    let line = if existing.ends_with('\n') || existing.is_empty() {
        format!("{value}\n")
    } else {
        format!("\n{value}\n")
    };
    file.write_all(line.as_bytes()).await?;
    Ok(())
}

/// Hide an under-developed page from the Growth panel by adding its notebox
/// path to `.inkycap/mycelial-hub-exclusions.txt`. The exclusion is per-notebox
/// and takes effect the next time the Mycelial View loads. Reversible via
/// `remove_mycelial_hub_exclusion`.
#[tauri::command]
pub async fn exclude_mycelial_hub(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    append_unique_line(&hub_exclusions_path(storage.root()), &path).await?;
    Ok(())
}

/// Ensure the under-developed-page exclusion file exists and return its path so
/// the frontend can open it for editing — the mirror of
/// `ensure_mycelial_stopwords_file`, giving the user a way to review and prune
/// what they've hidden from the Growth panel. Created with an explanatory
/// header (one notebox-relative path per line, `#` comments) on first use.
#[tauri::command]
pub async fn ensure_mycelial_hub_exclusions_file(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let file = hub_exclusions_path(storage.root());

    if !file.exists() {
        if let Some(parent) = file.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let header = "# Mycelial View — hidden under-developed pages\n\
                      #\n\
                      # Notes listed here are omitted from the Growth panel's\n\
                      # under-developed-pages list. One notebox path per line;\n\
                      # lines starting with # are ignored. Remove a line to\n\
                      # show that page again.\n\
                      #\n\
                      # Edits take effect the next time the Mycelial View loads.\n";
        tokio::fs::write(&file, header).await?;
    }

    Ok(to_frontend_string(&file))
}

/// Un-hide a previously excluded under-developed page. No-op if the path isn't
/// listed.
#[tauri::command]
pub async fn remove_mycelial_hub_exclusion(
    path: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let file = hub_exclusions_path(storage.root());
    let Ok(contents) = tokio::fs::read_to_string(&file).await else {
        return Ok(());
    };
    let kept: Vec<&str> = contents
        .lines()
        .filter(|line| line.trim() != path)
        .collect();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    tokio::fs::write(&file, out).await?;
    Ok(())
}
