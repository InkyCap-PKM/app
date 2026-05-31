// Layout store: panel widths and collapsed state.
// Persists to localStorage so panel sizing survives reloads. Settings
// persistence is intentionally lightweight here — these are pure UI
// preferences that don't need to round-trip to the Rust backend.

import { createSignal } from "solid-js";

const STORAGE_KEY = "inkycap.layout";

export type RightPanelTab =
  | "properties"
  | "outline"
  | "links"
  | "references"
  | "scroll-context"
  | "annotations"
  // A runtime-contributed panel id (plugin / external tool). The `(string & {})`
  // keeps autocomplete on the built-in literals above while allowing any id.
  // Contributed ids are deliberately excluded from BUILT_IN_RIGHT_PANEL_TABS, so
  // they reset to the default tab on reload rather than persisting (the
  // contribution re-registers at runtime; a stale id would point at nothing).
  | (string & {});

const BUILT_IN_RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
  "properties",
  "outline",
  "links",
  "references",
  "scroll-context",
  "annotations",
];

/// The right panel's tab set for a Collection View. Distinct from
/// `RightPanelTab` (which is file-note scoped) because a collection tab and a
/// file tab can't be active at the same time, and keeping the two enums apart
/// means switching between a note and a collection never strands the panel on
/// an inapplicable tab.
export type CollectionPanelTab = "characteristics" | "style" | "book";

const COLLECTION_PANEL_TABS: readonly CollectionPanelTab[] = [
  "characteristics",
  "style",
  "book",
];

/// Which metric the status-bar count readout shows. The two share one slot
/// at the right edge and toggle on click (see StatusBar); persisted so the
/// user's preference survives reloads.
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
  collectionPanelTab: "characteristics",
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
    // "scroll-context" and "annotations" are contextual tabs — they exist only
    // while their condition holds (a scroll session / the active note having
    // annotations or collab membership). Never restore them on startup, or the
    // pane shows before the editor is mounted with no owning context.
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
// strip and the status bar (the bar leaves only its floating exit button),
// keeping just the editor toolbar + content. Deliberately NOT persisted — it's
// session-only, so every launch starts in regular mode regardless of how the
// last session ended.
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
