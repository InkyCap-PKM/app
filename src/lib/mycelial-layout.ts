/**
 * Mycelial View layout engine.
 *
 * Lays out the **inner growth region** only: the center note, latent-link
 * boxes, emergent-concept boxes, and the source notes that produced a
 * signal. Context notes (wikilink neighbors with no signal) are shown in
 * the right panel as a list, not in the graph.
 *
 * After the force simulation, positions are normalized so the bounding
 * box fits within TARGET_SIZE pixels. Box dimensions are NOT scaled —
 * only positions — so text stays readable at the default zoom level.
 */

import type { FlowNode, FlowEdge, LatentLink, EmergentConcept } from "./types";

export const NOTE_W = 156;
export const NOTE_H = 46;
export const CONCEPT_W = 224;
export const CONCEPT_H = 104;

const SPRING_LENGTH = 330;
const REPULSION = 52000;
const SPRING_K = 0.04;
const DAMPING = 0.82;
const ITERATIONS = 120;
// Centering pull toward the origin, proportional to distance. Without it a
// node with few or no springs is only ever pushed *outward* by repulsion and
// drifts far past the cluster — visible as a lone card stranded off-screen.
// Gravity counteracts that so the graph stays compact, while springs and
// repulsion still set the local arrangement.
const GRAVITY = 0.0016;
const PADDING = 120;
// Soft cap on the laid-out size. Kept generous so the force simulation's
// natural 2-D spread is preserved rather than crushed into a narrow ribbon;
// fit-to-view handles the zoom regardless of absolute size.
const TARGET_SIZE = 4200;
const OVERLAP_MARGIN = 44;

export type BoxKind = "center" | "source" | "latent" | "emergent";
export type ConnectionKind = "anchor" | "latent" | "emergent";

export interface MycelialBox {
  id: string;
  kind: BoxKind;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
  snippet: string;
  sourceLabel: string;
  latent?: LatentLink;
  emergent?: EmergentConcept;
  note?: FlowNode;
}

export interface MycelialConnection {
  kind: ConnectionKind;
  score: number;
  from: string;
  to: string;
}

export interface MycelialLayout {
  boxes: MycelialBox[];
  connections: MycelialConnection[];
  width: number;
  height: number;
}

export function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49271;
  return x - Math.floor(x);
}

interface SimNode {
  id: string;
  kind: BoxKind;
  w: number;
  h: number;
}

