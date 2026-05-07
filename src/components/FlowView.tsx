import { Component, createSignal, onMount, Show, For } from "solid-js";
import * as ipc from "../lib/ipc";
import {
  computeFlowLayout,
  NODE_WIDTH,
  NODE_HEIGHT,
} from "../lib/flow-layout";
import type { FlowData } from "../lib/types";
import type { LayoutNode, LayoutEdge, FlowLayout } from "../lib/flow-layout";
import { openTab } from "../stores/tabs";

interface FlowViewProps {
  path: string;
}

const FlowView: Component<FlowViewProps> = (props) => {
  const [layout, setLayout] = createSignal<FlowLayout | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [hoveredNode, setHoveredNode] = createSignal<string | null>(null);
  const [maxDepth, setMaxDepth] = createSignal(2);

  const loadFlowData = async () => {
    setLoading(true);
    try {
      const data = await ipc.getFlowData(props.path, maxDepth());
      const computed = computeFlowLayout(data.nodes, data.edges);
      setLayout(computed);
    } catch (e) {
      console.error("Failed to load flow data:", e);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    loadFlowData();
  });

  const handleNodeClick = (node: LayoutNode) => {
    const name =
      node.name || node.id.split("/").pop()?.replace(/\.[^.]+$/, "") || "Note";
    openTab({ type: "file", title: name, path: node.id });
  };

  const handleDepthChange = (depth: number) => {
    setMaxDepth(depth);
    loadFlowData();
  };

  const nodeColor = (direction: string): string => {
    switch (direction) {
      case "center":
        return "var(--accent)";
      case "backlink":
        return "var(--flow-backlink, #4a9eff)";
      case "forward":
        return "var(--flow-forward, #4ecdc4)";
      default:
        return "var(--text-secondary)";
    }
  };

  const renderEdge = (edge: LayoutEdge) => {
    // Bezier curve for smooth edges
    const dx = edge.targetX - edge.sourceX;
    const controlOffset = Math.abs(dx) * 0.4;
    const path = `M ${edge.sourceX} ${edge.sourceY} C ${edge.sourceX + controlOffset} ${edge.sourceY}, ${edge.targetX - controlOffset} ${edge.targetY}, ${edge.targetX} ${edge.targetY}`;

    const isHighlighted =
      hoveredNode() === edge.source || hoveredNode() === edge.target;

    return (
      <path
        d={path}
        fill="none"
        stroke={
          isHighlighted
            ? "var(--accent)"
            : "var(--border-primary)"
        }
        stroke-width={isHighlighted ? 2.5 : 1.5}
        opacity={isHighlighted ? 1 : 0.5}
      />
    );
  };

  const renderNode = (node: LayoutNode) => {
    const isHovered = hoveredNode() === node.id;
    const isCenter = node.direction === "center";

    return (
      <g
        class="flow-node"
        transform={`translate(${node.x}, ${node.y})`}
        onMouseEnter={() => setHoveredNode(node.id)}
        onMouseLeave={() => setHoveredNode(null)}
        onClick={() => handleNodeClick(node)}
        style={{ cursor: "pointer" }}
      >
        <rect
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={6}
          ry={6}
          fill={isCenter || isHovered ? nodeColor(node.direction) : "var(--bg-primary)"}
          stroke={nodeColor(node.direction)}
          stroke-width={isCenter ? 2 : 1.5}
          opacity={isHovered ? 1 : 0.9}
        />
        <text
          x={NODE_WIDTH / 2}
          y={NODE_HEIGHT / 2 + 1}
          text-anchor="middle"
          dominant-baseline="middle"
          fill={isCenter || isHovered ? "var(--bg-primary)" : "var(--fg-primary)"}
          font-size="13"
          font-family="var(--font-interface, sans-serif)"
        >
          {node.name.length > 20
            ? node.name.substring(0, 18) + "..."
            : node.name}
        </text>
      </g>
    );
  };

  return (
    <div class="flow-view">
      <div class="flow-view__toolbar">
        <span class="flow-view__title">Flow View</span>
        <div class="flow-view__controls">
          <label>
            Depth:
            <select
              value={maxDepth()}
              onChange={(e) =>
                handleDepthChange(parseInt(e.currentTarget.value))
              }
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </label>
          <button class="flow-view__refresh" onClick={loadFlowData}>
            Refresh
          </button>
        </div>
      </div>

      <div class="flow-view__canvas">
        <Show
          when={!loading()}
          fallback={<p class="flow-view__loading">Loading flow data...</p>}
        >
          <Show
            when={layout() && layout()!.nodes.length > 0}
            fallback={
              <p class="flow-view__empty">
                No links found for this note.
              </p>
            }
          >
            <svg
              width={layout()!.width}
              height={layout()!.height}
              viewBox={`0 0 ${layout()!.width} ${layout()!.height}`}
              class="flow-view__svg"
            >
              {/* Edges first (behind nodes) */}
              <g class="flow-edges">
                <For each={layout()!.edges}>{(edge) => renderEdge(edge)}</For>
              </g>
              {/* Nodes on top */}
              <g class="flow-nodes">
                <For each={layout()!.nodes}>{(node) => renderNode(node)}</For>
              </g>
            </svg>
          </Show>
        </Show>
      </div>

      <div class="flow-view__legend">
        <span class="flow-view__legend-item">
          <span
            class="flow-view__legend-dot"
            style={{ background: "var(--flow-backlink, #4a9eff)" }}
          />
          Backlinks
        </span>
        <span class="flow-view__legend-item">
          <span
            class="flow-view__legend-dot"
            style={{ background: "var(--accent)" }}
          />
          Current
        </span>
        <span class="flow-view__legend-item">
          <span
            class="flow-view__legend-dot"
            style={{ background: "var(--flow-forward, #4ecdc4)" }}
          />
          Forward Links
        </span>
      </div>
    </div>
  );
};

export default FlowView;
