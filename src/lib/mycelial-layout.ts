/**
 * Mycelial View layout engine.
 *
 * Positions note nodes using a simple force-directed simulation, then places
 * emergent-concept tendrils at the periphery extending outward from their
 * source-note cluster.
 */

import type { FlowNode, FlowEdge, EmergentConcept } from "./types";

// Layout constants
const NODE_WIDTH = 140;
const NODE_HEIGHT = 34;
const SPRING_LENGTH = 180;
const REPULSION = 8000;
const SPRING_K = 0.05;
const DAMPING = 0.85;
const ITERATIONS = 60;
const PADDING = 80;
const TENDRIL_BASE_LENGTH = 70;
const TENDRIL_MAX_LENGTH = 150;

export interface LayoutNode {
  id: string;
  name: string;
  depth: number;
  direction: string;
  x: number;
  y: number;
}

export interface LayoutEdge {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  path: string;
}

export interface TendrilLayout {
  term: string;
  score: number;
  isBigram: boolean;
  sourceNotes: string[];
  docCount: number;
  path: string;
  labelX: number;
  labelY: number;
  endX: number;
  endY: number;
}

export interface MycelialLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  tendrils: TendrilLayout[];
  width: number;
  height: number;
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49271;
  return x - Math.floor(x);
}

export function computeMycelialLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
  concepts: EmergentConcept[],
): MycelialLayout {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], tendrils: [], width: 200, height: 200 };
  }

  // Initialize positions: center at origin, others in a circle by depth
  const positions: Map<string, { x: number; y: number }> = new Map();
  const centerNode = nodes.find((n) => n.direction === "center");
  const centerId = centerNode?.id ?? nodes[0].id;

  positions.set(centerId, { x: 0, y: 0 });

  const nonCenter = nodes.filter((n) => n.id !== centerId);
  const angleStep = (2 * Math.PI) / Math.max(nonCenter.length, 1);
  nonCenter.forEach((node, i) => {
    const angle = angleStep * i;
    const radius = SPRING_LENGTH * node.depth;
    positions.set(node.id, {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    });
  });

  // Build adjacency for spring forces
  const adjacency: Map<string, Set<string>> = new Map();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  // Force-directed simulation
  const velocities: Map<string, { vx: number; vy: number }> = new Map();
  for (const node of nodes) {
    velocities.set(node.id, { vx: 0, vy: 0 });
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion between all node pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (nodes[i].id !== centerId) {
          const va = velocities.get(nodes[i].id)!;
          va.vx -= fx;
          va.vy -= fy;
        }
        if (nodes[j].id !== centerId) {
          const vb = velocities.get(nodes[j].id)!;
          vb.vx += fx;
          vb.vy += fy;
        }
      }
    }

    // Spring attraction along edges
    for (const edge of edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const displacement = dist - SPRING_LENGTH;
      const force = SPRING_K * displacement;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (edge.source !== centerId) {
        const va = velocities.get(edge.source)!;
        va.vx += fx;
        va.vy += fy;
      }
      if (edge.target !== centerId) {
        const vb = velocities.get(edge.target)!;
        vb.vx -= fx;
        vb.vy -= fy;
      }
    }

    // Apply velocities with damping
    for (const node of nodes) {
      if (node.id === centerId) continue;
      const pos = positions.get(node.id)!;
      const vel = velocities.get(node.id)!;
      vel.vx *= DAMPING;
      vel.vy *= DAMPING;
      pos.x += vel.vx;
      pos.y += vel.vy;
    }
  }

  // Normalize positions to positive space with padding
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pos of positions.values()) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x);
    maxY = Math.max(maxY, pos.y);
  }

  // Reserve extra space for tendrils at the periphery
  const tendrilMargin = concepts.length > 0 ? TENDRIL_MAX_LENGTH + 60 : 0;

  const offsetX = -minX + PADDING + tendrilMargin;
  const offsetY = -minY + PADDING + tendrilMargin;

  const layoutNodes: LayoutNode[] = nodes.map((node) => {
    const pos = positions.get(node.id)!;
    return {
      id: node.id,
      name: node.name,
      depth: node.depth,
      direction: node.direction,
      x: pos.x + offsetX,
      y: pos.y + offsetY,
    };
  });

  // Build edge paths (cubic bezier)
  const layoutEdges: LayoutEdge[] = edges
    .map((edge) => {
      const srcNode = layoutNodes.find((n) => n.id === edge.source);
      const tgtNode = layoutNodes.find((n) => n.id === edge.target);
      if (!srcNode || !tgtNode) return null;
      const sx = srcNode.x + NODE_WIDTH / 2;
      const sy = srcNode.y + NODE_HEIGHT / 2;
      const tx = tgtNode.x + NODE_WIDTH / 2;
      const ty = tgtNode.y + NODE_HEIGHT / 2;
      const dx = tx - sx;
      const dy = ty - sy;
      const ctrl = Math.max(Math.abs(dx), Math.abs(dy)) * 0.3;
      const path = `M ${sx} ${sy} C ${sx + ctrl * Math.sign(dx)} ${sy}, ${tx - ctrl * Math.sign(dx)} ${ty}, ${tx} ${ty}`;
      return { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, path };
    })
    .filter((e): e is LayoutEdge => e !== null);

  // Place tendrils
  const tendrils: TendrilLayout[] = concepts.map((concept, i) => {
    // Find centroid of source notes in the layout
    const sourceNodes = layoutNodes.filter((n) =>
      concept.source_notes.includes(n.id),
    );
    let cx: number, cy: number;
    if (sourceNodes.length > 0) {
      cx =
        sourceNodes.reduce((sum, n) => sum + n.x + NODE_WIDTH / 2, 0) /
        sourceNodes.length;
      cy =
        sourceNodes.reduce((sum, n) => sum + n.y + NODE_HEIGHT / 2, 0) /
        sourceNodes.length;
    } else {
      // Fallback: use center node
      const center = layoutNodes.find((n) => n.direction === "center")!;
      cx = center.x + NODE_WIDTH / 2;
      cy = center.y + NODE_HEIGHT / 2;
    }

    // Compute angle outward from graph center
    const graphCenterX = layoutNodes[0].x + NODE_WIDTH / 2;
    const graphCenterY = layoutNodes[0].y + NODE_HEIGHT / 2;
    let angle = Math.atan2(cy - graphCenterY, cx - graphCenterX);

    // Add angular spacing between tendrils to avoid overlap
    const seed = hashString(concept.term);
    const jitter = (seededRandom(seed) - 0.5) * 0.4;
    angle += jitter + (i * 0.15);

    const length =
      TENDRIL_BASE_LENGTH + concept.score * (TENDRIL_MAX_LENGTH - TENDRIL_BASE_LENGTH);

    // Start point: edge of source cluster
    const startX = cx + Math.cos(angle) * 30;
    const startY = cy + Math.sin(angle) * 30;

    // End point
    const endX = startX + Math.cos(angle) * length;
    const endY = startY + Math.sin(angle) * length;

    // Control points for organic curve
    const perpAngle = angle + Math.PI / 2;
    const curvature = (seededRandom(seed + 1) - 0.5) * 25;
    const cp1X = startX + Math.cos(angle) * length * 0.35 + Math.cos(perpAngle) * curvature;
    const cp1Y = startY + Math.sin(angle) * length * 0.35 + Math.sin(perpAngle) * curvature;
    const cp2X = startX + Math.cos(angle) * length * 0.7 - Math.cos(perpAngle) * curvature * 0.5;
    const cp2Y = startY + Math.sin(angle) * length * 0.7 - Math.sin(perpAngle) * curvature * 0.5;

    const path = `M ${startX} ${startY} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${endX} ${endY}`;

    return {
      term: concept.term,
      score: concept.score,
      isBigram: concept.is_bigram,
      sourceNotes: concept.source_notes,
      docCount: concept.doc_count,
      path,
      labelX: endX,
      labelY: endY,
      endX,
      endY,
    };
  });

  // Compute final canvas dimensions
  const allX = [
    ...layoutNodes.map((n) => n.x + NODE_WIDTH),
    ...tendrils.map((t) => t.endX + 80),
  ];
  const allY = [
    ...layoutNodes.map((n) => n.y + NODE_HEIGHT),
    ...tendrils.map((t) => t.endY + 30),
  ];
  const width = Math.max(...allX, 400) + PADDING;
  const height = Math.max(...allY, 300) + PADDING;

  return { nodes: layoutNodes, edges: layoutEdges, tendrils, width, height };
}
