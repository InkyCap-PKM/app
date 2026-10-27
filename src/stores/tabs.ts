import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { StateEffect } from "@codemirror/state";
import { pathEquals } from "../lib/paths";
import { moveOpenEditors } from "./editor-writes";
import { t } from "../lib/i18n";
import { settings } from "./settings";
import {
  focusedActiveTabId,
  focusedLeaf,
  activateTab,
  addTabToFocusedLeaf,
  removeTab,
  setLeafActiveTab,
  moveTabWithinLeaf,
  resetToSingleEmptyLeaf,
  splitLeaf,
  leafById,
  leafForTab,
  focusPane,
  type SplitDirection,
} from "./panes";

export type EditingMode = "source" | "live" | "reading";

/** Drag-and-drop MIME for dragging a tab (reorder within a pane today;
 *  move between panes once splits land). The payload is the tab id. */
export const TAB_DRAG_MIME = "application/x-inkycap-tab";

export interface Tab {
  id: string;
  /** `attachment` shows a notebox file that isn't a note (an image, PDF,
   *  audio or video file) read-only; see `attachmentViewKind`. */
  type: "collection" | "file" | "mycelial" | "empty" | "version-diff" | "attachment";
  title: string;
  path: string;
  viewName?: string;
  /**
   * Only on a `version-diff` tab: the past version compared with the note's
   * current text. `path` is the note's real path.
   */
  version?: { commit: string; shortHash: string; timestamp: number };
  /** Per-tab live-preview / source toggle. Undefined = follow user default. */
  editingMode?: EditingMode;
  /**
   * Reading-view format for this tab; undefined follows
   * `default_reading_format`. Per tab, so two panes of one note can differ.
   */
  readingFormat?: "svg" | "html";
  /**
   * Reading-view zoom for this tab (1 = 100%); undefined is 100%. Per tab, so
   * two panes of one note can be zoomed separately.
   */
  readingZoom?: number;
  /**
   * Shared by the editor and preview tabs of a "Split with preview" pair, for the
   * synced indicator only (the preview refreshes by path). A group with one member
   * left reads as unsynced.
   */
  syncGroupId?: string;
  /**
   * One-time caret offset (UTF-16) applied after the file loads, e.g. the end
   * of a new note.
   */
  pendingCursorOffset?: number;
  /** One-shot heading label to scroll to after the file loads. */
  pendingHeadingLabel?: string;
  /**
   * One-time match to select and scroll to after the file loads. `line` is
   * 1-based; `charStart` / `charEnd` are offsets in it. Used by search results.
   */
  pendingMatch?: { line: number; charStart: number; charEnd: number };
}

interface TabHistoryEntry {
  type: Tab["type"];
  title: string;
  path: string;
}

interface TabHistory {
  back: TabHistoryEntry[];
  forward: TabHistoryEntry[];
}

// Every open tab in all panes, for lookups, "is this open?", rename handling
// and search links. Order and placement belong to the pane tree
// (`stores/panes.ts`); this array is in insertion order.
const [tabs, setTabs] = createStore<Tab[]>([]);

// The active tab is the focused pane's active tab; these delegate to the pane
// store.
const activeTabId = focusedActiveTabId;
function setActiveTabId(id: string | null): void {
  if (id === null) {
    setLeafActiveTab(focusedLeaf().id, null);
    return;
  }
  activateTab(id);
}

// Per-tab dirty (unsaved-changes) flags, lifted out of MainContent so every
// pane's tab strip can render the dot for shared tab ids. Keyed by tab id.
const [dirtyTabIds, setDirtyTabIds] = createSignal<ReadonlySet<string>>(new Set());

/** Mark a tab dirty or clean (called by the editor on edit/save). */
export function setTabDirty(tabId: string, dirty: boolean): void {
  setDirtyTabIds((prev) => {
    if (dirty === prev.has(tabId)) return prev;
    const next = new Set(prev);
    if (dirty) next.add(tabId);
    else next.delete(tabId);
    return next;
  });
}

// Per-tab navigation history, keyed by tab ID.
const historyMap = new Map<string, TabHistory>();

