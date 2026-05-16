/**
 * Mycelial View — surfaces where a notebox wants to grow next.
 *
 * Unlike a link-graph browser, this view foregrounds two signals over a
 * note's neighborhood:
 *
 *  - **Latent links** — an existing page mentioned in other notes without a
 *    wikilink. Clicking one opens a picker of the mention sites so the user
 *    can go create the link (the editor deep-links to the exact spot).
 *  - **Emergent concepts** — a recurring phrase with no page of its own.
 *    Clicking one creates a new page seeded with the connections it emerged
 *    from, as a bulleted list of wikilinks.
 *
 * Existing wikilinked pages appear only as faint "anchor" notes for spatial
 * orientation — they are not the point of the view.
 */

import { createSignal, createMemo, onMount, For, Show } from "solid-js";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import type { LatentLink, SourceMention } from "../lib/types";
import {
  computeMycelialLayout,
  type MycelialLayout,
  type MycelialBox,
} from "../lib/mycelial-layout";

interface MycelialViewProps {
  path: string;
}

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3;
const PAN_STEP = 140;

/** Capitalize the first letter of each word, for a new page title. */
function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** Split a snippet around the first occurrence of `term` for highlighting. */
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

export default function MycelialView(props: MycelialViewProps) {
  const [layout, setLayout] = createSignal<MycelialLayout | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [hoveredBox, setHoveredBox] = createSignal<string | null>(null);
  const [maxDepth, setMaxDepth] = createSignal(2);
  const [centerPath, setCenterPath] = createSignal(props.path);
  const [history, setHistory] = createSignal<string[]>([]);

  // Viewport transform.
  const [zoom, setZoom] = createSignal(1);
  const [panX, setPanX] = createSignal(0);
  const [panY, setPanY] = createSignal(0);

  // Latent-link mention picker.
  const [picker, setPicker] = createSignal<{
    latent: LatentLink;
    x: number;
    y: number;
  } | null>(null);

  let canvasRef: HTMLDivElement | undefined;
  let drag: { x: number; y: number; px: number; py: number; moved: boolean } | null =
    null;

  function fitToView(l: MycelialLayout) {
    if (!canvasRef) return;
    const cw = canvasRef.clientWidth || 800;
    const ch = canvasRef.clientHeight || 600;
    const z = Math.min(cw / l.width, ch / l.height, 1) * 0.92;
    setZoom(Math.max(z, ZOOM_MIN));
    setPanX((cw - l.width * z) / 2);
    setPanY((ch - l.height * z) / 2);
  }

  async function loadData(path?: string) {
    const targetPath = path ?? centerPath();
    setLoading(true);
    setPicker(null);
    try {
      const data = await ipc.getMycelialData(targetPath, maxDepth());
      const computed = computeMycelialLayout(
        data.center,
        data.source_notes,
        data.context_notes,
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

  onMount(() => loadData());

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

  function handleDepthChange(e: Event) {
    setMaxDepth(parseInt((e.target as HTMLSelectElement).value));
    loadData();
  }

  // ---- Box interactions ---------------------------------------------------

  function handleBoxClick(box: MycelialBox, e: MouseEvent) {
    e.stopPropagation();
    if (box.kind === "emergent" && box.emergent) {
      createEmergentNote(box);
    } else if (box.kind === "latent" && box.latent) {
      const rect = canvasRef?.getBoundingClientRect();
      setPicker({
        latent: box.latent,
        x: e.clientX - (rect?.left ?? 0),
        y: e.clientY - (rect?.top ?? 0),
      });
    } else if (box.kind === "source" || box.kind === "context") {
      recenter(box.id);
    }
  }

  async function createEmergentNote(box: MycelialBox) {
    const concept = box.emergent;
    if (!concept) return;
    const title = titleCase(concept.term);
    const center = centerPath();
    const folder = center.includes("/")
      ? center.slice(0, center.lastIndexOf("/"))
      : "";
    const bullets = concept.mentions
      .map((m) => `- #wikilink(${JSON.stringify(m.name)})`)
      .join("\n");
    const body =
      `#note(title: ${JSON.stringify(title)})\n\n` +
      `= ${title}\n\n` +
      `== Emerged from\n\n` +
      `This page emerged from a concept recurring across these notes:\n\n` +
      `${bullets}\n`;
    try {
      const newPath = await ipc.createNote(title, folder, body);
      openTab(
        { type: "file", title, path: newPath },
        { forceNewTab: true },
      );
    } catch (err) {
      console.error("Mycelial View: failed to create emergent note", err);
    }
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

  // ---- Viewport (pan / zoom) ---------------------------------------------

  function zoomBy(factor: number, cx?: number, cy?: number) {
    if (!canvasRef) return;
    const rect = canvasRef.getBoundingClientRect();
    const mx = cx ?? rect.width / 2;
    const my = cy ?? rect.height / 2;
    const next = Math.min(Math.max(zoom() * factor, ZOOM_MIN), ZOOM_MAX);
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
    drag = { x: e.clientX, y: e.clientY, px: panX(), py: panY(), moved: false };
  }

  function onCanvasMouseMove(e: MouseEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    setPanX(drag.px + dx);
    setPanY(drag.py + dy);
  }

  function onCanvasMouseUp() {
    drag = null;
  }

  function onCanvasClick() {
    // A click that wasn't a drag dismisses the picker.
    if (!drag?.moved) setPicker(null);
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

  // ---- Hover highlighting -------------------------------------------------

  // Adjacency over mycelial connections, so hovering a box can keep the
  // boxes its paths reach visible instead of dimming the whole view.
  const adjacency = createMemo(() => {
    const m = new Map<string, Set<string>>();
    const l = layout();
    if (!l) return m;
    for (const c of l.connections) {
      (m.get(c.from) ?? m.set(c.from, new Set()).get(c.from)!).add(c.to);
      (m.get(c.to) ?? m.set(c.to, new Set()).get(c.to)!).add(c.from);
    }
    return m;
  });

  /** A box dims only when something else is hovered and it isn't connected. */
  function boxDimmed(id: string): boolean {
    const h = hoveredBox();
    if (h === null || h === id) return false;
    return !(adjacency().get(h)?.has(id) ?? false);
  }

  function connectionActive(from: string, to: string): boolean {
    const h = hoveredBox();
    return h === null || h === from || h === to;
  }

  function strokeWidth(score: number): number {
    return 1.2 + score * 3.5;
  }

  return (
    <div class="mycelial-view">
      <div class="mycelial-view__toolbar">
        <div class="mycelial-view__toolbar-left">
          <Show when={history().length > 0}>
            <button
              class="mycelial-view__btn"
              onClick={handleBack}
              title="Back"
            >
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
          <label class="mycelial-view__depth-label">
            Depth
            <select
              class="mycelial-view__depth-select"
              value={maxDepth()}
              onChange={handleDepthChange}
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </label>
          <button
            class="mycelial-view__btn"
            onClick={() => loadData()}
            title="Refresh"
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
          {(l) => {
            const data = l();
            return (
              <svg class="mycelial-view__svg" width="100%" height="100%">
                <g
                  transform={`translate(${panX()}, ${panY()}) scale(${zoom()})`}
                >
                  {/* Connections */}
                  <g class="mycelial-connections">
                    <For each={data.connections}>
                      {(conn) => {
                        const active = () =>
                          connectionActive(conn.from, conn.to);
                        const color =
                          conn.kind === "emergent"
                            ? "var(--mycelial-emergent, #9a7b4f)"
                            : conn.kind === "latent"
                              ? "var(--mycelial-latent, #c08a3e)"
                              : "var(--border-primary)";
                        return (
                          <path
                            d={conn.path}
                            fill="none"
                            stroke={color}
                            stroke-width={
                              conn.kind === "anchor"
                                ? 1.2
                                : strokeWidth(conn.score)
                            }
                            stroke-linecap="round"
                            stroke-dasharray={
                              conn.kind === "latent" ? "5 4" : "none"
                            }
                            opacity={
                              conn.kind === "anchor"
                                ? active()
                                  ? 0.4
                                  : 0.15
                                : active()
                                  ? 0.85
                                  : 0.25
                            }
                          />
                        );
                      }}
                    </For>
                  </g>

                  {/* Boxes */}
                  <For each={data.boxes}>
                    {(box) => (
                      <foreignObject
                        x={box.x}
                        y={box.y}
                        width={box.w}
                        height={box.h}
                        onMouseEnter={() => setHoveredBox(box.id)}
                        onMouseLeave={() => setHoveredBox(null)}
                      >
                        <div
                          class={`mycelial-box mycelial-box--${box.kind}`}
                          classList={{
                            "mycelial-box--dim": boxDimmed(box.id),
                          }}
                          style={{
                            width: `${box.w}px`,
                            height: `${box.h}px`,
                          }}
                          onClick={(e) => handleBoxClick(box, e)}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <Show
                            when={
                              box.kind === "latent" || box.kind === "emergent"
                            }
                            fallback={
                              <div class="mycelial-box__note-title">
                                {box.title}
                              </div>
                            }
                          >
                            <div class="mycelial-box__concept">
                              {box.title}
                            </div>
                            <div class="mycelial-box__subtitle">
                              {box.subtitle}
                            </div>
                            <Show when={box.snippet}>
                              <div class="mycelial-box__snippet">
                                <For
                                  each={highlightParts(
                                    box.snippet,
                                    box.latent
                                      ? box.latent.term
                                      : (box.emergent?.term ?? ""),
                                  )}
                                >
                                  {(part) => (
                                    <span
                                      classList={{
                                        "mycelial-box__hit": part.hit,
                                      }}
                                    >
                                      {part.text}
                                    </span>
                                  )}
                                </For>
                              </div>
                            </Show>
                            <div class="mycelial-box__source">
                              {box.sourceLabel}
                            </div>
                          </Show>
                        </div>
                      </foreignObject>
                    )}
                  </For>
                </g>
              </svg>
            );
          }}
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
          <div class="mycelial-controls__zoom">
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
                Link “{p().latent.term}” → {p().latent.target_name}
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
                          <span
                            classList={{ "mycelial-box__hit": part.hit }}
                          >
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
      </div>

      <div class="mycelial-view__legend">
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--accent)" }}
          />
          Current note
        </span>
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--mycelial-latent, #c08a3e)" }}
          />
          Latent link
        </span>
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--mycelial-emergent, #9a7b4f)" }}
          />
          Emergent concept
        </span>
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--fg-secondary)" }}
          />
          Source note
        </span>
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--border-primary)" }}
          />
          Linked context
        </span>
      </div>
    </div>
  );
}