export function computeMycelialLayout(
  centerId: string,
  sourceNotes: FlowNode[],
  contextEdges: FlowEdge[],
  latentLinks: LatentLink[],
  emergentConcepts: EmergentConcept[],
): MycelialLayout {
  // ---- 1. Simulation nodes. -----------------------------------------------
  const latentByTarget = new Map<string, LatentLink>();
  for (const l of latentLinks) {
    if (!latentByTarget.has(l.target_path)) latentByTarget.set(l.target_path, l);
  }

  const noteById = new Map<string, FlowNode>();
  for (const n of sourceNotes) noteById.set(n.id, n);

  const sim: SimNode[] = [{ id: centerId, kind: "center", w: NOTE_W, h: NOTE_H }];
  const seen = new Set<string>([centerId]);

  for (const n of sourceNotes) {
    if (seen.has(n.id) || latentByTarget.has(n.id)) continue;
    seen.add(n.id);
    sim.push({ id: n.id, kind: "source", w: NOTE_W, h: NOTE_H });
  }
  for (const l of latentLinks) {
    if (seen.has(l.target_path)) continue;
    seen.add(l.target_path);
    sim.push({ id: l.target_path, kind: "latent", w: CONCEPT_W, h: CONCEPT_H });
  }
  for (const e of emergentConcepts) {
    const id = `emergent:${e.term}`;
    if (seen.has(id)) continue;
    seen.add(id);
    sim.push({ id, kind: "emergent", w: CONCEPT_W, h: CONCEPT_H });
  }
  const simIds = new Set(sim.map((n) => n.id));

  // ---- 2. Spring connections. ---------------------------------------------
  interface Spring { a: string; b: string; kind: ConnectionKind; score: number }
  const springs: Spring[] = [];
  for (const e of contextEdges) {
    if (simIds.has(e.source) && simIds.has(e.target)) {
      springs.push({ a: e.source, b: e.target, kind: "anchor", score: 0.4 });
    }
  }
  for (const l of latentLinks) {
    for (const m of l.mentions) {
      if (simIds.has(m.path) && simIds.has(l.target_path)) {
        springs.push({ a: m.path, b: l.target_path, kind: "latent", score: l.score });
      }
    }
  }
  for (const e of emergentConcepts) {
    const id = `emergent:${e.term}`;
    for (const m of e.mentions) {
      if (simIds.has(m.path)) {
        springs.push({ a: id, b: m.path, kind: "emergent", score: e.score });
      }
    }
  }

  // ---- 3. Force-directed simulation (center pinned at origin). ------------
  const pos = new Map<string, { x: number; y: number }>();
  const vel = new Map<string, { vx: number; vy: number }>();
  pos.set(centerId, { x: 0, y: 0 });
  const others = sim.filter((n) => n.id !== centerId);
  const step = (2 * Math.PI) / Math.max(others.length, 1);
  others.forEach((n, i) => {
    const r = SPRING_LENGTH * (1.0 + seededRandom(hashString(n.id)) * 0.8);
    pos.set(n.id, { x: r * Math.cos(step * i), y: r * Math.sin(step * i) });
  });
  for (const n of sim) vel.set(n.id, { vx: 0, vy: 0 });

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion: use effective radii based on box dimensions, not just distance.
    for (let i = 0; i < sim.length; i++) {
      for (let j = i + 1; j < sim.length; j++) {
        const ni = sim[i], nj = sim[j];
        const a = pos.get(ni.id)!;
        const b = pos.get(nj.id)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const minSep = (ni.w + nj.w) / 2 + OVERLAP_MARGIN;
        const effectiveDist = Math.max(dist, 1);
        let force = REPULSION / (effectiveDist * effectiveDist);
        // Extra push when boxes would actually overlap.
        if (dist < minSep) {
          force += (minSep - dist) * 2.0;
        }
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (ni.id !== centerId) {
          const v = vel.get(ni.id)!;
          v.vx -= fx;
          v.vy -= fy;
        }
        if (nj.id !== centerId) {
          const v = vel.get(nj.id)!;
          v.vx += fx;
          v.vy += fy;
        }
      }
    }
    for (const s of springs) {
      const a = pos.get(s.a);
      const b = pos.get(s.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = SPRING_K * (dist - SPRING_LENGTH);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (s.a !== centerId) {
        const v = vel.get(s.a)!;
        v.vx += fx;
        v.vy += fy;
      }
      if (s.b !== centerId) {
        const v = vel.get(s.b)!;
        v.vx -= fx;
        v.vy -= fy;
      }
    }
    for (const n of sim) {
      if (n.id === centerId) continue;
      const p = pos.get(n.id)!;
      const v = vel.get(n.id)!;
      // Centering pull toward the origin (the pinned anchor note).
      v.vx -= p.x * GRAVITY;
      v.vy -= p.y * GRAVITY;
      v.vx *= DAMPING;
      v.vy *= DAMPING;
      p.x += v.vx;
      p.y += v.vy;
    }
  }

  // Resolve remaining rectangle overlaps by iteratively pushing pairs apart.
  // Defined here but invoked AFTER normalization (step 4): normalization
  // scales positions toward the centroid *without* scaling box sizes, so
  // running this before normalization lets the scale-down silently
  // re-introduce the very overlaps it had cleared.
  // Boxes are pushed apart *along the line between their centres* (radial),
  // not along the cheaper axis. An axis push always separates wide-and-short
  // boxes vertically — the cheaper direction — which collapses a dense graph
  // into a tall ribbon. A radial push preserves the angular arrangement the
  // force simulation produced, so the graph keeps its 2-D spread.
  const resolveOverlaps = () => {
    for (let pass = 0; pass < 40; pass++) {
      let anyOverlap = false;
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const ni = sim[i], nj = sim[j];
          const pi = pos.get(ni.id)!;
          const pj = pos.get(nj.id)!;
          const reqX = (ni.w + nj.w) / 2 + OVERLAP_MARGIN;
          const reqY = (ni.h + nj.h) / 2 + OVERLAP_MARGIN;
          const dx = pj.x - pi.x;
          const dy = pj.y - pi.y;
          if (Math.abs(dx) >= reqX || Math.abs(dy) >= reqY) continue;
          anyOverlap = true;
          // Direction between centres; coincident boxes get a deterministic
          // horizontal nudge.
          let ux = dx, uy = dy;
          if (ux === 0 && uy === 0) ux = 1;
          // Scale the vector so the boxes just clear on the nearer axis,
          // with a small over-clear so the pass converges.
          const tX = ux !== 0 ? reqX / Math.abs(ux) : Infinity;
          const tY = uy !== 0 ? reqY / Math.abs(uy) : Infinity;
          const t = Math.min(tX, tY) * 1.04;
          const moveX = (ux * t - dx) / 2;
          const moveY = (uy * t - dy) / 2;
          const movableI = ni.id !== centerId;
          const movableJ = nj.id !== centerId;
          if (movableI && movableJ) {
            pi.x -= moveX; pi.y -= moveY;
            pj.x += moveX; pj.y += moveY;
          } else if (movableJ) {
            pj.x += moveX * 2; pj.y += moveY * 2;
          } else if (movableI) {
            pi.x -= moveX * 2; pi.y -= moveY * 2;
          }
        }
      }
      if (!anyOverlap) break;
    }
  };

  // ---- 4. Normalize positions to fit within TARGET_SIZE. ------------------
  let rawMinX = Infinity, rawMinY = Infinity, rawMaxX = -Infinity, rawMaxY = -Infinity;
  for (const n of sim) {
    const p = pos.get(n.id)!;
    rawMinX = Math.min(rawMinX, p.x - n.w / 2);
    rawMinY = Math.min(rawMinY, p.y - n.h / 2);
    rawMaxX = Math.max(rawMaxX, p.x + n.w / 2);
    rawMaxY = Math.max(rawMaxY, p.y + n.h / 2);
  }
  const rawSize = Math.max(rawMaxX - rawMinX, rawMaxY - rawMinY);

  if (rawSize > TARGET_SIZE) {
    const centroidX = sim.reduce((s, n) => s + pos.get(n.id)!.x, 0) / sim.length;
    const centroidY = sim.reduce((s, n) => s + pos.get(n.id)!.y, 0) / sim.length;
    const posScale = TARGET_SIZE / rawSize;
    for (const n of sim) {
      const p = pos.get(n.id)!;
      p.x = centroidX + (p.x - centroidX) * posScale;
      p.y = centroidY + (p.y - centroidY) * posScale;
    }
  }

  // Clear overlaps the scale-down may have introduced. This can push the
  // bounding box back above TARGET_SIZE — that is the correct trade: fixed-
  // size boxes cannot be packed below a minimum area, and a slightly larger
  // graph is better than unreadable overlapping cards.
  resolveOverlaps();

  // ---- 5. Shift to positive coordinates. ----------------------------------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of sim) {
    const p = pos.get(n.id)!;
    minX = Math.min(minX, p.x - n.w / 2);
    minY = Math.min(minY, p.y - n.h / 2);
    maxX = Math.max(maxX, p.x + n.w / 2);
    maxY = Math.max(maxY, p.y + n.h / 2);
  }
  const offX = -minX + PADDING;
  const offY = -minY + PADDING;

  // ---- 6. Build boxes. ----------------------------------------------------
  const boxes: MycelialBox[] = sim.map((n) => {
    const p = pos.get(n.id)!;
    const base: MycelialBox = {
      id: n.id,
      kind: n.kind,
      x: p.x + offX - n.w / 2,
      y: p.y + offY - n.h / 2,
      w: n.w,
      h: n.h,
      title: "",
      subtitle: "",
      snippet: "",
      sourceLabel: "",
    };
    if (n.kind === "latent") {
      const l = latentByTarget.get(n.id)!;
      const top = l.mentions[0];
      return {
        ...base,
        title: l.target_name,
        subtitle: "Latent link",
        snippet: top ? top.snippet : "",
        sourceLabel: `mentioned in ${l.mentions.length} note${l.mentions.length > 1 ? "s" : ""}`,
        latent: l,
      };
    }
    if (n.kind === "emergent") {
      const e = emergentConcepts.find((c) => `emergent:${c.term}` === n.id)!;
      const top = e.mentions[0];
      return {
        ...base,
        title: e.term,
        subtitle: "Potential page",
        snippet: top ? top.snippet : "",
        sourceLabel: `emerged from ${e.mentions.length} note${e.mentions.length > 1 ? "s" : ""}`,
        emergent: e,
      };
    }
    const note = noteById.get(n.id);
    return {
      ...base,
      title: note?.name ?? n.id.replace(/\.typ$/, "").split("/").pop() ?? n.id,
      note,
    };
  });
  const boxById = new Map(boxes.map((b) => [b.id, b]));

  // ---- 7. Connections. ----------------------------------------------------
  const connections: MycelialConnection[] = [];
  const seenConn = new Set<string>();
  const addConn = (kind: ConnectionKind, score: number, from: string, to: string) => {
    if (!boxById.has(from) || !boxById.has(to) || from === to) return;
    const key = `${kind}:${from}:${to}`;
    if (seenConn.has(key)) return;
    seenConn.add(key);
    connections.push({ kind, score, from, to });
  };
  for (const s of springs) addConn(s.kind, s.score, s.a, s.b);

  return {
    boxes,
    connections,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  };
}
