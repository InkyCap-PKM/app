/**
 * Mycelial View layout engine.
 *
 * The view has two concentric regions:
 *
 *  - **Inner growth region** — a force-directed layout of the center note,
 *    latent-link boxes, emergent-concept boxes, and the *source notes* a
 *    signal emerged from. This is where the mycelium is actively growing.
 *  - **Outer horizon ring** — the note's existing wikilink neighbors that
 *    surfaced no signal, placed evenly on a circle that encloses the inner
 *    region. They are demoted to faint orientation markers: present for
 *    context, not woven into the graph.
 *
 * Connections: faint anchor edges (existing wikilinks), dashed latent
 * connections (mention -> target page), and organic emergent tendrils
 * (concept -> the notes it surfaced in).
 */

import type { FlowNode, FlowEdge, LatentLink, EmergentConcept } from "./types";

// Box dimensions — concept boxes are larger to fit a phrase + context.
export const NOTE_W = 156;
export const NOTE_H = 46;
export const CONCEPT_W = 224;
export const CONCEPT_H = 104;

// Force-simulation constants.
const SPRING_LENGTH = 230;
const REPULSION = 26000;
const SPRING_K = 0.04;
const DAMPING = 0.85;
const ITERATIONS = 80;
const PADDING = 120;
// Gap between the inner region's outer edge and the horizon ring.
const RING_GAP = 150;

export type BoxKind = "center" | "source" | "context" | "latent" | "emergent";
export type ConnectionKind = "anchor" | "latent" | "emergent";

export interface MycelialBox {
  id: string;
  kind: BoxKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Dominant phrase shown in the box. */
  title: string;
  /** Small role label ("Latent link" / "Potential page"). */
  subtitle: string;
  /** Search-result-style context line, when the box carries a signal. */
  snippet: string;
  /** Provenance label shown under the context. */
  sourceLabel: string;
  latent?: LatentLink;
  emergent?: EmergentConcept;
  note?: FlowNode;
}

export interface MycelialConnection {
  kind: ConnectionKind;
  path: string;
  /** 0..1 strength, drives stroke width / opacity. */
  score: number;
  /** Box ids of the two endpoints, for hover highlighting. */
  from: string;
  to: string;
}

export interface MycelialLayout {
  boxes: MycelialBox[];
  connections: MycelialConnection[];
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

interface SimNode {
  id: string;
  kind: BoxKind;
  w: number;
  h: number;
}

export function computeMycelialLayout(
  centerId: string,
  sourceNotes: FlowNode[],
  contextNotes: FlowNode[],
  contextEdges: FlowEdge[],
  latentLinks: LatentLink[],
  emergentConcepts: EmergentConcept[],
): MycelialLayout {
  // ---- 1. Inner simulation nodes. -----------------------------------------
  const latentByTarget = new Map<string, LatentLink>();
  for (const l of latentLinks) {
    if (!latentByTarget.has(l.target_path)) latentByTarget.set(l.target_path, l);
  }

  const noteById = new Map<string, FlowNode>();
  for (const n of [...sourceNotes, ...contextNotes]) noteById.set(n.id, n);

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
    sim.push({
      id: l.target_path,
      kind: "latent",
      w: CONCEPT_W,
      h: CONCEPT_H,
    });
  }
  for (const e of emergentConcepts) {
    const id = `emergent:${e.term}`;
    if (seen.has(id)) continue;
    seen.add(id);
    sim.push({ id, kind: "emergent", w: CONCEPT_W, h: CONCEPT_H });
  }
  const simIds = new Set(sim.map((n) => n.id));