// Per-tab editor state: the serialized EditorState (doc, selection, undo
// history) and scroll position, so switching back to a tab keeps undo and the
// reading position. Keyed by tab ID with its path, so it is reset when the tab
// navigates to another file. Kept until the tab closes (see `closeTab`).
interface CachedEditorState {
  path: string;
  /** Serialized CM6 state (doc + selection + history) for source/live mode. */
  json?: unknown;
  /** Document-anchored scroll position for source/live mode. */
  scroll?: StateEffect<unknown>;
  /** Pixel scroll offset of the reading-mode container (`.typst-reading`). */
  readingScrollTop?: number;
  /**
   * The text of `json` once known to be saved. If the note on disk no longer
   * matches on restore, it changed while the tab was away (a rename's link
   * rewrite, a sync, another app).
   */
  savedText?: string;
}
const editorStateCache = new Map<string, CachedEditorState>();

/**
 * Merge an update into a tab's cache entry, keeping other modes' fields. A
 * different path resets the entry.
 */
function patchCacheEntry(tabId: string, path: string, patch: Partial<Omit<CachedEditorState, "path">>): void {
  const existing = editorStateCache.get(tabId);
  if (existing && pathEquals(existing.path, path)) {
    editorStateCache.set(tabId, { ...existing, ...patch });
  } else {
    editorStateCache.set(tabId, { path, ...patch });
  }
}

export function getCachedEditorState(tabId: string, path: string): unknown | undefined {
  const entry = editorStateCache.get(tabId);
  if (!entry || !pathEquals(entry.path, path)) return undefined;
  return entry.json;
}

export function getCachedScroll(tabId: string, path: string): StateEffect<unknown> | undefined {
  const entry = editorStateCache.get(tabId);
  if (!entry || !pathEquals(entry.path, path)) return undefined;
  return entry.scroll;
}

export function setCachedEditorState(tabId: string, path: string, json: unknown): void {
  patchCacheEntry(tabId, path, { json, savedText: undefined });
}

/** Record that the cached state `json` holds `text` and that `text` is now on
 *  disk. Ignored if the tab has cached a different state since. */
export function markCachedEditorStateSaved(
  tabId: string,
  path: string,
  json: unknown,
  text: string,
): void {
  const entry = editorStateCache.get(tabId);
  if (!entry || entry.json !== json || !pathEquals(entry.path, path)) return;
  entry.savedText = text;
}

/** The saved text of a tab's cached state (see `markCachedEditorStateSaved`),
 *  or undefined when it isn't known to have reached disk. */
export function getCachedSavedText(tabId: string, path: string): string | undefined {
  const entry = editorStateCache.get(tabId);
  if (!entry || !pathEquals(entry.path, path)) return undefined;
  return entry.savedText;
}

/**
 * Save the source/visual scroll position. Updated continuously while scrolling,
 * because by teardown the editor div is already detached and reads as 0. Stored
 * as a document-anchored CM6 scroll effect, so it restores correctly at any
 * viewport height.
 */
export function setCachedScroll(tabId: string, path: string, scroll: StateEffect<unknown>): void {
  patchCacheEntry(tabId, path, { scroll });
}

export function getCachedReadingScroll(tabId: string, path: string): number | undefined {
  const entry = editorStateCache.get(tabId);
  if (!entry || !pathEquals(entry.path, path)) return undefined;
  return entry.readingScrollTop;
}

export function setCachedReadingScroll(tabId: string, path: string, top: number): void {
  patchCacheEntry(tabId, path, { readingScrollTop: top });
}

export function clearCachedEditorState(tabId: string): void {
  editorStateCache.delete(tabId);
}

/**
 * Drop the cached editor state for `path` and clear those tabs' dirty flags. Call
 * after writing a note outside the editor (a version restore, a hunk revert) so
 * inactive tabs reload from disk instead of restoring stale text.
 */
