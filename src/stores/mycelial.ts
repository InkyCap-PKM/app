import { createSignal } from "solid-js";
import type { FlowEdge } from "../lib/types";

export interface MycelialContextNote {
  path: string;
  name: string;
  /** IDs of inner graph nodes this context note links to/from. */
  linkedInnerIds: string[];
}

const [contextNotes, setContextNotes] = createSignal<MycelialContextNote[]>([]);
const [contextEdges, setContextEdges] = createSignal<FlowEdge[]>([]);
const [hoveredGraphNode, setHoveredGraphNode] = createSignal<string | null>(null);
const [hoveredContextNote, setHoveredContextNote] = createSignal<string | null>(null);

export {
  contextNotes,
  setContextNotes,
  contextEdges,
  setContextEdges,
  hoveredGraphNode,
  setHoveredGraphNode,
  hoveredContextNote,
  setHoveredContextNote,
};
