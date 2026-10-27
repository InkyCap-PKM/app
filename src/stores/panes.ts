import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

/**
 * Pane layout for the editor area.
 *
 * The editor area is a tree of panes. A `SplitNode` lays out its children in a
 * row (side by side) or column (stacked); a `LeafPane` is a tab group showing
 * one tab at a time. One leaf is focused: new tabs open there, tab-switching
 * keys act on it, and its active tab drives the right panel.
 *
 * This module holds only layout and stores tab ids; the `Tab` objects and
 * opening and closing live in `stores/tabs.ts`, which calls in here.
 *
 * The layout isn't saved; switching notebox resets it to one empty leaf
 * (`resetToSingleEmptyLeaf`).
 */

export type SplitDirection = "row" | "column";

export interface SplitNode {
  kind: "split";
  id: string;
  direction: SplitDirection;
  children: PaneNode[];
  /** Fractions (sum ≈ 1), one per child, controlling each child's size. */
  sizes: number[];
}

export interface LeafPane {
  kind: "leaf";
  id: string;
  /** This pane's tab strip, in display order. */
  tabIds: string[];
  /** Which tab this pane currently shows. */
  activeTabId: string | null;
}

export type PaneNode = SplitNode | LeafPane;

let nextPaneId = 1;
function newPaneId(): string {
  return `pane-${nextPaneId++}`;
}

function makeLeaf(tabId?: string): LeafPane {
  return {
    kind: "leaf",
    id: newPaneId(),
    tabIds: tabId ? [tabId] : [],
    activeTabId: tabId ?? null,
  };
}

/**
 * Deep-copy a subtree into plain objects, for moving a node within the tree
 * (Solid's `produce` rejects re-parenting a store proxy). Ids are kept, so
 * focus and tab lookups still work.
 */
function clone(n: PaneNode): PaneNode {
  return n.kind === "leaf"
    ? { kind: "leaf", id: n.id, tabIds: [...n.tabIds], activeTabId: n.activeTabId }
    : {
        kind: "split",
        id: n.id,
        direction: n.direction,
        children: n.children.map(clone),
        sizes: [...n.sizes],
      };
}

const initialLeaf = makeLeaf();
const [panes, setPanes] = createStore<{ root: PaneNode }>({ root: initialLeaf });
const [focusedPaneId, setFocusedPaneId] = createSignal<string>(initialLeaf.id);

// ── Tree traversal helpers (operate on either the live store or a draft) ──

interface Located {
  parent: SplitNode | null;
  index: number;
  leaf: LeafPane;
}

/** Find a leaf by id, along with its parent split and slot index. */
function locateLeaf(
  node: PaneNode,
  leafId: string,
  parent: SplitNode | null = null,
  index = -1,
): Located | undefined {
  if (node.kind === "leaf") {
    return node.id === leafId ? { parent, index, leaf: node } : undefined;
  }
  for (let i = 0; i < node.children.length; i++) {
    const r = locateLeaf(node.children[i], leafId, node, i);
    if (r) return r;
  }
  return undefined;
}

/** Find any node (split or leaf) by id, with its parent and slot index. */
function locateNode(
  node: PaneNode,
  nodeId: string,
  parent: SplitNode | null = null,
  index = -1,
): { parent: SplitNode | null; index: number; node: PaneNode } | undefined {
  if (node.id === nodeId) return { parent, index, node };
  if (node.kind === "split") {
    for (let i = 0; i < node.children.length; i++) {
      const r = locateNode(node.children[i], nodeId, node, i);
      if (r) return r;
    }
  }
  return undefined;
}

function findLeafContaining(node: PaneNode, tabId: string): LeafPane | undefined {
  if (node.kind === "leaf") return node.tabIds.includes(tabId) ? node : undefined;
  for (const c of node.children) {
    const r = findLeafContaining(c, tabId);
    if (r) return r;
  }
  return undefined;
}

function firstLeafOf(node: PaneNode): LeafPane {
  let n: PaneNode = node;
  while (n.kind === "split") n = n.children[0];
  return n;
}

function collectLeaves(node: PaneNode, out: LeafPane[]): void {
  if (node.kind === "leaf") out.push(node);
  else node.children.forEach((c) => collectLeaves(c, out));
}

function renormalize(sizes: number[]): void {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const eq = 1 / sizes.length;
    for (let i = 0; i < sizes.length; i++) sizes[i] = eq;
  } else {
    for (let i = 0; i < sizes.length; i++) sizes[i] = sizes[i] / sum;
  }
}

// ── Read accessors (reactive when called inside a tracking scope) ──

