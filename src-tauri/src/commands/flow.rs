use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::link_index::LinkIndex;
use crate::storage::to_frontend_string;

/// A node in the link graph (used by the Mycelial View for BFS neighborhood seeding).
#[derive(Debug, Clone, Serialize)]
pub struct FlowNode {
    pub id: String,
    pub name: String,
    pub depth: usize,
    pub direction: String,
}

/// An edge in the link graph.
#[derive(Debug, Clone, Serialize)]
pub struct FlowEdge {
    pub source: String,
    pub target: String,
}

/// BFS traversal of the link graph from a center note.
/// Returns (nodes, edges) for rendering.
pub fn bfs_link_graph(
    link_index: &LinkIndex,
    center_path: &Path,
    center_id: &str,
    max_depth: usize,
) -> (Vec<FlowNode>, Vec<FlowEdge>) {
    let mut nodes: Vec<FlowNode> = Vec::new();
    let mut edges: Vec<FlowEdge> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();

    let center_name = center_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    nodes.push(FlowNode {
        id: center_id.to_owned(),
        name: center_name,
        depth: 0,
        direction: "center".to_string(),
    });
    visited.insert(center_id.to_owned());

    // BFS for backlinks
    let mut backlink_frontier: Vec<(PathBuf, usize)> = vec![(center_path.to_path_buf(), 0)];
    while let Some((current, depth)) = backlink_frontier.pop() {
        if depth >= max_depth {
            continue;
        }
        let backlinks = link_index.get_backlinks(&current);
        for bl in backlinks {
            let bl_str = to_frontend_string(&bl);
            edges.push(FlowEdge {
                source: bl_str.clone(),
                target: to_frontend_string(&current),
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
    let mut forward_frontier: Vec<(PathBuf, usize)> = vec![(center_path.to_path_buf(), 0)];
    while let Some((current, depth)) = forward_frontier.pop() {
        if depth >= max_depth {
            continue;
        }
        let forward = link_index.get_forward_links(&current);
        for fl in forward {
            let fl_str = to_frontend_string(&fl);
            edges.push(FlowEdge {
                source: to_frontend_string(&current),
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

    (nodes, edges)
}

