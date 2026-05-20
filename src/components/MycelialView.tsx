/**
 * Mycelial View — surfaces where a notebox wants to grow next.
 *
 * The graph shows the inner growth region: the center note, latent links,
 * emergent concepts, and source notes. Context notes (wikilink neighbors
 * with no signal) are shown in the right panel as a clickable list.
 */

import {
  createSignal,
  createMemo,
  createEffect,
  onCleanup,
  untrack,
  For,
  Show,
} from "solid-js";
import { Info } from "lucide-solid";
import * as ipc from "../lib/ipc";
import { pathEquals } from "../lib/paths";
import { openTab } from "../stores/tabs";
import { settings } from "../stores/settings";
import { Dropdown } from "./Dropdown";
import {
  contextNotes,
  setContextNotes,
  contextEdges,
  setContextEdges,
  setHoveredGraphNode,
  hoveredContextNote,
  type MycelialContextNote,
} from "../stores/mycelial";
import type { LatentLink, SourceMention, FlowEdge } from "../lib/types";
import {
  computeMycelialLayout,
  hashString,
  seededRandom,
  type MycelialLayout,
  type MycelialBox,
  type MycelialConnection,
  type BoxKind,
} from "../lib/mycelial-layout";

interface MycelialViewProps {
  path: string;
}

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3;
const PAN_STEP = 140;

interface ViewCacheEntry {
  layout: MycelialLayout;
  zoom: number;
  panX: number;
  panY: number;
  /** Box kinds the user has switched off via the legend. */
  hidden: Set<BoxKind>;
  history: string[];
  centerPath: string;
  maxDepth: number;
  /** Right-panel context list — cached so a tab switch and return doesn't
   *  blank it (the underlying signal is module-global and gets cleared on
   *  unmount). */
  contextNotes: MycelialContextNote[];
  contextEdges: FlowEdge[];
}

const viewCache = new Map<string, ViewCacheEntry>();

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function highlightParts(
  snippet: string,
  term: string,
): { text: string; hit: boolean }[] {
  const idx = snippet.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return [{ text: snippet, hit: false }];
  return [
    { text: snippet.slice(0, idx), hit: false },
    { text: snippet.slice(idx, idx + term.length), hit: true },
    { text: snippet.slice(idx + term.length), hit: false },
  ];
}

const LEGEND: { kind: BoxKind; label: string; color: string; dashed: boolean }[] =
  [
    { kind: "center", label: "Anchor note", color: "var(--accent)", dashed: false },
    {
      kind: "latent",
      label: "Latent link",
      color: "var(--mycelial-latent, #c08a3e)",
      dashed: true,
    },
    {
      kind: "emergent",
      label: "Emergent concept",
      color: "var(--mycelial-emergent, #6f4423)",
      dashed: false,
    },
    {
      kind: "source",
      label: "Source note",
      color: "var(--mycelial-source, #6e6e6e)",
      dashed: false,
    },
  ];

