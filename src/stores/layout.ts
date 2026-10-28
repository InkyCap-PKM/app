// Layout store: panel widths and collapsed state, saved in localStorage (UI
// preferences that don't need the backend).

import { createSignal } from "solid-js";

const STORAGE_KEY = "inkycap.layout";

export type RightPanelTab =
  | "properties"
  | "outline"
  | "links"
  | "references"
  | "scroll-context"
  | "annotations"
  | "package-reference"
  // A panel id contributed at runtime (plugin, external tool); `(string & {})`
  // keeps autocomplete for the built-in names. These aren't in
  // BUILT_IN_RIGHT_PANEL_TABS, so they aren't restored on reload (the
  // contribution registers again; a stale id would show nothing).
  | (string & {});

const BUILT_IN_RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
  "properties",
  "outline",
  "links",
  "references",
  "scroll-context",
  "annotations",
  "package-reference",
];

/// Right panel tabs for a Collection View. Separate from `RightPanelTab` (for
/// notes), so switching between a note and a collection never leaves the panel
/// on a tab that doesn't apply.
export type CollectionPanelTab = "export" | "appearance" | "book" | "collection";

const COLLECTION_PANEL_TABS: readonly CollectionPanelTab[] = [
  "export",
  "appearance",
  "book",
  "collection",
];

/// Which count the status bar shows. Both share one slot and toggle on click
/// (see StatusBar); saved across reloads.
export type StatusCountMode = "words" | "chars";

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightPanelTab: RightPanelTab;
  collectionPanelTab: CollectionPanelTab;
  statusCountMode: StatusCountMode;
}

const DEFAULTS: LayoutState = {
  leftWidth: 240,
  rightWidth: 280,
  leftCollapsed: false,
  rightCollapsed: false,
  rightPanelTab: "outline",
  collectionPanelTab: "export",
  statusCountMode: "words",
};

const MIN_WIDTH = 160;
const MAX_WIDTH = 600;

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...parsed };
    // "scroll-context" and "annotations" exist only in context (a scroll
    // session; a note with annotations or collaboration). Never restore them at
    // startup, or the pane would show with nothing behind it.
    if (
      !BUILT_IN_RIGHT_PANEL_TABS.includes(merged.rightPanelTab) ||
      merged.rightPanelTab === "scroll-context" ||
      merged.rightPanelTab === "annotations"
    ) {
      merged.rightPanelTab = DEFAULTS.rightPanelTab;
    }
    if (!COLLECTION_PANEL_TABS.includes(merged.collectionPanelTab)) {
      merged.collectionPanelTab = DEFAULTS.collectionPanelTab;
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(state: LayoutState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* no-op: localStorage may be unavailable in some webview contexts */
  }
}

const initial = load();

const [leftWidth, setLeftWidthInternal] = createSignal(initial.leftWidth);
const [rightWidth, setRightWidthInternal] = createSignal(initial.rightWidth);
const [leftCollapsed, setLeftCollapsedInternal] = createSignal(
  initial.leftCollapsed,
);
const [rightCollapsed, setRightCollapsedInternal] = createSignal(
  initial.rightCollapsed,
);
const [rightPanelTab, setRightPanelTabInternal] = createSignal<RightPanelTab>(
  initial.rightPanelTab,
);
const [collectionPanelTab, setCollectionPanelTabInternal] =
  createSignal<CollectionPanelTab>(initial.collectionPanelTab);
// Distraction-free mode hides the vertical toolbar, both sidebars, the tab
// strip and the status bar (leaving its floating exit button), keeping the
// editor toolbar and content. Not saved: every launch starts in the regular
// layout.
const [distractionFree, setDistractionFreeInternal] = createSignal(false);
const [statusCountMode, setStatusCountModeInternal] =
  createSignal<StatusCountMode>(initial.statusCountMode);

function persist() {
  save({
    leftWidth: leftWidth(),
    rightWidth: rightWidth(),
    leftCollapsed: leftCollapsed(),
    rightCollapsed: rightCollapsed(),
    rightPanelTab: rightPanelTab(),
    collectionPanelTab: collectionPanelTab(),
    statusCountMode: statusCountMode(),
  });
}

export function setLeftWidth(w: number) {
  setLeftWidthInternal(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)));
  persist();
}

export function setRightWidth(w: number) {
  setRightWidthInternal(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)));
  persist();
}

export function toggleLeftCollapsed() {
  setLeftCollapsedInternal((v) => !v);
  persist();
}

export function setLeftCollapsed(v: boolean) {
  setLeftCollapsedInternal(v);
  persist();
}

export function toggleRightCollapsed() {
  setRightCollapsedInternal((v) => !v);
  persist();
}

export function setRightCollapsed(v: boolean) {
  setRightCollapsedInternal(v);
  persist();
}

export function setRightPanelTab(tab: RightPanelTab) {
  setRightPanelTabInternal(tab);
  persist();
}

export function setCollectionPanelTab(tab: CollectionPanelTab) {
  setCollectionPanelTabInternal(tab);
  persist();
}

// Session-only (see signal definition): no persist() — the mode never
// survives a restart.
export function toggleDistractionFree() {
  setDistractionFreeInternal((v) => !v);
}

export function setDistractionFree(v: boolean) {
  setDistractionFreeInternal(v);
}

/// Flip the status-bar count readout between words and characters.
export function toggleStatusCountMode() {
  setStatusCountModeInternal((m) => (m === "words" ? "chars" : "words"));
  persist();
}

export {
  leftWidth,
  rightWidth,
  leftCollapsed,
  rightCollapsed,
  rightPanelTab,
  collectionPanelTab,
  distractionFree,
  statusCountMode,
};
