// Layered tree layout algorithm for the Flow View.
// Positions nodes in layers: backlinks on the left, center in the middle, forward links on the right.

import type { FlowNode, FlowEdge } from "./types";

export interface LayoutNode {
  id: string;
  name: string;
  x: number;
  y: number;
  depth: number;
  direction: string;
}

export interface LayoutEdge {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  source: string;
  target: string;
}

export interface FlowLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 36;
const HORIZONTAL_GAP = 200;
const VERTICAL_GAP = 50;
const PADDING = 60;

/**
 * Compute layout positions for flow view nodes and edges.
 * Backlinks go left of center, forward links go right.
 */
export function computeFlowLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowLayout {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const nodeMap = new Map<string, FlowNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  // Group nodes by direction and depth
  const center = nodes.filter((n) => n.direction === "center");
  const backlinks = nodes.filter((n) => n.direction === "backlink");
  const forward = nodes.filter((n) => n.direction === "forward");

  // Group by depth within each direction
  const backlinksByDepth = groupByDepth(backlinks);
  const forwardByDepth = groupByDepth(forward);

  // Compute max depth on each side
  const maxBacklinkDepth = Math.max(0, ...backlinks.map((n) => n.depth));
  const maxForwardDepth = Math.max(0, ...forward.map((n) => n.depth));

  // Center X position
  const centerX = PADDING + maxBacklinkDepth * HORIZONTAL_GAP;

  // Position nodes
  const layoutNodes: LayoutNode[] = [];
  const nodePositions = new Map<string, { x: number; y: number }>();

  // Position center node
  for (const n of center) {
    const pos = { x: centerX, y: 0 }; // y will be adjusted later
    nodePositions.set(n.id, pos);
    layoutNodes.push({ ...n, ...pos });
  }

  // Position backlinks (left of center, deeper = further left)
  let maxBacklinkY = 0;
  for (let depth = 1; depth <= maxBacklinkDepth; depth++) {
    const group = backlinksByDepth.get(depth) || [];
    const x = centerX - depth * HORIZONTAL_GAP;
    for (let i = 0; i < group.length; i++) {
      const y = i * (NODE_HEIGHT + VERTICAL_GAP);
      nodePositions.set(group[i].id, { x, y });
      layoutNodes.push({ ...group[i], x, y });
      maxBacklinkY = Math.max(maxBacklinkY, y);
    }
  }

  // Position forward links (right of center, deeper = further right)
  let maxForwardY = 0;
  for (let depth = 1; depth <= maxForwardDepth; depth++) {
    const group = forwardByDepth.get(depth) || [];
    const x = centerX + depth * HORIZONTAL_GAP;
    for (let i = 0; i < group.length; i++) {
      const y = i * (NODE_HEIGHT + VERTICAL_GAP);
      nodePositions.set(group[i].id, { x, y });
      layoutNodes.push({ ...group[i], x, y });
      maxForwardY = Math.max(maxForwardY, y);
    }
  }

  // Center the center node vertically relative to the tallest side
  const maxSideY = Math.max(maxBacklinkY, maxForwardY);
  const centerNode = layoutNodes.find((n) => n.direction === "center");
  if (centerNode) {
    centerNode.y = maxSideY / 2;
    nodePositions.set(centerNode.id, {
      x: centerNode.x,
      y: centerNode.y,
    });
  }

  // Compute edges with positions
  const layoutEdges: LayoutEdge[] = [];
  for (const edge of edges) {
    const sourcePos = nodePositions.get(edge.source);
    const targetPos = nodePositions.get(edge.target);
    if (sourcePos && targetPos) {
      layoutEdges.push({
        sourceX: sourcePos.x + NODE_WIDTH / 2,
        sourceY: sourcePos.y + NODE_HEIGHT / 2,
        targetX: targetPos.x + NODE_WIDTH / 2,
        targetY: targetPos.y + NODE_HEIGHT / 2,
        source: edge.source,
        target: edge.target,
      });
    }
  }

  // Compute total dimensions
  const allX = layoutNodes.map((n) => n.x);
  const allY = layoutNodes.map((n) => n.y);
  const width =
    Math.max(...allX) - Math.min(...allX) + NODE_WIDTH + PADDING * 2;
  const height =
    Math.max(...allY) - Math.min(...allY) + NODE_HEIGHT + PADDING * 2;

  // Normalize positions so minimum is at PADDING
  const minX = Math.min(...allX);
  const minY = Math.min(...allY);
  const offsetX = PADDING - minX;
  const offsetY = PADDING - minY;

  for (const node of layoutNodes) {
    node.x += offsetX;
    node.y += offsetY;
  }
  for (const edge of layoutEdges) {
    edge.sourceX += offsetX;
    edge.sourceY += offsetY;
    edge.targetX += offsetX;
    edge.targetY += offsetY;
  }

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: Math.max(width, 400),
    height: Math.max(height, 200),
  };
}

function groupByDepth(nodes: FlowNode[]): Map<number, FlowNode[]> {
  const groups = new Map<number, FlowNode[]>();
  for (const n of nodes) {
    const group = groups.get(n.depth) || [];
    group.push(n);
    groups.set(n.depth, group);
  }
  return groups;
}

export { NODE_WIDTH, NODE_HEIGHT };
