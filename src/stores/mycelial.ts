import { createSignal } from "solid-js";
import type { ExcludedTerm, FlowEdge } from "../lib/types";

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
// Terms the stopword filter suppressed, published by MycelialView when it loads
// data so the right-panel Concept Filtering pane can render and rescue them.
const [excludedTerms, setExcludedTerms] = createSignal<ExcludedTerm[]>([]);

/** Ask the active Mycelial View to recompute (after a stopword/rescue edit).
 *  MycelialView listens for this event and calls its loadData(). */
export function requestMycelialReload() {
  document.dispatchEvent(new CustomEvent("inkycap:mycelial-reload"));
}

export {
  contextNotes,
  setContextNotes,
  contextEdges,
  setContextEdges,
  hoveredGraphNode,
  setHoveredGraphNode,
  hoveredContextNote,
  setHoveredContextNote,
  excludedTerms,
  setExcludedTerms,
};
