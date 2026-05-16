//! Mycelial View command — combines the link graph with emergent concept
//! suggestions powered by corpus statistics (TF-IDF + PMI).

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::commands::flow::{bfs_link_graph, FlowEdge, FlowNode};
use crate::corpus_stats::{EmergentConcept, MycelialConfig};
use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::sanitize_notebox_arg;

/// Complete data for the Mycelial View rendering.
#[derive(Debug, Clone, Serialize)]
pub struct MycelialData {
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
    pub center: String,
    pub emergent_concepts: Vec<EmergentConcept>,
}

#[tauri::command]
pub async fn get_mycelial_data(
    path: String,
    max_depth: Option<usize>,
    state: State<'_, AppState>,
) -> Result<MycelialData, InkyCapError> {
    let link_index = state.link_index.read().await;
    let max_depth = max_depth.unwrap_or(2).min(3);
    let center_path = sanitize_notebox_arg(&path)?;

    // 1. BFS to get the link graph (reuses flow.rs helper).
    let (nodes, edges) = bfs_link_graph(&link_index, &center_path, &path, max_depth);
    drop(link_index);

    // 2. Collect neighborhood paths (all notes within max_depth hops).
    let neighborhood_paths: Vec<PathBuf> = nodes
        .iter()
        .map(|n| PathBuf::from(&n.id))
        .collect();

    // 3. Compute emergent concepts from corpus statistics.
    let corpus_stats = state.corpus_stats.read().await;
    let config = MycelialConfig::default();

    // Build set of existing page stems for filtering.
    let existing_page_stems: HashSet<String> = {
        let prop_index = state.property_index.read().await;
        prop_index
            .notes
            .keys()
            .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()))
            .collect()
    };

    let emergent_concepts =
        corpus_stats.top_emergent_concepts(&neighborhood_paths, &existing_page_stems, &config);

    Ok(MycelialData {
        nodes,
        edges,
        center: path,
        emergent_concepts,
    })
}