export function invalidateEditorCacheForPath(path: string): void {
  for (const [tabId, entry] of editorStateCache.entries()) {
    if (pathEquals(entry.path, path)) {
      editorStateCache.delete(tabId);
      setTabDirty(tabId, false);
    }
  }
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

// Recently closed tabs, newest last, for "Reopen Closed Tab" (Ctrl+Shift+T).
// Empty tabs aren't recorded; the stack is capped.
interface ClosedTab {
  type: Tab["type"];
  title: string;
  path: string;
  editingMode?: EditingMode;
}
const closedTabs: ClosedTab[] = [];
const CLOSED_TAB_LIMIT = 25;

let nextId = 1;

export interface OpenTabOptions {
  /** If true, always open in a new tab (Ctrl+Click behaviour). */
  forceNewTab?: boolean;
  /**
   * An explicit "open in new tab" (Ctrl/Cmd+click or the menu item). Whether it
   * takes focus follows the "Switch to new tabs immediately" setting
   * (`behaviour.switch_to_new_tab`); other opens always take focus.
   */
  newTabAction?: boolean;
  /** UTF-16 code-unit offset to place the cursor at after the file loads. */
  cursorOffset?: number;
  /** Heading label to scroll to after the file loads. */
  headingLabel?: string;
  /** Match range to select and scroll to after the file loads. */
  match?: { line: number; charStart: number; charEnd: number };
  /**
   * Always create a new tab, even if one with this path is open. Used to open a
   * Journal Scroll's anchor note from inside that scroll, whose tab has the
   * same path.
   */
  allowDuplicate?: boolean;
}

/**
 * Whether `openTab` should switch focus to the tab: an explicit "open in new
 * tab" follows the user's setting; every other open takes focus.
 */
function shouldActivate(opts: OpenTabOptions | undefined): boolean {
  if (opts?.newTabAction) return settings.behaviour.switch_to_new_tab;
  return true;
}

/**
 * Open a file, collection or Mycelial view. By default it replaces the active
 * tab's content and adds to history; with `forceNewTab`, or no active tab, it
 * opens a new tab. An existing tab with the same path and type is reused. Focus
 * follows `shouldActivate`.
 *
 * `editingMode` sets the mode (source, visual, reading) whichever way the tab
 * is resolved; undefined follows the user default.
 */
export function openTab(
  tab: Omit<Tab, "id">,
  opts?: OpenTabOptions,
): string {
  // Activate existing tab with same path+type if one exists — unless the
  // caller explicitly wants a distinct duplicate view.
  const existing = opts?.allowDuplicate
    ? undefined
    : tabs.find((t) => t.type === tab.type && pathEquals(t.path, tab.path));
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
    // An explicit mode applies even when the note is already open in another
    // mode.
    if (tab.editingMode) {
      setTabs((t) => t.id === existing.id, "editingMode", tab.editingMode);
    }
    if (shouldActivate(opts) || activeTabId() === null) {
      setActiveTabId(existing.id);
    }
    return existing.id;
  }

  const active = getActiveTab();

  // Navigate within the active tab when possible.
  if (active && !opts?.forceNewTab) {
    // Only tabs with content enter history. A version-diff is a temporary
    // compare view and never does.
    if (active.type !== "empty" && active.type !== "version-diff") {
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
    if (active.type !== tab.type || !pathEquals(active.path, tab.path)) {
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
        if (tab.editingMode !== undefined) t.editingMode = tab.editingMode;
        t.pendingCursorOffset = opts?.cursorOffset;
        t.pendingHeadingLabel = opts?.headingLabel;
        t.pendingMatch = opts?.match;
      }),
    );
    return active.id;
  }

  // No active tab or forceNewTab — create a new one in the focused pane.
  const id = `tab-${nextId++}`;
  setTabs(produce((t) => t.push({
    ...tab,
    id,
    pendingCursorOffset: opts?.cursorOffset,
    pendingHeadingLabel: opts?.headingLabel,
    pendingMatch: opts?.match,
  })));
  // Always activate when there was no active tab to fall back on, otherwise
  // the new tab would open into an empty content area with nothing focused.
  addTabToFocusedLeaf(id, shouldActivate(opts) || !active);
  return id;
}

