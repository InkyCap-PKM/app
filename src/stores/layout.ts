// Layout store: panel widths and collapsed state.
// Persists to localStorage so panel sizing survives reloads. Settings
// persistence is intentionally lightweight here — these are pure UI
// preferences that don't need to round-trip to the Rust backend.

import { createSignal } from "solid-js";

const STORAGE_KEY = "inkycap.layout";

export type RightPanelTab = "properties" | "outline" | "links" | "references";

const RIGHT_PANEL_TABS: readonly RightPanelTab[] = ["properties", "outline", "links", "references"];

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightPanelTab: RightPanelTab;
}

const DEFAULTS: LayoutState = {
  leftWidth: 240,
  rightWidth: 280,
  leftCollapsed: false,
  rightCollapsed: false,
  rightPanelTab: "outline",
};

const MIN_WIDTH = 160;
const MAX_WIDTH = 600;

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...parsed };
    if (!RIGHT_PANEL_TABS.includes(merged.rightPanelTab)) {
      merged.rightPanelTab = DEFAULTS.rightPanelTab;
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

function persist() {
  save({
    leftWidth: leftWidth(),
    rightWidth: rightWidth(),
    leftCollapsed: leftCollapsed(),
    rightCollapsed: rightCollapsed(),
    rightPanelTab: rightPanelTab(),
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

export function setRightPanelTab(tab: RightPanelTab) {
  setRightPanelTabInternal(tab);
  persist();
}

export { leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightPanelTab };
