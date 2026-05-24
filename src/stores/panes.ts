import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

/**
 * Pane-layout state for the editor area.
 *
 * The editor area is a recursive tree of panes. A `SplitNode` lays its
 * children out in a row (vertical dividers, side-by-side) or column
 * (horizontal dividers, stacked); a `LeafPane` is a tab group that shows
 * one of its tabs at a time. Exactly one leaf is *focused* — that's where
 * newly-opened tabs land, where keyboard tab-switching applies, and whose
 * active tab drives the right panel.
 *
 * This module owns layout only: it stores tab *ids*, never `Tab` objects.
 * The flat registry of `Tab` objects and the open/close orchestration live
 * in `stores/tabs.ts`, which drives these operations. Keeping the two apart
 * avoids an import cycle and keeps each file to one responsibility.
 *
 * Layout is session-only — it is never serialized to disk, and a notebox
 * switch resets the tree to a single empty leaf (`resetToSingleEmptyLeaf`).
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

/** Deep-clone a subtree into plain objects. Used whenever a node is moved
 *  to a new position in the tree, so we never re-parent a live store proxy
 *  (which Solid's `produce` would reject). Ids are preserved, so focus and
 *  tab lookups stay stable across the move. */
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

/** The active tab id of the focused leaf — the app's single "active tab".
 *  A plain accessor: reactive wherever it's called (it reads the focus
 *  signal and the pane store), without a module-scope memo. */
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
 * Remove a tab id from whatever leaf holds it. Re-points that leaf's active
 * tab to a neighbour. If the leaf empties and it isn't the only pane, the
 * pane is removed and the tree collapses. Returns whether the entire
 * workspace is now tab-less, so the caller (`closeTab`) can honour the
 * "always at least one tab" invariant by spawning an empty tab.
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
 * Split a leaf in two along `direction`, placing `newTabId` in the new
 * sibling and focusing it. The new pane takes half the original's slot.
 * Returns the new leaf's id.
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
 * Move a tab to another leaf (cross-pane drag). Removes it from its current
 * leaf, inserts it into `targetLeafId` at `index` (default: end), makes it
 * active there, focuses the target, and collapses the source pane if it
 * empties. A move within the same leaf reorders instead.
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

/** Adjust the two adjacent children straddling divider `dividerIndex` in a
 *  split (the resizer's drag handler). `delta` is a fraction of the split's
 *  extent, clamped so neither child shrinks below `min`. */
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
