import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { StateEffect } from "@codemirror/state";
import { pathEquals } from "../lib/paths";
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
  type: "collection" | "file" | "mycelial" | "empty" | "version-diff";
  title: string;
  path: string;
  viewName?: string;
  /** Present only on a `version-diff` tab: the past version being compared
   *  against the note's current content (a read-only inline diff). `path` is the
   *  real note path (for fetching current text + Restore). */
  version?: { commit: string; shortHash: string; timestamp: number };
  /** Per-tab live-preview / source toggle. Undefined = follow user default. */
  editingMode?: EditingMode;
  /** Per-tab reading-view render format override (svg vs html). Undefined =
   *  follow the user's `default_reading_format` setting. Per-tab so two panes
   *  showing the same note in reading mode can differ. */
  readingFormat?: "svg" | "html";
  /** Per-tab reading-view zoom factor, where 1 = 100%. Undefined = 100%.
   *  Per-tab (like `readingFormat`) so two panes showing the same note can be
   *  zoomed independently — one held at a legible reading size while the other
   *  is pulled back to inspect page layout. */
  readingZoom?: number;
  /** Marks a synced editor+preview pair created by "Split with preview": the
   *  editor tab and its reading-mode preview share one id. Purely drives the
   *  "synced" tab indicator — the preview's recompile-on-save is path-based, so
   *  this is not load-bearing for the refresh. A group with only one member
   *  left open (partner closed) reads as un-synced, so the indicator self-heals. */
  syncGroupId?: string;
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
  type: Tab["type"];
  title: string;
  path: string;
}

interface TabHistory {
  back: TabHistoryEntry[];
  forward: TabHistoryEntry[];
}

// Flat registry of every open tab across all panes. Lookups (by id/path),
// "is this file open?" checks, rename migration and search deep-linking all
// run against this. Display order and which pane shows a tab are owned by
// the pane tree (`stores/panes.ts`) — this array's order is just insertion
// order and no longer dictates the tab strip.
const [tabs, setTabs] = createStore<Tab[]>([]);

// The app's single "active tab" is the focused pane's active tab. These
// delegate to the pane store so the existing API — `activeTabId()`,
// `setActiveTabId()`, `getActiveTab()` — keeps working unchanged for the
// ~26 modules that consume it.
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

// Per-tab editor state cache. Stores a serialized CodeMirror EditorState
// (doc + selection + undo history) plus the scroll position, so that
// switching away from a tab and back again preserves Ctrl-Z and returns the
// reader to where they had scrolled — rather than resetting to the top. The
// cache is keyed by tab ID and tied to a path so we can invalidate it when a
// tab is navigated in-place to a different file. Entries live until the tab is
// closed (see `closeTab`), giving "remember my place until I close it"
// semantics across any number of tab switches.
interface CachedEditorState {
  path: string;
  /** Serialized CM6 state (doc + selection + history) for source/live mode. */
  json?: unknown;
  /** Document-anchored scroll position for source/live mode. */
  scroll?: StateEffect<unknown>;
  /** Pixel scroll offset of the reading-mode container (`.typst-reading`). */
  readingScrollTop?: number;
}
const editorStateCache = new Map<string, CachedEditorState>();

/** Merge a partial update into a tab's cache entry, preserving fields that
 *  belong to other editor modes. A path change resets the entry so a tab
 *  navigated in-place to a different file doesn't inherit stale scroll/state. */
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
  patchCacheEntry(tabId, path, { json });
}

/** Cache the source/live-mode scroll position. Captured *continuously* while
 *  the user scrolls (not at teardown): destroyEditor runs from a `createEffect`,
 *  which fires after Solid's render effects have already removed the editor div,
 *  so a snapshot taken there reads a detached scroller (scrollTop 0). Tracking
 *  live avoids that ordering trap. The value is a document-anchored CM6 scroll
 *  effect so it re-applies correctly regardless of viewport height at restore. */
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

/** Drop every cached editor state for `path`, and clear those tabs' dirty flags.
 *  Call this after writing a note out-of-band (a version restore, a hunk revert)
 *  so an inactive tab of that note reloads fresh from disk on reactivation
 *  instead of restoring its now-stale cached buffer — which would otherwise show
 *  old content and read as dirty (cached buffer ≠ the just-written disk file). */
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

// Stack of recently-closed tabs, most-recent last. Powers "Reopen Closed
// Tab" (Ctrl+Shift+T). Empty (file-less) tabs are never recorded; the
// stack is capped so a long session doesn't accumulate unbounded entries.
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
   * Marks this as a discretionary "open in a new tab" action — a
   * Ctrl/Cmd+click or a right-click "open in new tab" menu item. When set,
   * whether the content focus switches to the opened tab is governed by the
   * user's "Switch to new tabs immediately" setting
   * (`behaviour.switch_to_new_tab`). Without this flag an opened tab always
   * takes focus, so creations, header buttons and quick-open keep switching.
   */
  newTabAction?: boolean;
  /** Byte offset to place the cursor at after the file loads (from scaffold {{cursor}}). */
  cursorOffset?: number;
  /** Heading label to scroll to after the file loads. */
  headingLabel?: string;
  /** Match range to select and scroll to after the file loads. */
  match?: { line: number; charStart: number; charEnd: number };
  /**
   * Skip the "activate the existing tab with this path" shortcut and always
   * create a fresh tab. Needed when the caller deliberately wants a second,
   * independent view of a file that is *already* open — notably opening the
   * anchor note from inside its own Journal Scroll tab, where the existing
   * tab with that path IS the scroll itself.
   */
  allowDuplicate?: boolean;
}

