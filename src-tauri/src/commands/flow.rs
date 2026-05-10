use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::storage::sanitize_vault_arg;

/// A node in the flow view graph.
#[derive(Debug, Clone, Serialize)]
pub struct FlowNode {
    /// Unique node ID (file path).
    pub id: String,
    /// Display name (filename without extension).
    pub name: String,
    /// Depth from center (0 = center, 1 = direct link, 2 = second degree, etc.).
    pub depth: usize,
    /// "center", "backlink", or "forward"
    pub direction: String,
}

/// An edge in the flow view graph.
#[derive(Debug, Clone, Serialize)]
pub struct FlowEdge {
    pub source: String,
    pub target: String,
}

/// Complete flow view data for SVG rendering.
#[derive(Debug, Clone, Serialize)]
pub struct FlowData {
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
    pub center: String,
}

/// Get the flow graph data for a note, expanding up to `max_depth` levels.
#[tauri::command]
pub async fn get_flow_data(
    path: String,
    max_depth: Option<usize>,
    state: State<'_, AppState>,
) -> Result<FlowData, InkyCapError> {
    let link_index = state.link_index.read().await;

    let max_depth = max_depth.unwrap_or(2).min(3);
    let center_path = sanitize_vault_arg(&path)?;

    let mut nodes: Vec<FlowNode> = Vec::new();
    let mut edges: Vec<FlowEdge> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();

    // Add center node
    let center_name = center_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    nodes.push(FlowNode {
        id: path.clone(),
        name: center_name,
        depth: 0,
        direction: "center".to_string(),
    });
    visited.insert(path.clone());

    // BFS for backlinks
    let mut backlink_frontier: Vec<(PathBuf, usize)> = vec![(center_path.clone(), 0)];
    while let Some((current, depth)) = backlink_frontier.pop() {
        if depth >= max_depth {
            continue;
        }
        let backlinks = link_index.get_backlinks(&current);
        for bl in backlinks {
            let bl_str = bl.display().to_string();
            // Add edge regardless of whether node is new
            edges.push(FlowEdge {
                source: bl_str.clone(),
                target: current.display().to_string(),
            });

            if !visited.contains(&bl_str) {
                visited.insert(bl_str.clone());
                let name = bl
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                nodes.push(FlowNode {
                    id: bl_str.clone(),
                    name,
                    depth: depth + 1,
                    direction: "backlink".to_string(),
                });
                backlink_frontier.push((bl, depth + 1));
            }
        }
    }

    // BFS for forward links
    let mut forward_frontier: Vec<(PathBuf, usize)> = vec![(center_path.clone(), 0)];
    while let Some((current, depth)) = forward_frontier.pop() {
        if depth >= max_depth {
            continue;
        }
        let forward = link_index.get_forward_links(&current);
        for fl in forward {
            let fl_str = fl.display().to_string();
            edges.push(FlowEdge {
                source: current.display().to_string(),
                target: fl_str.clone(),
            });

            if !visited.contains(&fl_str) {
                visited.insert(fl_str.clone());
                let name = fl
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                nodes.push(FlowNode {
                    id: fl_str.clone(),
                    name,
                    depth: depth + 1,
                    direction: "forward".to_string(),
                });
                forward_frontier.push((fl, depth + 1));
            }
        }
    }

    Ok(FlowData {
        nodes,
        edges,
        center: path,
    })
}
