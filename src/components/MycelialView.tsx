/**
 * Mycelial View — visualizes the link graph around a note plus emergent
 * concept tendrils suggested by corpus statistics (TF-IDF + PMI).
 *
 * Replaces the former Flow View with an organic, mycelial-network-inspired
 * visualization that helps users discover where their knowledge graph
 * wants to grow next.
 */

import { createSignal, onMount, For, Show } from "solid-js";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import {
  computeMycelialLayout,
  type MycelialLayout,
  type LayoutNode,
  type TendrilLayout,
} from "../lib/mycelial-layout";

interface MycelialViewProps {
  path: string;
}

const NODE_WIDTH = 140;
const NODE_HEIGHT = 34;

export default function MycelialView(props: MycelialViewProps) {
  const [layout, setLayout] = createSignal<MycelialLayout | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [hoveredNode, setHoveredNode] = createSignal<string | null>(null);
  const [hoveredTendril, setHoveredTendril] = createSignal<string | null>(null);
  const [maxDepth, setMaxDepth] = createSignal(2);
  const [centerPath, setCenterPath] = createSignal(props.path);
  const [history, setHistory] = createSignal<string[]>([]);

  async function loadData(path?: string) {
    const targetPath = path ?? centerPath();
    setLoading(true);
    try {
      const data = await ipc.getMycelialData(targetPath, maxDepth());
      const computed = computeMycelialLayout(
        data.nodes,
        data.edges,
        data.emergent_concepts,
      );
      setLayout(computed);
    } catch (err) {
      console.error("Mycelial View: failed to load data", err);
    } finally {
      setLoading(false);
    }
  }

  onMount(() => loadData());

  function handleNodeClick(node: LayoutNode) {
    if (node.direction === "center") return;
    setHistory((h) => [...h, centerPath()]);
    setCenterPath(node.id);
    loadData(node.id);
  }

  function handleBack() {
    const h = history();
    if (h.length === 0) return;
    const prev = h[h.length - 1];
    setHistory(h.slice(0, -1));
    setCenterPath(prev);
    loadData(prev);
  }

  function handleTendrilClick(tendril: TendrilLayout) {
    // Create a new note with the emergent concept as title
    openTab({
      type: "file",
      title: tendril.term,
      path: tendril.term + ".typ",
    });
  }

  function handleDepthChange(e: Event) {
    const value = parseInt((e.target as HTMLSelectElement).value);
    setMaxDepth(value);
    loadData();
  }

  function nodeColor(direction: string): string {
    switch (direction) {
      case "center":
        return "var(--accent)";
      case "backlink":
        return "var(--flow-backlink, #4a9eff)";
      case "forward":
        return "var(--flow-forward, #4ecdc4)";
      default:
        return "var(--fg-dim)";
    }
  }

  function tendrilStrokeWidth(score: number): number {
    return 1 + score * 4;
  }

  function tendrilOpacity(score: number): number {
    return 0.3 + score * 0.5;
  }

  function tendrilDash(score: number): string {
    return score < 0.3 ? "4 2" : "none";
  }

  return (
    <div class="mycelial-view">
      <div class="mycelial-view__toolbar">
        <div class="mycelial-view__toolbar-left">
          <Show when={history().length > 0}>
            <button
              class="mycelial-view__back-btn"
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
            class="mycelial-view__refresh-btn"
            onClick={() => loadData()}
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      <div class="mycelial-view__canvas">
        <Show when={!loading() && layout()} fallback={<div class="mycelial-view__loading">Loading…</div>}>
          {(l) => {
            const data = l();
            return (
              <svg
                class="mycelial-view__svg"
                width={data.width}
                height={data.height}
                viewBox={`0 0 ${data.width} ${data.height}`}
              >
                {/* Edges */}
                <g class="mycelial-edges">
                  <For each={data.edges}>
                    {(edge) => (
                      <path
                        d={edge.path}
                        fill="none"
                        stroke="var(--border-primary)"
                        stroke-width="1.5"
                        opacity="0.5"
                      />
                    )}
                  </For>
                </g>

                {/* Tendrils */}
                <g class="mycelial-tendrils">
                  <For each={data.tendrils}>
                    {(tendril) => (
                      <g
                        class="mycelial-tendril"
                        onMouseEnter={() => setHoveredTendril(tendril.term)}
                        onMouseLeave={() => setHoveredTendril(null)}
                        onClick={() => handleTendrilClick(tendril)}
                      >
                        <path
                          d={tendril.path}
                          fill="none"
                          stroke="var(--mycelial-tendril, #8b7355)"
                          stroke-width={tendrilStrokeWidth(tendril.score)}
                          opacity={
                            hoveredTendril() === tendril.term
                              ? 1
                              : tendrilOpacity(tendril.score)
                          }
                          stroke-dasharray={tendrilDash(tendril.score)}
                          stroke-linecap="round"
                        />
                        <circle
                          cx={tendril.endX}
                          cy={tendril.endY}
                          r={4 + tendril.score * 3}
                          fill="var(--mycelial-tendril, #8b7355)"
                          opacity={
                            hoveredTendril() === tendril.term
                              ? 0.9
                              : 0.4 + tendril.score * 0.3
                          }
                        />
                        <text
                          x={tendril.labelX + 10}
                          y={tendril.labelY + 4}
                          class="mycelial-tendril__label"
                          opacity={
                            hoveredTendril() === tendril.term
                              ? 1
                              : 0.7
                          }
                        >
                          {tendril.term}
                        </text>
                      </g>
                    )}
                  </For>
                </g>

                {/* Nodes */}
                <g class="mycelial-nodes">
                  <For each={data.nodes}>
                    {(node) => (
                      <g
                        class="mycelial-node"
                        transform={`translate(${node.x}, ${node.y})`}
                        onMouseEnter={() => setHoveredNode(node.id)}
                        onMouseLeave={() => setHoveredNode(null)}
                        onClick={() => handleNodeClick(node)}
                        style={{ cursor: node.direction === "center" ? "default" : "pointer" }}
                      >
                        <rect
                          width={NODE_WIDTH}
                          height={NODE_HEIGHT}
                          rx={6}
                          ry={6}
                          fill={
                            hoveredNode() === node.id
                              ? nodeColor(node.direction)
                              : "var(--bg-primary)"
                          }
                          stroke={nodeColor(node.direction)}
                          stroke-width={node.direction === "center" ? 2 : 1.5}
                        />
                        <text
                          x={NODE_WIDTH / 2}
                          y={NODE_HEIGHT / 2}
                          text-anchor="middle"
                          dominant-baseline="middle"
                          fill={
                            hoveredNode() === node.id
                              ? "var(--bg-primary)"
                              : "var(--fg-primary)"
                          }
                          font-size="12"
                          font-family="var(--interface-font, sans-serif)"
                        >
                          {node.name.length > 18
                            ? node.name.slice(0, 17) + "…"
                            : node.name}
                        </text>
                      </g>
                    )}
                  </For>
                </g>

                {/* Tendril tooltip on hover */}
                <Show when={hoveredTendril()}>
                  {(term) => {
                    const tendril = data.tendrils.find((t) => t.term === term());
                    if (!tendril) return null;
                    const shownNotes = tendril.sourceNotes.slice(0, 4);
                    const noteLabels = shownNotes.map(
                      (n) => n.replace(/\.typ$/, "").split("/").pop() ?? n,
                    );
                    const longestLabel = Math.max(...noteLabels.map((l) => l.length), 0);
                    const tooltipWidth = Math.max(longestLabel * 6.5 + 16, 130);
                    const tooltipHeight = 20 + shownNotes.length * 14;
                    // Clamp tooltip position to stay within SVG bounds
                    const tx = Math.min(tendril.endX - 5, data.width - tooltipWidth - 8);
                    const ty = Math.min(tendril.endY + 14, data.height - tooltipHeight - 8);
                    return (
                      <g class="mycelial-tooltip">
                        <rect
                          x={tx}
                          y={ty}
                          width={tooltipWidth}
                          height={tooltipHeight}
                          rx={4}
                          fill="var(--popup-bg, var(--bg-secondary))"
                          stroke="var(--popup-border-color, var(--border-primary))"
                          stroke-width={0.5}
                          opacity={0.95}
                        />
                        <text
                          x={tx + 5}
                          y={ty + 14}
                          font-size="10"
                          fill="var(--fg-secondary)"
                          font-family="var(--interface-font, sans-serif)"
                        >
                          Found in {tendril.docCount} note{tendril.docCount > 1 ? "s" : ""}:
                        </text>
                        <For each={noteLabels}>
                          {(label, i) => (
                            <text
                              x={tx + 9}
                              y={ty + 28 + i() * 14}
                              font-size="9"
                              fill="var(--fg-dim)"
                              font-family="var(--interface-font, sans-serif)"
                            >
                              {label}
                            </text>
                          )}
                        </For>
                      </g>
                    );
                  }}
                </Show>
              </svg>
            );
          }}
        </Show>
      </div>

      <div class="mycelial-view__legend">
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--accent)" }}
          />
          Current
        </span>
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--flow-backlink, #4a9eff)" }}
          />
          Backlinks
        </span>
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--flow-forward, #4ecdc4)" }}
          />
          Forward
        </span>
        <span class="mycelial-view__legend-item">
          <span
            class="mycelial-view__legend-dot"
            style={{ background: "var(--mycelial-tendril, #8b7355)" }}
          />
          Emergent
        </span>
      </div>
    </div>
  );
}