/**
 * Open a note just made by a creation rule. Reuses the active tab when it is
 * empty ("New tab"), otherwise opens a new tab so the current note isn't
 * replaced. Used by every creation entry point.
 */
export function openCreatedNote(
  tab: Omit<Tab, "id">,
  opts?: Omit<OpenTabOptions, "forceNewTab">,
): string {
  const reuseEmpty = getActiveTab()?.type === "empty";
  return openTab(tab, { ...opts, forceNewTab: !reuseEmpty });
}

/**
 * Open a read-only compare tab for `notePath`, or retarget the existing one, so
 * browsing history reuses one view.
 */
export function openVersionDiff(
  notePath: string,
  title: string,
  version: { commit: string; shortHash: string; timestamp: number },
): void {
  // One compare view at a time: reuse any open version-diff tab (wherever it
  // lives — same pane or a split) rather than stacking per-note tabs.
  const existing = tabs.find((t) => t.type === "version-diff");
  if (existing) {
    retargetVersionDiff(existing.id, notePath, title, version);
  } else {
    // Open it in the note's pane without switching to it, whatever the "switch
    // to new tab" setting, so the Changes & History sidebar stays on the note.
    const newId = `tab-${nextId++}`;
    setTabs(
      produce((t) =>
        t.push({ id: newId, type: "version-diff", title, path: notePath, version }),
      ),
    );
    addTabToFocusedLeaf(newId, false);
  }
  keepNoteActive(notePath);
}

/**
 * Keep the note whose history is shown active and its pane focused. No-op if it
 * isn't open as a file tab.
 */
function keepNoteActive(notePath: string): void {
  const noteTab = tabs.find((t) => t.type === "file" && pathEquals(t.path, notePath));
  if (noteTab) activateTab(noteTab.id);
}

/**
 * Point the compare tab at a note and version. `PaneLeaf` keys the view on the
 * commit, so it reloads.
 */
function retargetVersionDiff(
  tabId: string,
  notePath: string,
  title: string,
  version: { commit: string; shortHash: string; timestamp: number },
): void {
  setTabs(
    (t) => t.id === tabId,
    produce((t) => {
      t.title = title;
      t.path = notePath;
      t.version = version;
    }),
  );
}

/**
 * Open a note version beside the note: split the focused pane and show the
 * version-diff on the right. Falls back to an in-pane diff if the split fails. An
 * existing compare tab is retargeted instead of adding another split.
 */
export function openVersionDiffSplit(
  notePath: string,
  title: string,
  version: { commit: string; shortHash: string; timestamp: number },
): void {
  const existing = tabs.find((t) => t.type === "version-diff");
  if (existing) {
    retargetVersionDiff(existing.id, notePath, title, version);
    const leaf = leafForTab(existing.id);
    // Reuse the compare tab's own pane; if it shares the note's pane, move it to
    // a new one beside it.
    if (leaf && leaf.tabIds.length > 1) {
      removeTab(existing.id); // detach from the shared leaf (note stays put)
      if (!splitLeaf(leaf.id, "row", existing.id)) {
        addTabToFocusedLeaf(existing.id, true); // split failed — don't strand it
      }
    }
    // Keep focus on the note (not the compare pane) so its sidebar stays.
    keepNoteActive(notePath);
    return;
  }
  const focused = focusedLeaf().id;
  const newId = `tab-${nextId++}`;
  setTabs(
    produce((t) =>
      t.push({ id: newId, type: "version-diff", title, path: notePath, version }),
    ),
  );
  const newLeaf = splitLeaf(focused, "row", newId);
  if (!newLeaf) {
    // Split failed — don't strand the orphan tab; fall back to an in-pane diff.
    setTabs(
      produce((t) => {
        const i = t.findIndex((x) => x.id === newId);
        if (i !== -1) t.splice(i, 1);
      }),
    );
    openVersionDiff(notePath, title, version);
    return;
  }
  // The split opens the version beside the note; keep the note active/focused
  // (splitLeaf focuses the new pane) so its Changes & History sidebar stays.
  keepNoteActive(notePath);
}

/** Create a new empty tab (no backing file). Navigating to a file
 *  from this tab will populate it in-place via the normal openTab flow. */