/**
 * Decide whether an `openTab` call should switch the content focus to the
 * opened tab. A discretionary "open in new tab" action defers to the user's
 * preference; every other open (in-place navigation, creations, quick-open,
 * header buttons) takes focus immediately.
 */
function shouldActivate(opts: OpenTabOptions | undefined): boolean {
  if (opts?.newTabAction) return settings.behaviour.switch_to_new_tab;
  return true;
}

/**
 * Open a file/collection/mycelial view. By default, navigates within the active
 * tab (replacing its content and pushing history). If `forceNewTab` is
 * set, or there is no active tab, a new tab is created instead.
 *
 * If a tab with the same path+type already exists, that tab is reused.
 * Whether the content focus switches to the opened/reused tab is governed
 * by `shouldActivate` (see `OpenTabOptions.activate`).
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
    if (shouldActivate(opts) || activeTabId() === null) {
      setActiveTabId(existing.id);
    }
    return existing.id;
  }

  const active = getActiveTab();

  // Navigate within the active tab when possible.
  if (active && !opts?.forceNewTab) {
    // Only push history for tabs that have actual content. A version-diff is a
    // transient read-only compare view (no version metadata survives a
    // {type,title,path} history entry), so it never enters nav history.
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
 * Open a freshly created note from a creation rule (toolbar button, command
 * palette, hotkey, file-tree "new note", startup). Reuses the active tab when
 * it's an empty placeholder ("New tab") so a creation doesn't strand a blank
 * tab beside the new note; otherwise opens a fresh tab so a note the user is
 * already working on isn't replaced. All creation-rule entry points share this
 * so the behaviour stays uniform.
 */
export function openCreatedNote(
  tab: Omit<Tab, "id">,
  opts?: Omit<OpenTabOptions, "forceNewTab">,
): string {
  const reuseEmpty = getActiveTab()?.type === "empty";
  return openTab(tab, { ...opts, forceNewTab: !reuseEmpty });
}

/** Open (or update) a read-only version-compare tab for `notePath`. If one is
 *  already open for this note, retarget it to the new version in place — so
 *  clicking through a note's history reuses one compare view rather than
 *  stacking tabs. Otherwise opens a fresh `version-diff` tab. */
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
    // Open the compare tab in the note's pane *without* switching to it: this
    // deliberately ignores the "switch to new tab" preference so the note stays
    // active and its Changes & History sidebar stays put for browsing versions.
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

/** Keep the note whose history is being browsed active (and its pane focused),
 *  so opening or retargeting a version-diff never steals focus — the Changes &
 *  History sidebar then stays on the note. Always applied, regardless of the
 *  "switch to new tab" setting. No-op if the note isn't open as a file tab. */
function keepNoteActive(notePath: string): void {
  const noteTab = tabs.find((t) => t.type === "file" && pathEquals(t.path, notePath));
  if (noteTab) activateTab(noteTab.id);
}

/** Point the single compare (version-diff) tab at a note + version. The pane
 *  showing it re-renders because `PaneLeaf` keys the view on the version commit
 *  too (so a retarget reloads even within the same note). */
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

/** Open a note version *beside* the current note: split the focused pane to the
 *  right and put the version-diff in the new right pane, leaving the live note in
 *  the left. The side-by-side counterpart of [`openVersionDiff`] (which replaces
 *  the active tab). Falls back to an in-pane diff if the split can't be created.
 *
 *  Reuses a single compare view: if a version-diff tab is already open, it's
 *  retargeted to this note/version (and its pane focused) rather than spawning
 *  another split — so repeated side-by-side clicks don't stack panes. To compare
 *  several versions at once, split the view manually. */
