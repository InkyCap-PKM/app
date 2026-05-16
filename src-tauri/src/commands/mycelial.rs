//! Mycelial View command.
//!
//! The Mycelial View is not a link-graph browser — backlinks and forward
//! links are deliberately *not* the point. It surfaces where a notebox wants
//! to grow next, via two signals computed over a note's neighborhood:
//!
//! - **Latent links** — an existing page is mentioned in other notes as plain
//!   text, with no wikilink. Clicking one lets the user go connect them.
//! - **Emergent concepts** — a recurring term/phrase with no page of its own,
//!   representing knowledge the user has developed implicitly. Clicking one
//!   creates a new page seeded with the connections it emerged from.
//!
//! The neighborhood those signals are computed over is **not** just the link
//! graph: it is the link graph *unioned with the most semantically similar
//! notes*, so a sparsely-linked note still surfaces concepts that emerge from
//! its thematic context rather than degrading into single-note keywords.
//!
//! Notes split into two visual roles: **source notes** (provenance — a note a
//! signal emerged from) and **context notes** (existing wikilink neighbors
//! that surface no signal — kept as a faint outer horizon for orientation).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::flow::{bfs_link_graph, FlowEdge, FlowNode};
use crate::corpus_stats::MycelialConfig;
use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::local::LocalNoteboxStorage;
use crate::storage::sanitize_notebox_arg;
use crate::storage::traits::NoteboxStorage;

/// Maximum characters in a context snippet shown inside a mycelial box.
const SNIPPET_MAX_CHARS: usize = 160;
/// Maximum mention sites kept per latent link / emergent concept.
const MAX_MENTIONS: usize = 8;

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

/// Complete data for the Mycelial View rendering.
#[derive(Debug, Clone, Serialize)]
pub struct MycelialData {
    pub center: String,
    /// Notes a signal emerged from — rendered as inner provenance nodes.
    pub source_notes: Vec<FlowNode>,
    /// Existing wikilink neighbors that surfaced no signal — rendered as a
    /// faint outer horizon ring for spatial orientation.
    pub context_notes: Vec<FlowNode>,
    /// Wikilinks among center / source / context notes — faint context.
    pub context_edges: Vec<FlowEdge>,
    pub latent_links: Vec<LatentLink>,
    pub emergent_concepts: Vec<EmergentConcept>,
}

#[tauri::command]
pub async fn get_mycelial_data(
    path: String,
    max_depth: Option<usize>,
    state: State<'_, AppState>,
) -> Result<MycelialData, InkyCapError> {
    let max_depth = max_depth.unwrap_or(2).min(3);
    let center_path = sanitize_notebox_arg(&path)?;
    let config = MycelialConfig::default();

    // 1. BFS the link graph — these are the notebox's explicit connections.
    let (link_nodes, link_edges) = {
        let link_index = state.link_index.read().await;
        bfs_link_graph(&link_index, &center_path, &path, max_depth)
    };

    // 2. Map every existing page stem -> its path, so corpus analysis can tell
    //    a latent link (page exists) from an emergent concept (no page).
    let existing_pages: HashMap<String, String> = {
        let prop_index = state.property_index.read().await;
        prop_index
            .notes
            .keys()
            .filter_map(|p| {
                p.file_stem()
                    .map(|s| (s.to_string_lossy().to_lowercase(), p.display().to_string()))
            })
            .collect()
    };

    // 3. Build the analysis neighborhood: the link graph widened with the
    //    most semantically similar notes. The link graph alone collapses to
    //    a single note for unlinked notes; similarity gives it real context.
    let (analysis, link_node_ids) = {
        let corpus_stats = state.corpus_stats.read().await;
        let center_id = PathBuf::from(&path);
        let mut neighborhood: HashSet<PathBuf> =
            link_nodes.iter().map(|n| PathBuf::from(&n.id)).collect();
        neighborhood.insert(center_id.clone());
        for p in corpus_stats.similar_docs(&center_id, config.semantic_neighbors) {
            neighborhood.insert(p);
        }
        let neighborhood: Vec<PathBuf> = neighborhood.into_iter().collect();
        let link_node_ids: HashSet<String> =
            link_nodes.iter().map(|n| n.id.clone()).collect();
        (
            corpus_stats.analyze_neighborhood(&neighborhood, &existing_pages, &config),
            link_node_ids,
        )
    };

    let storage = state.get_storage().await?;

    // 4. Latent links: keep only notes that mention the target without a
    //    wikilink to it, and resolve the mention's location for deep-linking.
    let mut latent_links: Vec<LatentLink> = Vec::new();
    {
        let link_index = state.link_index.read().await;
        for cand in analysis.latent {
            let target = PathBuf::from(&cand.target_path);
            let mut mentions: Vec<SourceMention> = Vec::new();
            for src in &cand.source_notes {
                let src_path = PathBuf::from(src);
                if src_path == target {
                    continue;
                }
                if link_index
                    .get_forward_links(&src_path)
                    .iter()
                    .any(|f| f == &target)
                {
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
            latent_links.push(LatentLink {
                term: cand.term,
                target_name: stem_name(&target),
                target_path: cand.target_path,
                score: cand.score,
                is_bigram: cand.is_bigram,
                mentions,
            });
        }
    }
    latent_links.truncate(config.top_k);

    // 5. Emergent concepts: resolve a context snippet for each source note.
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

    // 6. Partition notes into provenance (source) and orientation (context).
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
    source_ids.remove(&path);

    let source_notes: Vec<FlowNode> = source_ids
        .iter()
        .map(|p| flow_node(p, &path))
        .collect();

    let context_notes: Vec<FlowNode> = link_node_ids
        .iter()
        .filter(|id| {
            **id != path
                && !source_ids.contains(*id)
                && !latent_targets.contains(*id)
        })
        .map(|p| flow_node(p, &path))
        .collect();

    // Faint wikilinks among the rendered notes (excludes latent targets,
    // whose connections are shown as the latent links themselves).
    let rendered: HashSet<&String> = std::iter::once(&path)
        .chain(source_ids.iter())
        .chain(context_notes.iter().map(|n| &n.id))
        .collect();
    let context_edges: Vec<FlowEdge> = link_edges
        .into_iter()
        .filter(|e| rendered.contains(&e.source) && rendered.contains(&e.target))
        .collect();

    Ok(MycelialData {
        center: path,
        source_notes,
        context_notes,
        context_edges,
        latent_links,
        emergent_concepts,
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
            path: path.display().to_string(),
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