/** All leaf panes, left-to-right / top-to-bottom. */
export function allLeaves(): LeafPane[] {
  const out: LeafPane[] = [];
  collectLeaves(panes.root, out);
  return out;
}

/** The focused leaf, falling back to the first leaf if the focused id is
 *  stale (e.g. its pane was just collapsed). */
export function focusedLeaf(): LeafPane {
  const r = locateLeaf(panes.root, focusedPaneId());
  return r ? r.leaf : firstLeafOf(panes.root);
}

export function leafForTab(tabId: string): LeafPane | undefined {
  return findLeafContaining(panes.root, tabId);
}

export function leafById(leafId: string): LeafPane | undefined {
  return locateLeaf(panes.root, leafId)?.leaf;
}

/**
 * The focused leaf's active tab id, the app's "active tab". Reactive wherever
 * it's called.
 */
export function focusedActiveTabId(): string | null {
  return focusedLeaf().activeTabId;
}

// ── Mutations ──

export function focusPane(id: string): void {
  setFocusedPaneId(id);
}

/** Move focus to the next (`dir === 1`) or previous (`dir === -1`) leaf,
 *  wrapping around. No-op with fewer than two panes. */
export function focusAdjacentPane(dir: 1 | -1): void {
  const leaves = allLeaves();
  if (leaves.length < 2) return;
  const cur = leaves.findIndex((l) => l.id === focusedPaneId());
  const next = (cur + dir + leaves.length) % leaves.length;
  setFocusedPaneId(leaves[next].id);
}

export function setLeafActiveTab(leafId: string, tabId: string | null): void {
  setPanes(
    produce((s) => {
      const r = locateLeaf(s.root, leafId);
      if (r) r.leaf.activeTabId = tabId;
    }),
  );
}

/** Set a tab active in whichever leaf owns it, and focus that leaf. */
export function activateTab(tabId: string): void {
  const leaf = leafForTab(tabId);
  if (!leaf) return;
  setLeafActiveTab(leaf.id, tabId);
  setFocusedPaneId(leaf.id);
}

/** Append a tab to the focused leaf, optionally making it active. */
export function addTabToFocusedLeaf(tabId: string, activate = true): void {
  const leafId = focusedLeaf().id;
  setPanes(
    produce((s) => {
      const r = locateLeaf(s.root, leafId);
      if (!r) return;
      if (!r.leaf.tabIds.includes(tabId)) r.leaf.tabIds.push(tabId);
      if (activate) r.leaf.activeTabId = tabId;
    }),
  );
}

/**
 * Remove a tab id from its leaf, making a neighbour active. An emptied leaf is
 * removed unless it's the only pane. Returns whether no tabs remain anywhere,
 * so `closeTab` can open an empty tab.
 */
export function removeTab(tabId: string): { workspaceEmptied: boolean } {
  let workspaceEmptied = false;
  setPanes(
    produce((s) => {
      const leaf = findLeafContaining(s.root, tabId);
      if (!leaf) return;
      const idx = leaf.tabIds.indexOf(tabId);
      if (idx !== -1) leaf.tabIds.splice(idx, 1);
      if (leaf.activeTabId === tabId) {
        leaf.activeTabId =
          leaf.tabIds[Math.min(idx, leaf.tabIds.length - 1)] ?? null;
      }
      if (leaf.tabIds.length === 0) {
        const leaves: LeafPane[] = [];
        collectLeaves(s.root, leaves);
        if (leaves.length === 1) {
          workspaceEmptied = true; // sole pane emptied; caller refills it
        } else {
          removeLeafFromTree(s, leaf.id);
        }
      }
    }),
  );
  return { workspaceEmptied };
}

/** Remove an (empty) leaf and collapse any now-single-child split above it.
 *  Runs inside a `produce` draft. */
function removeLeafFromTree(s: { root: PaneNode }, leafId: string): void {
  const r = locateLeaf(s.root, leafId);
  if (!r || !r.parent) return; // never remove the sole root leaf
  const parent = r.parent;
  parent.children.splice(r.index, 1);
  parent.sizes.splice(r.index, 1);
  renormalize(parent.sizes);

  // A split with one remaining child is redundant — replace it with that
  // child so the layout doesn't accrue useless single-child wrappers.
  if (parent.children.length === 1) {
    const only = clone(parent.children[0]);
    const at = locateNode(s.root, parent.id);
    if (at) {
      if (at.parent === null) s.root = only;
      else at.parent.children[at.index] = only;
    }
  }

  // If the focused pane was just removed, move focus to a surviving leaf.
  if (!locateLeaf(s.root, focusedPaneId())) {
    setFocusedPaneId(firstLeafOf(s.root).id);
  }
}