  // ---- 2. Spring connections (inner region only). -------------------------
  interface Spring {
    a: string;
    b: string;
    kind: ConnectionKind;
    score: number;
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
        springs.push({
          a: m.path,
          b: l.target_path,
          kind: "latent",
          score: l.score,
        });
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
    const r = SPRING_LENGTH * (0.9 + seededRandom(hashString(n.id)) * 0.6);
    pos.set(n.id, { x: r * Math.cos(step * i), y: r * Math.sin(step * i) });
  });
  for (const n of sim) vel.set(n.id, { vx: 0, vy: 0 });

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < sim.length; i++) {
      for (let j = i + 1; j < sim.length; j++) {
        const a = pos.get(sim[i].id)!;
        const b = pos.get(sim[j].id)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (sim[i].id !== centerId) {
          const v = vel.get(sim[i].id)!;
          v.vx -= fx;
          v.vy -= fy;
        }
        if (sim[j].id !== centerId) {
          const v = vel.get(sim[j].id)!;
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
      v.vx *= DAMPING;
      v.vy *= DAMPING;
      p.x += v.vx;
      p.y += v.vy;
    }
  }

  // ---- 4. Horizon ring: place context notes on an enclosing circle. -------
  // Radius reaches past the farthest inner box corner.
  let innerReach = SPRING_LENGTH;
  for (const n of sim) {
    const p = pos.get(n.id)!;
    const corner = Math.hypot(n.w / 2, n.h / 2);
    innerReach = Math.max(innerReach, Math.hypot(p.x, p.y) + corner);
  }
  const ringRadius = innerReach + RING_GAP;
  const ringNodes = contextNotes.filter((n) => !simIds.has(n.id));
  const ringStep = (2 * Math.PI) / Math.max(ringNodes.length, 1);
  ringNodes.forEach((n, i) => {
    // Stagger the start angle so a single ring node isn't dead-centre top.
    const angle = ringStep * i - Math.PI / 2 + ringStep / 2;
    pos.set(n.id, {
      x: ringRadius * Math.cos(angle),
      y: ringRadius * Math.sin(angle),
    });
  });

  // ---- 5. Normalize to positive coordinates. ------------------------------
  const allBoxes: SimNode[] = [
    ...sim,
    ...ringNodes.map((n) => ({
      id: n.id,
      kind: "context" as BoxKind,
      w: NOTE_W,
      h: NOTE_H,
    })),
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of allBoxes) {
    const p = pos.get(n.id)!;
    minX = Math.min(minX, p.x - n.w / 2);
    minY = Math.min(minY, p.y - n.h / 2);
    maxX = Math.max(maxX, p.x + n.w / 2);
    maxY = Math.max(maxY, p.y + n.h / 2);
  }
  const offX = -minX + PADDING;
  const offY = -minY + PADDING;

  // ---- 6. Build boxes. ----------------------------------------------------
  const boxes: MycelialBox[] = allBoxes.map((n) => {
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

  // ---- 7. Connection paths. -----------------------------------------------
  const connections: MycelialConnection[] = [];
  const pushConn = (
    kind: ConnectionKind,
    score: number,
    from: string,
    to: string,
  ) => {
    const a = boxById.get(from);
    const b = boxById.get(to);
    if (!a || !b) return;
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    const dx = bx - ax;
    const dy = by - ay;
    if (kind === "emergent") {
      const seed = hashString(from + to);
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * (12 + seededRandom(seed) * 26);
      const py = (dx / len) * (12 + seededRandom(seed) * 26);
      connections.push({
        kind,
        score,
        from,
        to,
        path: `M ${ax} ${ay} C ${ax + dx * 0.3 + px} ${ay + dy * 0.3 + py}, ${ax + dx * 0.7 + px * 0.6} ${ay + dy * 0.7 + py * 0.6}, ${bx} ${by}`,
      });
    } else {
      const ctrl = Math.max(Math.abs(dx), Math.abs(dy)) * 0.25;
      connections.push({
        kind,
        score,
        from,
        to,
        path: `M ${ax} ${ay} C ${ax + ctrl * Math.sign(dx)} ${ay}, ${bx - ctrl * Math.sign(dx)} ${by}, ${bx} ${by}`,
      });
    }
  };
  for (const s of springs) pushConn(s.kind, s.score, s.a, s.b);
  // Faint wikilinks reaching out to the horizon ring.
  for (const e of contextEdges) {
    const fromRing = boxById.get(e.source)?.kind === "context";
    const toRing = boxById.get(e.target)?.kind === "context";
    if (fromRing || toRing) pushConn("anchor", 0.3, e.source, e.target);
  }

  return {
    boxes,
    connections,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  };
}
