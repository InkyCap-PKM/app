import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

export type EditingMode = "source" | "live" | "reading";

export interface Tab {
  id: string;
  type: "collection" | "file" | "flow" | "empty";
  title: string;
  path: string;
  viewName?: string;
  /** Per-tab live-preview / source toggle. Undefined = follow user default. */
  editingMode?: EditingMode;
  /** One-shot cursor offset from scaffold {{cursor}}. Consumed by the editor on load. */
  pendingCursorOffset?: number;
  /** One-shot heading label to scroll to after the file loads. */
  pendingHeadingLabel?: string;
  /** One-shot match range to select and scroll to after the file loads.
   *  `line` is 1-indexed; `charStart`/`charEnd` are offsets into that line.
   *  Used by the search panel to deep-link a result row to its exact spot. */
  pendingMatch?: { line: number; charStart: number; charEnd: number };
}

interface TabHistoryEntry {
  type: "collection" | "file" | "flow" | "empty";
  title: string;
  path: string;
}

interface TabHistory {
  back: TabHistoryEntry[];
  forward: TabHistoryEntry[];
}

const [tabs, setTabs] = createStore<Tab[]>([]);
const [activeTabId, setActiveTabId] = createSignal<string | null>(null);

// Per-tab navigation history, keyed by tab ID.
const historyMap = new Map<string, TabHistory>();

// Per-tab editor state cache. Stores a serialized CodeMirror EditorState
// (doc + selection + undo history) so that switching away from a tab and
// back again preserves Ctrl-Z and the rest of the editor's transient state.
// The cache is keyed by tab ID and tied to a path so we can invalidate it
// when a tab is navigated in-place to a different file.
interface CachedEditorState {
  path: string;
  json: unknown;
}
const editorStateCache = new Map<string, CachedEditorState>();

export function getCachedEditorState(tabId: string, path: string): unknown | undefined {
  const entry = editorStateCache.get(tabId);
  if (!entry || entry.path !== path) return undefined;
  return entry.json;
}

export function setCachedEditorState(tabId: string, path: string, json: unknown): void {
  editorStateCache.set(tabId, { path, json });
}

export function clearCachedEditorState(tabId: string): void {
  editorStateCache.delete(tabId);
}

// Reactive signal that bumps whenever any tab's history changes,
// so UI (back/forward buttons) can re-evaluate.
const [historyVersion, setHistoryVersion] = createSignal(0);
function bumpHistory() {
  setHistoryVersion((v) => v + 1);
}

function getOrCreateHistory(tabId: string): TabHistory {
  let h = historyMap.get(tabId);
  if (!h) {
    h = { back: [], forward: [] };
    historyMap.set(tabId, h);
  }
  return h;
}

let nextId = 1;

export interface OpenTabOptions {
  /** If true, always open in a new tab (Ctrl+Click behaviour). */
  forceNewTab?: boolean;
  /** Byte offset to place the cursor at after the file loads (from scaffold {{cursor}}). */
  cursorOffset?: number;
  /** Heading label to scroll to after the file loads. */
  headingLabel?: string;
  /** Match range to select and scroll to after the file loads. */
  match?: { line: number; charStart: number; charEnd: number };
}

/**
 * Open a file/collection/flow. By default, navigates within the active
 * tab (replacing its content and pushing history). If `forceNewTab` is
 * set, or there is no active tab, a new tab is created instead.
 *
 * If a tab with the same path+type already exists, it is activated
 * regardless of options.
 */
export function openTab(
  tab: Omit<Tab, "id">,
  opts?: OpenTabOptions,
): string {
  // Activate existing tab with same path+type if one exists.
  const existing = tabs.find(
    (t) => t.path === tab.path && t.type === tab.type,
  );
  if (existing) {
    if (opts?.headingLabel) {
      setTabs(
        (t) => t.id === existing.id,
        "pendingHeadingLabel",
        opts.headingLabel,
      );
    }
    if (opts?.match) {
      setTabs((t) => t.id === existing.id, "pendingMatch", opts.match);
    }
    setActiveTabId(existing.id);
    return existing.id;
  }

  const active = getActiveTab();

  // Navigate within the active tab when possible.
  if (active && !opts?.forceNewTab) {
    // Only push history for tabs that have actual content.
    if (active.type !== "empty") {
      const h = getOrCreateHistory(active.id);
      h.back.push({
        type: active.type,
        title: active.title,
        path: active.path,
      });
      h.forward.length = 0;
      bumpHistory();
    }

    // Navigating in-place changes the file backing the tab, so any cached
    // editor state belongs to the previous file and must be discarded.
    if (active.path !== tab.path || active.type !== tab.type) {
      editorStateCache.delete(active.id);
    }

    // Update the active tab in-place.
    setTabs(
      (t) => t.id === active.id,
      produce((t) => {
        t.type = tab.type;
        t.title = tab.title;
        t.path = tab.path;
        if (tab.viewName !== undefined) t.viewName = tab.viewName;
        t.pendingCursorOffset = opts?.cursorOffset;
        t.pendingHeadingLabel = opts?.headingLabel;
        t.pendingMatch = opts?.match;
      }),
    );
    return active.id;
  }

  // No active tab or forceNewTab — create a new one.
  const id = `tab-${nextId++}`;
  setTabs(produce((t) => t.push({
    ...tab,
    id,
    pendingCursorOffset: opts?.cursorOffset,
    pendingHeadingLabel: opts?.headingLabel,
    pendingMatch: opts?.match,
  })));
  setActiveTabId(id);
  return id;
}