export function openVersionDiffSplit(
  notePath: string,
  title: string,
  version: { commit: string; shortHash: string; timestamp: number },
): void {
  const existing = tabs.find((t) => t.type === "version-diff");
  if (existing) {
    retargetVersionDiff(existing.id, notePath, title, version);
    const leaf = leafForTab(existing.id);
    // If the compare tab already has its own pane, just reuse it there. If it's
    // sharing a pane (e.g. opened as a second tab beside the note), move it into
    // a new side-by-side pane so the note and the history sit beside each other.
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

  // Remove from the pane tree first — this re-points the owning leaf's
  // active tab to a neighbour and collapses the pane if it just emptied —
  // then drop the tab from the registry.
  const { workspaceEmptied } = removeTab(id);
  setTabs(produce((t) => {
    const i = t.findIndex((x) => x.id === id);
    if (i !== -1) t.splice(i, 1);
  }));
  historyMap.delete(id);
  editorStateCache.delete(id);
  setTabDirty(id, false);

  // Invariant: while a notebox is open, the workspace always has at least
  // one tab. If closing this tab emptied the sole remaining pane, spawn a
  // fresh empty tab so the user lands on the tabula-rasa hints.
  if (workspaceEmptied) {
    createEmptyTab();
  }
}

/** Close every open tab. Used when switching noteboxes so notes from the
 *  previous notebox don't linger as zombie tabs in the new one. The
 *  closed-tab stack is also cleared — reopening a tab from a different
 *  notebox would resolve the wrong file. */
export function closeAllTabs() {
  setTabs([]);
  historyMap.clear();
  editorStateCache.clear();
  closedTabs.length = 0;
  setDirtyTabIds(new Set<string>());
  // Collapse any splits and start the new notebox with a single empty pane.
  resetToSingleEmptyLeaf();
}


/** Reopen the most recently closed tab (Ctrl+Shift+T). No-op when the
 *  closed-tab stack is empty. Opens in a fresh tab; if a tab with the
 *  same path is already open, that tab is focused instead. */
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

/** Display title for a tab. Empty tabs show the localized "New tab" label
 *  rather than their stored placeholder title; file tabs drop the extension;
 *  other tab types keep their title verbatim. The dot must follow at least one
 *  character so a leading-dot file like ".gitignore" doesn't render blank. */
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
 * Split a pane in two. The new sibling opens a second, independent view of
 * the source pane's active tab (same file, fresh editor instance) — the
 * common "compare two places in one document" case — or an empty tab when
 * the source pane has nothing open. Focus moves to the new pane.
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
 * Split the pane and open a live-updating reading-mode preview of the active
 * note in the new sibling — the "edit here, watch the render there" case.
 *
 * The preview follows the user's Appearance > Reading view format preference
 * (`readingFormat` left undefined → `tabReadingFormat` falls back to
 * `default_reading_format`). Both tabs are tagged with a shared `syncGroupId`
 * to drive the synced-pair indicator; the preview's refresh itself is
 * path-based (it recompiles on `inkycap:note-saved`, which the editor's
 * autosave already emits). Focus stays on the source pane so the user keeps
 * typing. Returns the new leaf id, or null when the active tab isn't a note
 * (nothing to preview) or the split failed.
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

/** True when this tab belongs to a synced editor+preview pair whose partner is
 *  still open. Reactive (reads the tab store). A group stranded to one member
 *  reads as un-synced, so the indicator clears when either pane closes. */
export function isSyncedTab(tabId: string): boolean {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab?.syncGroupId) return false;
  return tabs.some((t) => t.id !== tabId && t.syncGroupId === tab.syncGroupId);
}

/** True when the note at `path` already has a live "Split with preview" pair
 *  open anywhere. Caps the feature at one synced preview per note: both the
 *  editor and preview panes of a synced note report true, so the action is
 *  hidden for both. Reactive (reads the tab store). */
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
 * Migrate any tab, cached editor state, or history entry that points at
 * `from` to point at `to` instead. Invoked when the file watcher reports
 * an external rename (a `mv` in the terminal, a rename in the file
 * manager, etc.) so that an open tab follows the file rather than
 * becoming a phantom that errors on the next save.
 *
 * The new title is derived from the destination filename, matching how
 * `openTab` callers (App.tsx, MycelialView.tsx) compute
 * the title from a path. We don't try to detect "user-customized
 * titles" because the app doesn't currently support them — every tab
 * title is the basename of its path.
 */
export function renameTabPath(from: string, to: string) {
  if (pathEquals(from, to)) return;

  const newTitle = to.split("/").pop() ?? to;

  setTabs(
    (t) => pathEquals(t.path, from),
    produce((t) => {
      t.path = to;
      t.title = newTitle;
    }),
  );

  // Editor state cache is keyed by tab ID but stores the path alongside
  // the serialized state so cache entries can be invalidated when a tab
  // navigates to a different file. Migrate matching entries so the
  // cached undo history isn't thrown away on rename.
  for (const [tabId, entry] of editorStateCache.entries()) {
    if (pathEquals(entry.path, from)) {
      editorStateCache.set(tabId, { path: to, json: entry.json });
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

// Reading-view zoom bounds. Wider than a browser's own range at the low end —
// pulling a paginated SVG note back far enough to see a whole spread is a real
// use — and stopping at 4× above, past which the SVG page no longer fits any
// pane. `READING_ZOOM_STEP` is the geometric factor one Ctrl+= / wheel notch
// applies, matching the Mycelial view's 1.2.
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

/** Multiply a tab's reading-view zoom by `factor` (one notch in or out).
 *  Geometric rather than additive so a notch feels the same size at 40% as at
 *  300% — the same reason the Mycelial view scales rather than steps. */
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
