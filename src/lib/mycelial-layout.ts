/**
 * Mycelial View layout: the centre note, latent-link and emergent-concept
 * boxes, and the source notes they came from. Context notes are listed in the
 * right panel, not drawn. After the force simulation, positions (not box sizes)
 * are scaled to fit TARGET_SIZE, so text stays readable at the default zoom.
 */

import type {
  FlowNode,
  FlowEdge,
  LatentLink,
  EmergentConcept,
  KindredNote,
} from "./types";
import { t, tPlural } from "./i18n";

export const NOTE_W = 156;
export const NOTE_H = 46;
export const CONCEPT_W = 224;
export const CONCEPT_H = 104;
export const KINDRED_H = 84;

const SPRING_LENGTH = 330;
const REPULSION = 52000;
const SPRING_K = 0.04;
const DAMPING = 0.82;
const ITERATIONS = 120;
// Pull towards the origin, proportional to distance. Without it a node with few
// springs is only pushed outward and drifts off; springs and repulsion still
// shape the local arrangement.
const GRAVITY = 0.0016;
const PADDING = 120;
// Soft limit on the layout size, generous so the 2-D spread isn't squeezed into
// a ribbon; fit-to-view handles zoom.
const TARGET_SIZE = 4200;
const OVERLAP_MARGIN = 44;
// Longest an edge may be after the simulation; longer ones are pulled in by
// `compactLongEdges`.
const MAX_EDGE = SPRING_LENGTH * 2.2;

export type BoxKind = "center" | "source" | "latent" | "emergent" | "kindred";
export type ConnectionKind = "anchor" | "latent" | "emergent" | "kindred";

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
  kindred?: KindredNote;
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
  kindredNotes: KindredNote[] = [],
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
  const kindredByPath = new Map<string, KindredNote>();
  for (const k of kindredNotes) {
    if (seen.has(k.path)) continue;
    seen.add(k.path);
    kindredByPath.set(k.path, k);
    sim.push({ id: k.path, kind: "kindred", w: CONCEPT_W, h: KINDRED_H });
  }
  const simIds = new Set(sim.map((n) => n.id));

  // ---- 2. Spring connections. ---------------------------------------------
  interface Spring {
    a: string;
    b: string;
    kind: ConnectionKind;
    score: number;
    /**
     * An invisible spring pulling a disconnected component towards the anchor.
     * It shapes the layout but isn't drawn.
     */
    tether?: boolean;
  }
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
  // A kindred note's message is its (missing) relationship to the anchor, so
  // its one edge runs straight to the center.
  for (const k of kindredNotes) {
    if (simIds.has(k.path)) {
      springs.push({ a: centerId, b: k.path, kind: "kindred", score: k.similarity });
    }
  }

  // ---- 2b. Tether disconnected components to the anchor. -----------------
  // A concept whose source notes never reach the anchor forms an island with no
  // spring back, feels only gravity and repulsion, and drifts far away, forcing
  // fit-to-view to shrink everything. So each component without the anchor gets
  // one invisible tether from the anchor to one of its nodes.
  {
    const parent = new Map<string, string>();
    for (const n of sim) parent.set(n.id, n.id);
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      while (parent.get(x) !== root) {
        const next = parent.get(x)!;
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const s of springs) union(s.a, s.b);
    const centerRoot = find(centerId);
    const tethered = new Set<string>();
    for (const n of sim) {
      if (n.id === centerId) continue;
      const root = find(n.id);
      if (root === centerRoot || tethered.has(root)) continue;
      tethered.add(root);
      springs.push({
        a: centerId,
        b: n.id,
        kind: "anchor",
        score: 0,
        tether: true,
      });
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

  // ---- 3b. Cap very long edges. ---------------------------------------
  // A node held by one weak spring can end up far from its cluster, pushed by
  // the combined repulsion faster than the spring can pull it back. Here
  // MAX_EDGE becomes a hard limit: each longer spring's ends are pulled
  // together (only the far end for the pinned anchor, otherwise both). A few
  // passes let nodes with several long edges settle. resolveOverlaps cleans up
  // any overlaps this makes.
  const compactLongEdges = () => {
    for (let pass = 0; pass < 30; pass++) {
      let anyLong = false;
      for (const s of springs) {
        const a = pos.get(s.a);
        const b = pos.get(s.b);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= MAX_EDGE) continue;
        anyLong = true;
        const excess = dist - MAX_EDGE;
        const ux = dx / dist;
        const uy = dy / dist;
        const movableA = s.a !== centerId;
        const movableB = s.b !== centerId;
        if (movableA && movableB) {
          a.x += (ux * excess) / 2;
          a.y += (uy * excess) / 2;
          b.x -= (ux * excess) / 2;
          b.y -= (uy * excess) / 2;
        } else if (movableB) {
          b.x -= ux * excess;
          b.y -= uy * excess;
        } else if (movableA) {
          a.x += ux * excess;
          a.y += uy * excess;
        }
      }
      if (!anyLong) break;
    }
  };
  compactLongEdges();

  // Push overlapping boxes apart. Run after normalization (step 4), which moves
  // positions without scaling boxes and would bring overlaps back. Boxes move
  // along the line between their centres rather than the cheaper axis, which
  // would stack wide boxes into a tall ribbon; this keeps the simulation's 2-D
  // arrangement.
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

  // Clear overlaps from the scale-down. This may grow the layout past
  // TARGET_SIZE again, which is better than overlapping boxes.
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
        subtitle: t("mycelial.legend.latent"),
        snippet: top ? top.snippet : "",
        sourceLabel: tPlural("mycelial.node.mentionedIn", l.mentions.length),
        latent: l,
      };
    }
    if (n.kind === "kindred") {
      const k = kindredByPath.get(n.id)!;
      return {
        ...base,
        title: k.name,
        subtitle: t("mycelial.node.kindredSubtitle"),
        snippet: k.shared_terms.join(" · "),
        sourceLabel: t("mycelial.node.similarity", {
          pct: String(Math.round(k.similarity * 100)),
        }),
        kindred: k,
      };
    }
    if (n.kind === "emergent") {
      const e = emergentConcepts.find((c) => `emergent:${c.term}` === n.id)!;
      const top = e.mentions[0];
      return {
        ...base,
        title: e.term,
        subtitle: t("mycelial.node.potentialPage"),
        snippet: top ? top.snippet : "",
        sourceLabel: tPlural("mycelial.node.emergedFrom", e.mentions.length),
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
  for (const s of springs) {
    if (s.tether) continue; // layout-only; never drawn
    addConn(s.kind, s.score, s.a, s.b);
  }

  return {
    boxes,
    connections,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  };
}
