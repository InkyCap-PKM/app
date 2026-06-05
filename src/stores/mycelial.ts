import { createSignal } from "solid-js";
import type { ExcludedTerm } from "../lib/types";

export interface MycelialContextNote {
  path: string;
  name: string;
  /** IDs of inner graph nodes this context note links to/from. */
  linkedInnerIds: string[];
}

/** The graph state a Mycelial View publishes for the right panel to read: its
 *  context-note list and the terms the stopword filter suppressed. */
export interface MycelialPublished {
  contextNotes: MycelialContextNote[];
  excludedTerms: ExcludedTerm[];
}

const EMPTY_PUBLISHED: MycelialPublished = { contextNotes: [], excludedTerms: [] };

// Published state keyed by the owning tab id. Several Mycelial View tabs can be
// open at once (split panes); a single global signal let them clobber each
// other, so the right panel showed whichever view rendered last. Keying by tab
// id lets the panel resolve the *focused* tab's slice — mirroring the editor
// view registry in stores/editor.ts.
const [publishedByTab, setPublishedByTab] = createSignal<Record<string, MycelialPublished>>({});

/** Publish a Mycelial View's current context/excluded-term state under its tab
 *  id, for the right panel to read. */
export function publishMycelialState(tabId: string, state: MycelialPublished): void {
  setPublishedByTab((prev) => ({ ...prev, [tabId]: state }));
}

/** Drop a tab's published state when its Mycelial View unmounts. */
export function clearMycelialState(tabId: string): void {
  setPublishedByTab((prev) => {
    if (!(tabId in prev)) return prev;
    const next = { ...prev };
    delete next[tabId];
    return next;
  });
}

/** The state published by the given tab's Mycelial View — empty when the tab
 *  isn't a mycelial view or hasn't loaded yet. */
export function mycelialStateFor(tabId: string | null | undefined): MycelialPublished {
  return (tabId ? publishedByTab()[tabId] : undefined) ?? EMPTY_PUBLISHED;
}

// Transient hover coordination between the graph and the right-panel context
// list. Only the focused view's panel is ever shown, so this stays global.
const [hoveredGraphNode, setHoveredGraphNode] = createSignal<string | null>(null);
const [hoveredContextNote, setHoveredContextNote] = createSignal<string | null>(null);

/** Ask the active Mycelial View to recompute (after a stopword/rescue edit).
 *  MycelialView listens for this event and calls its loadData(). */
export function requestMycelialReload() {
  document.dispatchEvent(new CustomEvent("inkycap:mycelial-reload"));
}

export {
  hoveredGraphNode,
  setHoveredGraphNode,
  hoveredContextNote,
  setHoveredContextNote,
};