/** Create a new empty tab (no backing file). Navigating to a file
 *  from this tab will populate it in-place via the normal openTab flow. */
export function createEmptyTab(): string {
  const id = `tab-${nextId++}`;
  setTabs(produce((t) => t.push({ id, type: "empty", title: "New tab", path: "" })));
  setActiveTabId(id);
  return id;
}

export function closeTab(id: string) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  setTabs(produce((t) => t.splice(idx, 1)));
  historyMap.delete(id);
  editorStateCache.delete(id);

  if (activeTabId() === id) {
    const newIdx = Math.min(idx, tabs.length - 1);
    setActiveTabId(newIdx >= 0 ? tabs[newIdx]?.id ?? null : null);
  }
}

export function getActiveTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeTabId());
}

/** Reorder a tab from one index to another. */
export function reorderTab(fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return;
  setTabs(
    produce((t) => {
      const [moved] = t.splice(fromIndex, 1);
      t.splice(toIndex, 0, moved);
    }),
  );
}

/** Switch to the next tab (wraps around). */
export function switchToNextTab() {
  if (tabs.length === 0) return;
  const currentIdx = tabs.findIndex((t) => t.id === activeTabId());
  const nextIdx = (currentIdx + 1) % tabs.length;
  setActiveTabId(tabs[nextIdx].id);
}

/** Switch to the previous tab (wraps around). */
export function switchToPrevTab() {
  if (tabs.length === 0) return;
  const currentIdx = tabs.findIndex((t) => t.id === activeTabId());
  const prevIdx = (currentIdx - 1 + tabs.length) % tabs.length;
  setActiveTabId(tabs[prevIdx].id);
}

/** Switch to a tab by its 1-based index (for Ctrl+1 through Ctrl+9). */
export function switchToTabByIndex(index: number) {
  if (index >= 0 && index < tabs.length) {
    setActiveTabId(tabs[index].id);
  }
}

/** Update the editing mode (source vs live) for a tab. */
export function setTabEditingMode(id: string, mode: EditingMode) {
  setTabs(
    (t) => t.id === id,
    "editingMode",
    mode,
  );
}

// ── Navigation history ──────────────────────────────────

export function canGoBack(tabId: string): boolean {
  historyVersion();
  const h = historyMap.get(tabId);
  return !!h && h.back.length > 0;
}

export function canGoForward(tabId: string): boolean {
  historyVersion();
  const h = historyMap.get(tabId);
  return !!h && h.forward.length > 0;
}

export function goBack(tabId: string) {
  const h = historyMap.get(tabId);
  if (!h || h.back.length === 0) return;

  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Push current state onto forward stack.
  h.forward.push({ type: tab.type, title: tab.title, path: tab.path });

  const prev = h.back.pop()!;
  bumpHistory();
  editorStateCache.delete(tabId);

  setTabs(
    (t) => t.id === tabId,
    produce((t) => {
      t.type = prev.type;
      t.title = prev.title;
      t.path = prev.path;
    }),
  );
}

export function goForward(tabId: string) {
  const h = historyMap.get(tabId);
  if (!h || h.forward.length === 0) return;

  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Push current state onto back stack.
  h.back.push({ type: tab.type, title: tab.title, path: tab.path });

  const next = h.forward.pop()!;
  bumpHistory();
  editorStateCache.delete(tabId);

  setTabs(
    (t) => t.id === tabId,
    produce((t) => {
      t.type = next.type;
      t.title = next.title;
      t.path = next.path;
    }),
  );
}

/** Consume and clear the pending cursor offset for a tab. */
export function consumePendingCursorOffset(tabId: string): number | undefined {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab?.pendingCursorOffset) return undefined;
  const offset = tab.pendingCursorOffset;
  setTabs(
    (t) => t.id === tabId,
    "pendingCursorOffset",
    undefined,
  );
  return offset;
}

/** Consume and clear the pending heading label for a tab. */
export function consumePendingHeadingLabel(tabId: string): string | undefined {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab?.pendingHeadingLabel) return undefined;
  const label = tab.pendingHeadingLabel;
  setTabs(
    (t) => t.id === tabId,
    "pendingHeadingLabel",
    undefined,
  );
  return label;
}

/** Consume and clear the pending match range for a tab. */
export function consumePendingMatch(
  tabId: string,
): { line: number; charStart: number; charEnd: number } | undefined {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab?.pendingMatch) return undefined;
  const m = tab.pendingMatch;
  setTabs((t) => t.id === tabId, "pendingMatch", undefined);
  return m;
}

export { tabs, activeTabId, setActiveTabId };