export function createEmptyTab(): string {
  const id = `tab-${nextId++}`;
  setTabs(produce((t) => t.push({ id, type: "empty", title: "New tab", path: "" })));
  addTabToFocusedLeaf(id, true);
  return id;
}

export function closeTab(id: string) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  // Record the closing tab so it can be reopened (Ctrl+Shift+T). Empty
  // tabs have no file to restore, so they're skipped.
  const closing = tabs[idx];
  // A version-diff compare view can't be reopened from {type,title,path} (its
  // version metadata is lost), so it's excluded from the reopen stack.
  if (closing.type !== "empty" && closing.type !== "version-diff" && closing.path) {
    closedTabs.push({
      type: closing.type,
      title: closing.title,
      path: closing.path,
      editingMode: closing.editingMode,
    });
    if (closedTabs.length > CLOSED_TAB_LIMIT) closedTabs.shift();
  }

  // Remove from the pane tree first (which picks a new active tab and collapses
  // an empty pane), then from the registry.
  const { workspaceEmptied } = removeTab(id);
  setTabs(produce((t) => {
    const i = t.findIndex((x) => x.id === id);
    if (i !== -1) t.splice(i, 1);
  }));
  historyMap.delete(id);
  editorStateCache.delete(id);
  setTabDirty(id, false);

  // With a notebox open there is always at least one tab; replace the last one
  // with an empty tab.
  if (workspaceEmptied) {
    createEmptyTab();
  }
}

/**
 * Close every tab, when switching noteboxes. The closed-tab stack is cleared
 * too, since its paths belong to the old notebox.
 */
export function closeAllTabs() {
  setTabs([]);
  historyMap.clear();
  editorStateCache.clear();
  closedTabs.length = 0;
  setDirtyTabIds(new Set<string>());
  // Collapse any splits and start the new notebox with a single empty pane.
  resetToSingleEmptyLeaf();
}


/**
 * Reopen the most recently closed tab (Ctrl+Shift+T) in a new tab, or focus it
 * if already open.
 */
export function reopenClosedTab() {
  const last = closedTabs.pop();
  if (!last) return;
  const tabId = openTab(
    { type: last.type, title: last.title, path: last.path },
    { forceNewTab: true },
  );
  if (last.editingMode) setTabEditingMode(tabId, last.editingMode);
}

export function getActiveTab(): Tab | undefined {
  const id = activeTabId();
  return id ? tabs.find((t) => t.id === id) : undefined;
}

/**
 * Path of the file in the focused pane's active tab, or `undefined` if it isn't
 * a file. Used for the "Current folder" note location.
 */
export function activeNotePath(): string | undefined {
  const tab = getActiveTab();
  return tab?.type === "file" ? tab.path : undefined;
}

/**
 * Tab title: "New tab" (localized) for empty tabs, the name without extension
 * for files, and the stored title otherwise. A leading-dot name like
 * ".gitignore" keeps its name.
 */
export function tabDisplayTitle(tab: Pick<Tab, "type" | "title">): string {
  if (tab.type === "empty") return t("tabStrip.newTab");
  if (tab.type !== "file") return tab.title;
  return tab.title.replace(/^(.+)\.[^.]+$/, "$1");
}

/** Reorder a tab within the focused pane's strip. */
export function reorderTab(fromIndex: number, toIndex: number) {
  moveTabWithinLeaf(focusedLeaf().id, fromIndex, toIndex);
}

/**
 * Split a pane. The new pane shows a second, independent view of the active tab
 * (or an empty tab) and takes focus.
 */