export default function MycelialView(props: MycelialViewProps) {
  const [layout, setLayout] = createSignal<MycelialLayout | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [hoveredBox, setHoveredBox] = createSignal<string | null>(null);
  const [maxDepth, setMaxDepth] = createSignal(2);
  const [centerPath, setCenterPath] = createSignal(props.path);
  const [history, setHistory] = createSignal<string[]>([]);
  // The legend is a visibility filter: every box kind is shown by default,
  // and a kind listed here has been switched off by the user. This lets the
  // user remove the kinds they don't want and keep several visible at once,
  // rather than only being able to isolate a single kind.
  const [hidden, setHidden] = createSignal<Set<BoxKind>>(new Set());

  // Arbitrary stopword entry, opened from the legend row.
  const [stopwordOpen, setStopwordOpen] = createSignal(false);
  const [stopwordDraft, setStopwordDraft] = createSignal("");

  // "What am I looking at?" help panel, opened from the legend's info icon.
  const [helpOpen, setHelpOpen] = createSignal(false);

  // Anchor-note spotlight — the legend's "Anchor note" item pulses the
  // center box rather than filtering it (it's always present, never hidden).
  // When the anchor is off-screen, an edge beacon is shown instead, pinned to
  // the viewport edge in its direction so the user knows which way to scroll.
  const [pulsing, setPulsing] = createSignal(false);
  const [edgeBeacon, setEdgeBeacon] = createSignal<{
    x: number;
    y: number;
  } | null>(null);
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;

  const [zoom, setZoom] = createSignal(1);
  const [panX, setPanX] = createSignal(0);
  const [panY, setPanY] = createSignal(0);

  const [picker, setPicker] = createSignal<{
    latent: LatentLink;
    x: number;
    y: number;
  } | null>(null);

  let canvasRef: HTMLDivElement | undefined;
  let drag: { sx: number; sy: number; ax: number; ay: number; moved: boolean } | null = null;
  let suppressClick = false;
  let hoverTimeout: ReturnType<typeof setTimeout> | undefined;

  function setHoverDebounced(id: string | null) {
    clearTimeout(hoverTimeout);
    if (id === null) {
      hoverTimeout = setTimeout(() => {
        setHoveredBox(null);
        setHoveredGraphNode(null);
      }, 80);
    } else {
      setHoveredBox(id);
      setHoveredGraphNode(id);
    }
  }

  // ---- Viewport -----------------------------------------------------------

  function fitToView(l: MycelialLayout) {
    if (!canvasRef) return;
    const cw = canvasRef.clientWidth || 800;
    const ch = canvasRef.clientHeight || 600;
    const z = Math.min(cw / l.width, ch / l.height, 1) * 0.92;
    setZoom(Math.max(z, ZOOM_MIN));
    setPanX((cw - l.width * z) / 2);
    setPanY((ch - l.height * z) / 2);
  }

  /** Spotlight the anchor note without moving the graph. If the anchor is
   *  within the viewport it pulses in place; if it's scrolled off-screen, a
   *  pulsing beacon is pinned to the viewport edge in its direction instead,
   *  so the user can see which way to scroll to reach it. */
  function spotlightCenter() {
    const l = layout();
    const center = l?.boxes.find((b) => b.kind === "center");
    if (!center || !canvasRef) return;
    const cw = canvasRef.clientWidth || 800;
    const ch = canvasRef.clientHeight || 600;
    // Anchor centre in viewport (screen) coordinates.
    const sx = panX() + (center.x + center.w / 2) * zoom();
    const sy = panY() + (center.y + center.h / 2) * zoom();
    const onScreen = sx >= 0 && sx <= cw && sy >= 0 && sy <= ch;

    // Restart any in-flight spotlight: drop both cues, then re-add next
    // frame so the CSS animation replays from the start.
    setPulsing(false);
    setEdgeBeacon(null);
    clearTimeout(pulseTimer);
    requestAnimationFrame(() => {
      if (onScreen) {
        setPulsing(true);
      } else {
        // Land the beacon flush on the viewport edge — the canvas clips its
        // outer half, so it reads as a diffuse glow bleeding in from beyond
        // the edge rather than a pin marking an exact spot.
        setEdgeBeacon({
          x: clamp(sx, 0, cw),
          y: clamp(sy, 0, ch),
        });
      }
      pulseTimer = setTimeout(() => {
        setPulsing(false);
        setEdgeBeacon(null);
      }, 2850);
    });
  }

  // Dismiss the stopword popup on an outside click (it lives in the legend,
  // outside the canvas, so the canvas click-handler doesn't reach it).
  createEffect(() => {
    if (!stopwordOpen()) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".mycelial-view__legend-tools")) {
        setStopwordOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  });

  // Dismiss the help panel on an outside click or the Escape key.
  createEffect(() => {
    if (!helpOpen()) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".mycelial-view__legend-help")) {
        setHelpOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  /** Append a user-typed term to the notebox stopword list and recompute. */
  async function addArbitraryStopword() {
    const term = stopwordDraft().trim();
    if (!term) return;
    setStopwordOpen(false);
    setStopwordDraft("");
    try {
      await ipc.addMycelialStopword(term);
      loadData();
    } catch (err) {
      console.error("Failed to add stopword", err);
    }
  }

  async function loadData(path?: string) {
    const targetPath = path ?? centerPath();
    setLoading(true);
    setPicker(null);
    setNamer(null);
    try {
      const data = await ipc.getMycelialData(targetPath, maxDepth());

      // Build the set of inner node IDs so we can resolve which inner nodes
      // each context note connects to.
      const innerIds = new Set<string>([data.center]);
      for (const n of data.source_notes) innerIds.add(n.id);
      for (const l of data.latent_links) innerIds.add(l.target_path);
      for (const e of data.emergent_concepts) innerIds.add(`emergent:${e.term}`);

      setContextNotes(
        data.context_notes.map((n) => {
          const linked: string[] = [];
          for (const edge of data.context_edges) {
            if (edge.source === n.id && innerIds.has(edge.target)) linked.push(edge.target);
            if (edge.target === n.id && innerIds.has(edge.source)) linked.push(edge.source);
          }
          return { path: n.id, name: n.name, linkedInnerIds: linked };
        }),
      );
      setContextEdges(data.context_edges);

      const computed = computeMycelialLayout(
        data.center,
        data.source_notes,
        data.context_edges,
        data.latent_links,
        data.emergent_concepts,
      );
      setLayout(computed);
      fitToView(computed);
    } catch (err) {
      console.error("Mycelial View: failed to load data", err);
    } finally {
      setLoading(false);
    }
  }

  /** Snapshot the current graph state so returning to this note is instant. */
  function cacheView(path: string) {
    const l = layout();
    if (!l) return;
    viewCache.set(path, {
      layout: l,
      zoom: zoom(),
      panX: panX(),
      panY: panY(),
      hidden: new Set<BoxKind>(hidden()),
      history: history(),
      centerPath: centerPath(),
      maxDepth: maxDepth(),
      contextNotes: contextNotes(),
      contextEdges: contextEdges(),
    });
  }

  // Load (or restore) the graph whenever the bound note changes. This must
  // be an effect, not `onMount`: the Mycelial View tab is repointed at a new
  // note in place (the component instance is reused), so a once-only
  // `onMount` would leave the graph stuck on the previously opened note.
  let loadedPath: string | null = null;
  createEffect(() => {
    const path = props.path;
    if (path === loadedPath) return;
    untrack(() => {
      // Cache the note we're leaving before swapping in the new one.
      if (loadedPath) cacheView(loadedPath);
      loadedPath = path;
      const cached = viewCache.get(path);
      if (cached) {
        setLayout(cached.layout);
        setZoom(cached.zoom);
        setPanX(cached.panX);
        setPanY(cached.panY);
        setHidden(new Set<BoxKind>(cached.hidden));
        setHistory(cached.history);
        setCenterPath(cached.centerPath);
        setMaxDepth(cached.maxDepth);
        setContextNotes(cached.contextNotes);
        setContextEdges(cached.contextEdges);
        setLoading(false);
      } else {
        setCenterPath(path);
        setHistory([]);
        setHidden(new Set<BoxKind>());
        loadData(path);
      }
    });
  });

  onCleanup(() => {
    if (loadedPath) cacheView(loadedPath);
    setContextNotes([]);
    setContextEdges([]);
    setHoveredGraphNode(null);
    clearTimeout(pulseTimer);
  });

  function recenter(path: string) {
    if (path === centerPath()) return;
    setHistory((h) => [...h, centerPath()]);
    setCenterPath(path);
    loadData(path);
  }

  function handleBack() {
    const h = history();
    if (h.length === 0) return;
    const prev = h[h.length - 1];
    setHistory(h.slice(0, -1));
    setCenterPath(prev);
    loadData(prev);
  }

  function handleDepthChange(depth: number) {
    setMaxDepth(depth);
    loadData();
  }

  // ---- Derived data -------------------------------------------------------

  const boxById = createMemo(() => {
    const m = new Map<string, MycelialBox>();
    for (const b of layout()?.boxes ?? []) m.set(b.id, b);
    return m;
  });

  // Boxes render in a STABLE document order — deliberately *not* reordered to
  // float the hovered box last. The layout's `resolveOverlaps` pass already
  // guarantees no two boxes overlap, so document order never causes occlusion.
  // Reordering the array on hover forced WebKitGTK (the Tauri webview) to move
  // a `<foreignObject>` inside a transformed `<g>` on every hover, and its
  // foreignObject repaint bug left a stale "phantom" copy of the box behind.
  // Keeping the order fixed eliminates that DOM mutation entirely.

  const adjacency = createMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of layout()?.connections ?? []) {
      (m.get(c.from) ?? m.set(c.from, new Set()).get(c.from)!).add(c.to);
      (m.get(c.to) ?? m.set(c.to, new Set()).get(c.to)!).add(c.from);
    }
    return m;
  });

  // The non-anchor kinds the legend currently shows.
  const visibleKinds = createMemo<BoxKind[]>(() => {
    const h = hidden();
    return (["latent", "emergent", "source"] as BoxKind[]).filter(
      (k) => !h.has(k),
    );
  });

  // When the legend leaves exactly one kind visible, the graph's real
  // connections (which run between kinds) all but vanish — so fall back to
  // synthesized "pathway" edges among that surviving kind.
  const soloKind = createMemo<BoxKind | null>(() => {
    const v = visibleKinds();
    return v.length === 1 ? v[0] : null;
  });

  // Real connections, filtered to those whose endpoints are both visible.
  const visibleConnections = createMemo<MycelialConnection[]>(() => {
    const conns = layout()?.connections ?? [];
    const bb = boxById();
    return conns.filter((c) => {
      const a = bb.get(c.from);
      const b = bb.get(c.to);
      return !!a && !!b && boxVisible(a.kind) && boxVisible(b.kind);
    });
  });

  // When the legend filters to one kind, the graph's real connections are
  // hidden — so synthesize "pathway" edges between the surviving boxes via
  // their shared provenance: two concepts that emerged from / are mentioned
  // in the same note are linked. Source notes already carry real wikilink
  // edges among themselves, so those are reused directly.
  const derivedConnections = createMemo<MycelialConnection[]>(() => {
    const iso = soloKind();
    const l = layout();
    if (!iso || !l) return [];

    if (iso === "emergent" || iso === "latent") {
      const boxes = l.boxes.filter((b) => b.kind === iso);
      const notesOf = (b: MycelialBox): Set<string> => {
        const ms =
          b.kind === "emergent" ? b.emergent?.mentions : b.latent?.mentions;
        return new Set((ms ?? []).map((m) => m.path));
      };
      const sets = boxes.map(notesOf);
      const out: MycelialConnection[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          let shared = 0;
          for (const p of sets[i]) if (sets[j].has(p)) shared++;
          if (shared > 0) {
            out.push({
              kind: iso,
              score: Math.min(shared / 3, 1),
              from: boxes[i].id,
              to: boxes[j].id,
            });
          }
        }
      }
      return out;
    }

    if (iso === "source") {
      return l.connections.filter((c) => {
        if (c.kind !== "anchor") return false;
        const a = boxById().get(c.from);
        const b = boxById().get(c.to);
        return a?.kind === "source" && b?.kind === "source";
      });
    }
    return [];
  });

  function edgePoint(
    box: MycelialBox,
    targetX: number,
    targetY: number,
  ): { x: number; y: number } {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const dx = targetX - cx;
    const dy = targetY - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const scaleX = dx !== 0 ? (box.w / 2) / Math.abs(dx) : Infinity;
    const scaleY = dy !== 0 ? (box.h / 2) / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  function connectionPath(conn: MycelialConnection): string {
    const a = boxById().get(conn.from);
    const b = boxById().get(conn.to);
    if (!a || !b) return "";
    const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
    const A = edgePoint(a, bcx, bcy);
    const B = edgePoint(b, acx, acy);
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    if (conn.kind === "emergent") {
      const seed = hashString(conn.from + conn.to);
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * (16 + seededRandom(seed) * 30);
      const py = (dx / len) * (16 + seededRandom(seed) * 30);
      return `M ${A.x} ${A.y} C ${A.x + dx * 0.3 + px} ${A.y + dy * 0.3 + py}, ${A.x + dx * 0.7 + px * 0.6} ${A.y + dy * 0.7 + py * 0.6}, ${B.x} ${B.y}`;
    }
    const ctrl = Math.max(Math.abs(dx), Math.abs(dy)) * 0.3;
    return `M ${A.x} ${A.y} C ${A.x + ctrl * Math.sign(dx)} ${A.y}, ${B.x - ctrl * Math.sign(dx)} ${B.y}, ${B.x} ${B.y}`;
  }

  function boxVisible(kind: BoxKind): boolean {
    return !hidden().has(kind);
  }

  function boxDimmed(id: string): boolean {
    const h = hoveredBox();
    const panelHover = hoveredContextNote();
    if (panelHover !== null) {
      const ctx = contextNotes().find((n) => pathEquals(n.path, panelHover));
      if (ctx) return !ctx.linkedInnerIds.includes(id) && id !== panelHover;
      return false;
    }
    if (h === null) return false;
    if (h === id) return false;
    return !(adjacency().get(h)?.has(id) ?? false);
  }

  function connectionActive(from: string, to: string): boolean {
    const h = hoveredBox();
    const panelHover = hoveredContextNote();
    if (panelHover !== null) {
      const ctx = contextNotes().find((n) => pathEquals(n.path, panelHover));
      if (ctx) return ctx.linkedInnerIds.includes(from) || ctx.linkedInnerIds.includes(to);
      return false;
    }
    return h === null || h === from || h === to;
  }

  function strokeWidth(score: number): number {
    return 1.8 + score * 3.5;
  }

  // ---- Box interactions ---------------------------------------------------

  function handleBoxClick(box: MycelialBox, e: MouseEvent) {
    e.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (box.kind === "emergent" && box.emergent) {
      // A short concept (1–3 words) is already a usable page title — create
      // it directly. A longer stitched run is a recurring phrase, not a
      // title, so open the namer popup to let the user trim it first.
      const wordCount = box.emergent.term.trim().split(/\s+/).length;
      if (wordCount > 3) {
        const rect = canvasRef?.getBoundingClientRect();
        setNamerDraft(titleCase(box.emergent.term));
        setNamer({
          box,
          x: e.clientX - (rect?.left ?? 0),
          y: e.clientY - (rect?.top ?? 0),
        });
      } else {
        createEmergentNote(box);
      }
    } else if (box.kind === "latent" && box.latent) {
      const rect = canvasRef?.getBoundingClientRect();
      setPicker({
        latent: box.latent,
        x: e.clientX - (rect?.left ?? 0),
        y: e.clientY - (rect?.top ?? 0),
      });
    } else if (box.kind === "source") {
      recenter(box.id);
    }
  }

  // Edit-title popup, shown when a long (multi-word) emergent run is clicked
  // so the user can trim the recurring phrase down to a real page title.
  const [namer, setNamer] = createSignal<{
    box: MycelialBox;
    x: number;
    y: number;
  } | null>(null);
  const [namerDraft, setNamerDraft] = createSignal("");

  async function createEmergentNote(box: MycelialBox, titleOverride?: string) {
    const concept = box.emergent;
    if (!concept) return;
    const title = titleOverride?.trim() || titleCase(concept.term);
    const center = centerPath();
    const folder = center.includes("/")
      ? center.slice(0, center.lastIndexOf("/"))
      : "";
    const bullets = concept.mentions
      .map((m) => `- #wikilink(${JSON.stringify(m.name)})`)
      .join("\n");
    // Mirror the new-note scaffold: when Zettelkasten IDs are enabled, stamp
    // the freshly created concept page with its own zid so it's a first-class
    // notebox citizen, not a property-poor page born outside the normal flow.
    const noteProps = [`title: ${JSON.stringify(title)}`];
    if (settings.files.zettelkasten_enabled) {
      try {
        const zid = await ipc.generateZid();
        noteProps.push(`zid: ${JSON.stringify(zid)}`);
      } catch (err) {
        console.error("Mycelial View: failed to generate zid", err);
      }
    }
    const body =
      `#note(${noteProps.join(", ")})\n\n` +
      `= ${title}\n\n` +
      `== Emerged from\n\n` +
      `This page emerged from a concept recurring across these notes:\n\n` +
      `${bullets}\n`;
    try {
      const newPath = await ipc.createNote(title, folder, body);
      openTab({ type: "file", title, path: newPath }, { forceNewTab: true });
    } catch (err) {
      console.error("Mycelial View: failed to create emergent note", err);
    }
  }

  const [contextMenu, setContextMenu] = createSignal<{
    term: string;
    x: number;
    y: number;
  } | null>(null);

  async function handleAddStopword(term: string) {
    setContextMenu(null);
    try {
      await ipc.addMycelialStopword(term);
      loadData();
    } catch (err) {
      console.error("Failed to add stopword", err);
    }
  }

  function handleBoxContextMenu(box: MycelialBox, e: MouseEvent) {
    if (box.kind !== "emergent" || !box.emergent) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef?.getBoundingClientRect();
    setContextMenu({
      term: box.emergent.term,
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    });
  }

  function openMention(m: SourceMention) {
    setPicker(null);
    openTab(
      { type: "file", title: m.name, path: m.path },
      {
        forceNewTab: true,
        match: { line: m.line, charStart: m.char_start, charEnd: m.char_end },
      },
    );
  }

  // ---- Viewport (pan / zoom) ----------------------------------------------

  function zoomBy(factor: number, cx?: number, cy?: number) {
    if (!canvasRef) return;
    const rect = canvasRef.getBoundingClientRect();
    const mx = cx ?? rect.width / 2;
    const my = cy ?? rect.height / 2;
    const next = clamp(zoom() * factor, ZOOM_MIN, ZOOM_MAX);
    const wx = (mx - panX()) / zoom();
    const wy = (my - panY()) / zoom();
    setPanX(mx - wx * next);
    setPanY(my - wy * next);
    setZoom(next);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvasRef!.getBoundingClientRect();
    zoomBy(
      e.deltaY < 0 ? 1.12 : 1 / 1.12,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  }

  function onCanvasMouseDown(e: MouseEvent) {
    drag = {
      sx: e.clientX,
      sy: e.clientY,
      ax: panX(),
      ay: panY(),
      moved: false,
    };
  }

  function onCanvasMouseMove(e: MouseEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    setPanX(drag.ax + dx);
    setPanY(drag.ay + dy);
  }

  function onCanvasMouseUp() {
    suppressClick = drag?.moved ?? false;
    drag = null;
  }

  function onCanvasClick() {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    setPicker(null);
    setContextMenu(null);
    setNamer(null);
  }

  function panBy(dx: number, dy: number) {
    setPanX(panX() + dx);
    setPanY(panY() + dy);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowUp") panBy(0, PAN_STEP);
    else if (e.key === "ArrowDown") panBy(0, -PAN_STEP);
    else if (e.key === "ArrowLeft") panBy(PAN_STEP, 0);
    else if (e.key === "ArrowRight") panBy(-PAN_STEP, 0);
    else if (e.key === "+" || e.key === "=") zoomBy(1.15);
    else if (e.key === "-") zoomBy(1 / 1.15);
    else return;
    e.preventDefault();
  }

  // ---- Rendering ----------------------------------------------------------

  function connectionColor(kind: string): string {
    return kind === "emergent"
      ? "var(--mycelial-emergent, #6f4423)"
      : kind === "latent"
        ? "var(--mycelial-latent, #c08a3e)"
        : "var(--border-primary)";
  }

  const renderConnection = (conn: MycelialConnection) => {
    const active = () => connectionActive(conn.from, conn.to);
    return (
      <path
        d={connectionPath(conn)}
        fill="none"
        stroke={connectionColor(conn.kind)}
        stroke-width={conn.kind === "anchor" ? 1.5 : strokeWidth(conn.score)}
        stroke-linecap="round"
        stroke-dasharray={conn.kind === "latent" ? "5 4" : "none"}
        opacity={
          conn.kind === "anchor"
            ? active()
              ? 0.5
              : 0.1
            : active()
              ? 0.9
              : 0.15
        }
        style="transition: opacity 0.3s ease"
      />
    );
  };

  // Pathway edge between two filtered survivors — faint, dotted, distinct
  // from the real connections so it reads as "derived, not literal".
  const renderPathway = (conn: MycelialConnection) => {
    const active = () => connectionActive(conn.from, conn.to);
    return (
      <path
        d={connectionPath(conn)}
        fill="none"
        stroke={connectionColor(conn.kind)}
        stroke-width={1.2 + conn.score * 2.4}
        stroke-linecap="round"
        stroke-dasharray="2 6"
        opacity={active() ? 0.6 : 0.22}
        style="transition: opacity 0.3s ease"
      />
    );
  };

  // Boxes are plain HTML positioned in the `.mycelial-view__nodes` overlay —
  // deliberately NOT `<foreignObject>` inside the SVG. WebKitGTK (the Tauri
  // webview) repaints foreignObject content while ignoring the ancestor
  // `<g>`'s `scale()` transform, so on a content change a box ghosts at its
  // native un-zoomed size near the cursor. An HTML layer carrying the same
  // pan/zoom transform via CSS has no such bug.
  const renderBox = (box: MycelialBox) => (
    <Show when={boxVisible(box.kind)}>
      <div
        class={`mycelial-box mycelial-box--${box.kind}`}
        classList={{
          "mycelial-box--dim": boxDimmed(box.id),
          "mycelial-box--pulse": box.kind === "center" && pulsing(),
        }}
        style={{
          left: `${box.x}px`,
          top: `${box.y}px`,
          width: `${box.w}px`,
          height: `${box.h}px`,
        }}
        onMouseEnter={() => setHoverDebounced(box.id)}
        onMouseLeave={() => setHoverDebounced(null)}
        onClick={(e) => handleBoxClick(box, e)}
        onContextMenu={(e) => handleBoxContextMenu(box, e)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Show
          when={box.kind === "latent" || box.kind === "emergent"}
          fallback={<div class="mycelial-box__note-title">{box.title}</div>}
        >
          <div class="mycelial-box__concept">{box.title}</div>
          <div class="mycelial-box__subtitle">{box.subtitle}</div>
          <Show when={box.snippet}>
            <div class="mycelial-box__snippet">
              <For
                each={highlightParts(
                  box.snippet,
                  box.latent ? box.latent.term : (box.emergent?.term ?? ""),
                )}
              >
                {(part) => (
                  <span classList={{ "mycelial-box__hit": part.hit }}>
                    {part.text}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <div class="mycelial-box__source">{box.sourceLabel}</div>
        </Show>
      </div>
    </Show>
  );

  return (
    <div class="mycelial-view">
      <div class="mycelial-view__toolbar">
        <div class="mycelial-view__toolbar-left">
          <Show when={history().length > 0}>
            <button class="mycelial-view__btn" onClick={handleBack} title="Back">
              ←
            </button>
          </Show>
          <span class="mycelial-view__title">
            {centerPath()
              .replace(/\.typ$/, "")
              .split("/")
              .pop() ?? "Mycelial View"}
          </span>
        </div>
        <div class="mycelial-view__toolbar-right">
          <label
            class="mycelial-view__depth-label"
            title="How many wikilink hops out to scan for the corpus neighborhood"
          >
            Depth
            <Dropdown
              value={maxDepth()}
              options={[
                { value: 1, label: "1" },
                { value: 2, label: "2" },
                { value: 3, label: "3" },
              ]}
              onChange={handleDepthChange}
              ariaLabel="Corpus scan depth"
            />
          </label>
          <button
            class="mycelial-view__btn"
            onClick={() => loadData()}
            title="Recompute from the current notebox contents"
          >
            ↻
          </button>
        </div>
      </div>

      <div
        class="mycelial-view__canvas"
        ref={canvasRef}
        tabindex={0}
        onWheel={onWheel}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
        onClick={onCanvasClick}
        onKeyDown={onKeyDown}
      >
        <Show
          when={!loading() && layout()}
          fallback={<div class="mycelial-view__loading">Loading…</div>}
        >
          {(_layout) => (
            <>
              <svg class="mycelial-view__svg" width="100%" height="100%">
                <g transform={`translate(${panX()}, ${panY()}) scale(${zoom()})`}>
                  <Show
                    when={soloKind() === null}
                    fallback={
                      <g class="mycelial-connections mycelial-connections--pathway">
                        <For each={derivedConnections()}>
                          {(conn) => renderPathway(conn)}
                        </For>
                      </g>
                    }
                  >
                    <g class="mycelial-connections">
                      <For each={visibleConnections()}>
                        {(conn) => renderConnection(conn)}
                      </For>
                    </g>
                  </Show>
                </g>
              </svg>

              {/* Node layer — plain HTML over the SVG, carrying the same
                  pan/zoom transform so boxes and edges stay registered. */}
              <div
                class="mycelial-view__nodes"
                style={{
                  transform: `translate(${panX()}px, ${panY()}px) scale(${zoom()})`,
                }}
              >
                <For each={_layout().boxes}>{(box) => renderBox(box)}</For>
              </div>
            </>
          )}
        </Show>

        {/* Off-screen anchor beacon — pinned to the viewport edge in the
            anchor's direction when the user spotlights an off-screen anchor. */}
        <Show when={edgeBeacon()}>
          {(b) => (
            <div
              class="mycelial-edge-beacon"
              style={{ left: `${b().x}px`, top: `${b().y}px` }}
            />
          )}
        </Show>

        {/* Viewport controls */}
        <div class="mycelial-controls">
          <div class="mycelial-controls__pad">
            <button
              class="mycelial-controls__btn mycelial-controls__btn--n"
              title="Pan up"
              onClick={() => panBy(0, PAN_STEP)}
            >
              ↑
            </button>
            <button
              class="mycelial-controls__btn mycelial-controls__btn--w"
              title="Pan left"
              onClick={() => panBy(PAN_STEP, 0)}
            >
              ←
            </button>
            <button
              class="mycelial-controls__btn mycelial-controls__btn--fit"
              title="Fit to view"
              onClick={() => {
                const l = layout();
                if (l) fitToView(l);
              }}
            >
              ⊡
            </button>
            <button
              class="mycelial-controls__btn mycelial-controls__btn--e"
              title="Pan right"
              onClick={() => panBy(-PAN_STEP, 0)}
            >
              →
            </button>
            <button
              class="mycelial-controls__btn mycelial-controls__btn--s"
              title="Pan down"
              onClick={() => panBy(0, -PAN_STEP)}
            >
              ↓
            </button>
          </div>
          <div class="mycelial-controls__group">
            <button
              class="mycelial-controls__btn"
              title="Zoom in"
              onClick={() => zoomBy(1.2)}
            >
              +
            </button>
            <span class="mycelial-controls__level">
              {Math.round(zoom() * 100)}%
            </span>
            <button
              class="mycelial-controls__btn"
              title="Zoom out"
              onClick={() => zoomBy(1 / 1.2)}
            >
              −
            </button>
          </div>
        </div>

        {/* Latent-link mention picker */}
        <Show when={picker()}>
          {(p) => (
            <div
              class="mycelial-picker"
              style={{ left: `${p().x}px`, top: `${p().y}px` }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div class="mycelial-picker__header">
                Link "{p().latent.term}" → {p().latent.target_name}
              </div>
              <div class="mycelial-picker__hint">
                Open a note to wrap the mention in <code>[[ ]]</code>:
              </div>
              <For each={p().latent.mentions}>
                {(m) => (
                  <button
                    class="mycelial-picker__item"
                    onClick={() => openMention(m)}
                  >
                    <span class="mycelial-picker__item-name">{m.name}</span>
                    <span class="mycelial-picker__item-snippet">
                      <For each={highlightParts(m.snippet, p().latent.term)}>
                        {(part) => (
                          <span classList={{ "mycelial-box__hit": part.hit }}>
                            {part.text}
                          </span>
                        )}
                      </For>
                    </span>
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>

        {/* Emergent concept context menu */}
        <Show when={contextMenu()}>
          {(cm) => (
            <div
              class="mycelial-context-menu"
              style={{ left: `${cm().x}px`, top: `${cm().y}px` }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                class="mycelial-context-menu__item"
                onClick={() => handleAddStopword(cm().term)}
              >
                Add "{cm().term}" to stopwords
              </button>
            </div>
          )}
        </Show>

        {/* Edit-title popup — shown for long emergent runs before creating */}
        <Show when={namer()}>
          {(n) => {
            const submit = () => {
              if (!namerDraft().trim()) return;
              createEmergentNote(n().box, namerDraft());
              setNamer(null);
            };
            return (
              <div
                class="mycelial-picker mycelial-namer"
                style={{ left: `${n().x}px`, top: `${n().y}px` }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div class="mycelial-picker__header">New page from phrase</div>
                <div class="mycelial-picker__hint">
                  This is a recurring phrase. Use as-is or alter it for a new page title?
                </div>
                <input
                  class="mycelial-namer__input"
                  type="text"
                  value={namerDraft()}
                  onInput={(e) => setNamerDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setNamer(null);
                    }
                  }}
                  ref={(el) =>
                    queueMicrotask(() => {
                      el.focus();
                      el.select();
                    })
                  }
                />
                <div class="mycelial-namer__actions">
                  <button
                    class="app-modal__btn app-modal__btn--secondary"
                    onClick={() => setNamer(null)}
                  >
                    Cancel
                  </button>
                  <button
                    class="app-modal__btn app-modal__btn--primary"
                    disabled={!namerDraft().trim()}
                    onClick={submit}
                  >
                    Create
                  </button>
                </div>
              </div>
            );
          }}
        </Show>
      </div>

      {/* Legend doubles as a per-kind visibility filter: every kind shows
          by default, and clicking an item toggles that kind off. */}
      <div class="mycelial-view__legend">
        {/* Help — "what am I looking at?" — pinned to the left edge so the
            type-filter items stay centred. */}
        <div class="mycelial-view__legend-help">
          <button
            class="mycelial-view__legend-help-btn"
            classList={{ "is-active": helpOpen() }}
            title="About the Mycelial View"
            aria-label="About the Mycelial View"
            aria-expanded={helpOpen()}
            onClick={() => setHelpOpen((v) => !v)}
          >
            <Info size={16} />
          </button>
          <Show when={helpOpen()}>
            <div
              class="mycelial-view__help-pop"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div class="mycelial-view__help-title">
                The Mycelial View
              </div>
	      <div class="mycelial-view__help-heading">Where Does Your Knowledge Want to Grow?</div>
              <p class="mycelial-view__help-lead">
                This view helps you identify what you have not yet written in your notebox. Mycelial View is computed around the note you opened it from (the anchor) but it is not a graphical map of existing links.
              </p>

              <div class="mycelial-view__help-heading">The Nodes</div>
              <ul class="mycelial-view__help-list">
                <li>
                  <b>Anchor note:</b> the note this view is built around.
                  Everything else is found relative to it.
                </li>
                <li>
                  <b>Source notes:</b> other existing notes that contribute to the signal. Click one to rebuild the view around it.
                </li>
                <li>
                  <b>Latent link:</b> an existing page that other notes
                  mention by name without linking to it. Click it to see
                  those mentions, then open one to add the wikilink {" "}
                  <code>[[ ]]</code> in place.
                </li>
                <li>
                  <b>Emergent concept:</b> a phrase that recurs across
                  several notes but has no page yet. Click it to create
                  that page (a long phrase will prompt you to trim its title first).
                </li>
              </ul>

              <div class="mycelial-view__help-heading">The Paths</div>
              <p>
                A path (connective line) means two nodes share a signal. Thicker paths are
                stronger signals; faint grey paths are ordinary wikilinks
                between notes. Hovering a node highlights just its paths.
              </p>

              <div class="mycelial-view__help-heading">
                Why these Appear
              </div>
              <p>
                InkyCap looks at the anchor note plus its neighbourhood (notes it links to and the notes that read as most similar to it) and finds words or short phrases that recur in that neighbourhood in a distinctive way. If a recurring phrase matches an existing page, it surfaces as a latent link; if it has no page, it surfaces as an emergent concept. That's why a concept can appear even though you never wrote it as a heading—it was repeated often enough to stand out.
              </p>

              <div class="mycelial-view__help-heading">Controls</div>
              <ul class="mycelial-view__help-list">
                <li>
                  <b>Legend:</b> click a type to hide or show it.
                </li>
                <li>
                  <b>Depth:</b> how many wikilink hops out to scan.
                </li>
                <li>
                  <b>+ Stopword:</b> exclude a word from concept
                  detection when it's too generic to be useful.
                </li>
              </ul>
            </div>
          </Show>
        </div>
        <For each={LEGEND}>
          {(item) => (
            <button
              class="mycelial-view__legend-item"
              classList={{
                "mycelial-view__legend-item--off":
                  item.kind !== "center" && hidden().has(item.kind),
              }}
              title={
                item.kind === "center"
                  ? "Find the anchor note"
                  : hidden().has(item.kind)
                    ? `Show ${item.label.toLowerCase()}`
                    : `Hide ${item.label.toLowerCase()}`
              }
              onClick={() => {
                // The anchor note is always present and can't be filtered
                // out — clicking its legend item spotlights it instead.
                if (item.kind === "center") {
                  spotlightCenter();
                  return;
                }
                setHidden((cur) => {
                  const next = new Set(cur);
                  if (next.has(item.kind)) next.delete(item.kind);
                  else next.add(item.kind);
                  return next;
                });
              }}
            >
              <span
                class="mycelial-view__legend-line"
                classList={{
                  "mycelial-view__legend-line--dashed": item.dashed,
                }}
                style={{ "border-color": item.color }}
              />
              {item.label}
            </button>
          )}
        </For>

        {/* Arbitrary stopword entry — sits at the right edge of the row. */}
        <div class="mycelial-view__legend-tools">
          <button
            class="mycelial-view__legend-stopword"
            title="Add a word to the mycelial stopword list"
            onClick={() => setStopwordOpen((v) => !v)}
          >
            + Stopword
          </button>
          <Show when={stopwordOpen()}>
            <div
              class="mycelial-picker mycelial-namer mycelial-view__stopword-pop"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div class="mycelial-picker__header">Add stopword</div>
              <div class="mycelial-picker__hint">
                Stopwords are excluded from concept detection.
              </div>
              <input
                class="mycelial-namer__input"
                type="text"
                placeholder="word to ignore"
                value={stopwordDraft()}
                onInput={(e) => setStopwordDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addArbitraryStopword();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setStopwordOpen(false);
                  }
                }}
                ref={(el) => queueMicrotask(() => el.focus())}
              />
              <div class="mycelial-namer__actions">
                <button
                  class="app-modal__btn app-modal__btn--secondary"
                  onClick={() => setStopwordOpen(false)}
                >
                  Cancel
                </button>
                <button
                  class="app-modal__btn app-modal__btn--primary"
                  disabled={!stopwordDraft().trim()}
                  onClick={addArbitraryStopword}
                >
                  Add
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