/**
 * Split a leaf along `direction`, putting `newTabId` in the new half and
 * focusing it. Returns the new leaf's id.
 */
export function splitLeaf(
  leafId: string,
  direction: SplitDirection,
  newTabId: string | null,
): string | null {
  const newLeaf = makeLeaf(newTabId ?? undefined);
  let ok = false;
  setPanes(
    produce((s) => {
      const r = locateLeaf(s.root, leafId);
      if (!r) return;
      const split: SplitNode = {
        kind: "split",
        id: newPaneId(),
        direction,
        children: [clone(r.leaf), newLeaf],
        sizes: [0.5, 0.5],
      };
      if (r.parent === null) s.root = split;
      else r.parent.children[r.index] = split;
      ok = true;
    }),
  );
  if (!ok) return null;
  setFocusedPaneId(newLeaf.id);
  return newLeaf.id;
}

/** Reorder a tab within a single leaf's strip. */
export function moveTabWithinLeaf(leafId: string, from: number, to: number): void {
  setPanes(
    produce((s) => {
      const r = locateLeaf(s.root, leafId);
      if (!r) return;
      const ids = r.leaf.tabIds;
      if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to)
        return;
      const [m] = ids.splice(from, 1);
      ids.splice(to, 0, m);
    }),
  );
}

/**
 * Move a tab to another leaf (drag between panes): insert it at `index`
 * (default: end), make it active, focus the target, and remove the source pane
 * if it empties. Within one leaf this reorders.
 */
export function moveTab(tabId: string, targetLeafId: string, index?: number): void {
  setPanes(
    produce((s) => {
      const src = findLeafContaining(s.root, tabId);
      const tgtR = locateLeaf(s.root, targetLeafId);
      if (!src || !tgtR) return;
      const tgt = tgtR.leaf;
      const fromIdx = src.tabIds.indexOf(tabId);

      if (src.id === tgt.id) {
        const to = index ?? src.tabIds.length - 1;
        moveTabWithinLeafDraft(src, fromIdx, Math.min(to, src.tabIds.length - 1));
        return;
      }

      if (fromIdx !== -1) src.tabIds.splice(fromIdx, 1);
      if (src.activeTabId === tabId) {
        src.activeTabId =
          src.tabIds[Math.min(fromIdx, src.tabIds.length - 1)] ?? null;
      }
      const at = index ?? tgt.tabIds.length;
      tgt.tabIds.splice(Math.max(0, Math.min(at, tgt.tabIds.length)), 0, tabId);
      tgt.activeTabId = tabId;

      if (src.tabIds.length === 0) {
        const leaves: LeafPane[] = [];
        collectLeaves(s.root, leaves);
        if (leaves.length > 1) removeLeafFromTree(s, src.id);
      }
    }),
  );
  setFocusedPaneId(targetLeafId);
}

function moveTabWithinLeafDraft(leaf: LeafPane, from: number, to: number): void {
  if (from < 0 || from >= leaf.tabIds.length || to < 0 || from === to) return;
  const [m] = leaf.tabIds.splice(from, 1);
  leaf.tabIds.splice(to, 0, m);
}

/**
 * Resize the two children on either side of divider `dividerIndex` (the
 * resizer's drag). `delta` is a fraction of the split's size; neither child
 * goes below `min`.
 */
export function resizeSplit(
  splitId: string,
  dividerIndex: number,
  delta: number,
  min = 0.08,
): void {
  setPanes(
    produce((s) => {
      const at = locateNode(s.root, splitId);
      if (!at || at.node.kind !== "split") return;
      const sizes = at.node.sizes;
      const a = dividerIndex;
      const b = dividerIndex + 1;
      if (b >= sizes.length) return;
      let d = delta;
      d = Math.max(d, min - sizes[a]);
      d = Math.min(d, sizes[b] - min);
      sizes[a] += d;
      sizes[b] -= d;
    }),
  );
}

/** Reset to a single empty leaf. Used on notebox switch so panes from the
 *  previous notebox don't linger. The caller refills the leaf with a tab. */
export function resetToSingleEmptyLeaf(): void {
  const leaf = makeLeaf();
  setPanes(produce((s) => (s.root = leaf)));
  setFocusedPaneId(leaf.id);
}

/** True when more than one pane exists (drives "Close pane" affordances). */
export function hasMultiplePanes(): boolean {
  return allLeaves().length > 1;
}

export { panes, focusedPaneId };