export function splitPane(leafId: string, direction: SplitDirection): string | null {
  const leaf = leafById(leafId);
  const src = leaf?.activeTabId ? tabs.find((t) => t.id === leaf.activeTabId) : undefined;
  const newId = `tab-${nextId++}`;
  if (src && src.type !== "empty" && src.path) {
    setTabs(produce((t) => t.push({
      id: newId,
      type: src.type,
      title: src.title,
      path: src.path,
      viewName: src.viewName,
      editingMode: src.editingMode,
      // Carry the compare metadata so a split of a version-diff tab renders the
      // diff in the new pane (without it, PaneLeaf falls back to the empty state).
      version: src.version,
    })));
  } else {
    setTabs(produce((t) => t.push({ id: newId, type: "empty", title: "New tab", path: "" })));
  }
  const newLeafId = splitLeaf(leafId, direction, newId);
  // If the split somehow failed, don't strand the orphan tab in the registry.
  if (!newLeafId) {
    setTabs(produce((t) => {
      const i = t.findIndex((x) => x.id === newId);
      if (i !== -1) t.splice(i, 1);
    }));
  }
  return newLeafId;
}

/**
 * Split the pane and show a live reading-mode preview of the active note in the
 * new one. The preview uses the user's reading format, and both tabs share a
 * `syncGroupId` for the synced indicator; the preview recompiles on
 * `inkycap:note-saved`. Focus stays on the editor. Returns the new leaf id, or
 * null if the tab isn't a note or the split failed.
 */
export function splitWithPreview(leafId: string): string | null {
  const leaf = leafById(leafId);
  const src = leaf?.activeTabId ? tabs.find((t) => t.id === leaf.activeTabId) : undefined;
  if (!src || src.type !== "file" || !src.path) return null;
  // One synced preview per note: refuse if this note already has a pair open
  // (either from this pane or another). Other notes are unaffected.
  if (pathHasSyncedPreview(src.path)) return null;

  const groupId = `sync-${nextId++}`;
  const newId = `tab-${nextId++}`;
  setTabs(produce((t) => {
    // Tag the source tab so both panes show the synced indicator.
    const source = t.find((x) => x.id === src.id);
    if (source) source.syncGroupId = groupId;
    t.push({
      id: newId,
      type: "file",
      title: src.title,
      path: src.path,
      viewName: src.viewName,
      editingMode: "reading",
      syncGroupId: groupId,
    });
  }));

  const newLeafId = splitLeaf(leafId, "row", newId);
  if (!newLeafId) {
    // Roll back both the orphan tab and the source tag so a failed split
    // leaves no phantom tab and no dangling indicator.
    setTabs(produce((t) => {
      const i = t.findIndex((x) => x.id === newId);
      if (i !== -1) t.splice(i, 1);
      const source = t.find((x) => x.id === src.id);
      if (source) source.syncGroupId = undefined;
    }));
    return null;
  }
  // Keep the user in the editor pane; the preview only mirrors it.
  focusPane(leafId);
  return newLeafId;
}

/** True when this tab's synced partner is still open. */
export function isSyncedTab(tabId: string): boolean {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab?.syncGroupId) return false;
  return tabs.some((t) => t.id !== tabId && t.syncGroupId === tab.syncGroupId);
}

/**
 * True when the note at `path` already has a "Split with preview" pair open;
 * only one is allowed per note, so the action is hidden in both panes.
 */
export function pathHasSyncedPreview(path: string): boolean {
  return tabs.some((t) => pathEquals(t.path, path) && isSyncedTab(t.id));
}

/** Close every tab in a pane, which collapses the pane (or, if it's the only
 *  pane, leaves a fresh empty tab behind per the always-one-tab invariant). */
export function closePane(leafId: string): void {
  const leaf = leafById(leafId);
  if (!leaf) return;
  for (const id of [...leaf.tabIds]) closeTab(id);
}

/** Switch to the next tab in the focused pane (wraps around). */
export function switchToNextTab() {
  const ids = focusedLeaf().tabIds;
  if (ids.length === 0) return;
  const currentIdx = ids.indexOf(activeTabId() ?? "");
  setActiveTabId(ids[(currentIdx + 1) % ids.length]);
}

/** Switch to the previous tab in the focused pane (wraps around). */
export function switchToPrevTab() {
  const ids = focusedLeaf().tabIds;
  if (ids.length === 0) return;
  const currentIdx = ids.indexOf(activeTabId() ?? "");
  setActiveTabId(ids[(currentIdx - 1 + ids.length) % ids.length]);
}

/** Switch to a tab by its 0-based index within the focused pane
 *  (for Ctrl+1 through Ctrl+9). */
export function switchToTabByIndex(index: number) {
  const ids = focusedLeaf().tabIds;
  if (index >= 0 && index < ids.length) {
    setActiveTabId(ids[index]);
  }
}

/**
 * Point any tab, cached state or history entry at `from` to `to` instead, after
 * an external rename, so open tabs follow the file. The title defaults to the
 * new file name; pass `newTitle` for others, such as a collection, shown
 * without `.collection`.
 */
export function renameTabPath(from: string, to: string, newTitle = to.split("/").pop() ?? to) {
  if (pathEquals(from, to)) return;

  // Open editors take the new path before their tabs switch to it, so the
  // save they make while being rebuilt lands in the renamed file.
  moveOpenEditors(from, to);

  setTabs(
    (t) => pathEquals(t.path, from),
    produce((t) => {
      t.path = to;
      t.title = newTitle;
    }),
  );

  // Move cached entries too, so undo history survives the rename.
  for (const [tabId, entry] of editorStateCache.entries()) {
    if (pathEquals(entry.path, from)) {
      editorStateCache.set(tabId, { ...entry, path: to });
    }
  }

  // History stacks also store paths — rewrite them so back/forward
  // navigation lands on the renamed file instead of erroring.
  let historyChanged = false;
  for (const h of historyMap.values()) {
    for (const entry of h.back) {
      if (pathEquals(entry.path, from)) {
        entry.path = to;
        entry.title = newTitle;
        historyChanged = true;
      }
    }
    for (const entry of h.forward) {
      if (pathEquals(entry.path, from)) {
        entry.path = to;
        entry.title = newTitle;
        historyChanged = true;
      }
    }
  }
  if (historyChanged) bumpHistory();
}

/** Update the editing mode (source vs live) for a tab. */
export function setTabEditingMode(id: string, mode: EditingMode) {
  setTabs(
    (t) => t.id === id,
    "editingMode",
    mode,
  );
}

/** The reading-view render format for a tab: its per-tab override, else the
 *  user's default setting. Reactive — reads the tab store and settings. */
export function tabReadingFormat(tabId: string): "svg" | "html" {
  const tab = tabs.find((t) => t.id === tabId);
  return tab?.readingFormat ?? settings.editor.default_reading_format ?? "svg";
}

/** Set a tab's reading-view render format override (per pane). */
export function setTabReadingFormat(tabId: string, fmt: "svg" | "html") {
  setTabs((t) => t.id === tabId, "readingFormat", fmt);
}

// Reading-view zoom limits: lower than a browser's, so a paged note can be
// pulled back to see a spread; 4× at most. `READING_ZOOM_STEP` is the factor
// per Ctrl+= or wheel notch, as in the Mycelial view.
export const READING_ZOOM_MIN = 0.25;
export const READING_ZOOM_MAX = 4;
export const READING_ZOOM_STEP = 1.2;

/** The reading-view zoom factor for a tab (1 = 100%). Reactive — reads the
 *  tab store. */
export function tabReadingZoom(tabId: string): number {
  const tab = tabs.find((t) => t.id === tabId);
  return tab?.readingZoom ?? 1;
}

/** Set a tab's reading-view zoom factor, clamped to the supported range. */
export function setTabReadingZoom(tabId: string, zoom: number) {
  const clamped = Math.min(READING_ZOOM_MAX, Math.max(READING_ZOOM_MIN, zoom));
  setTabs((t) => t.id === tabId, "readingZoom", clamped);
}

/**
 * Multiply a tab's zoom by `factor`; geometric, so each step feels the same at
 * any zoom.
 */
export function nudgeTabReadingZoom(tabId: string, factor: number) {
  setTabReadingZoom(tabId, tabReadingZoom(tabId) * factor);
}

/** Restore a tab's reading view to 100%. */
export function resetTabReadingZoom(tabId: string) {
  setTabs((t) => t.id === tabId, "readingZoom", 1);
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

export { tabs, activeTabId, setActiveTabId, dirtyTabIds };
