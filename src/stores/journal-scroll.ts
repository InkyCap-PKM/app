// ---------------------------------------------------------------------------
// Journal Scroll store — per-tab state for the scrolling note review surface.
//
// Pagination model:
//   * Anchor lives at offset 0 in the sorted query result.
//   * Initial load fetches HALF_BATCH entries before the anchor and
//     HALF_BATCH + 1 entries from the anchor forward (two parallel
//     requests). The view then pins the anchor to the top of the viewport
//     (see `anchorPinNonce`) so the user starts on the note they entered
//     scroll mode on, while still being able to scroll up into the
//     entries loaded before it.
//   * `loadMoreBefore` / `loadMoreAfter` extend `firstOffset` / `lastOffset`
//     by BATCH each call. The backend's strict-offset slice semantics mean
//     a `result.length < limit` response unambiguously indicates "this
//     direction is exhausted" — no leak-through from the other side.
//
// `visibleEntries` is a signal updated by JournalScrollView's
// IntersectionObserver. The right-panel "Scroll Context" tab subscribes to
// it for outline / connections / tag-concentration / citation sub-panes.
// ---------------------------------------------------------------------------

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import { settings } from "./settings";
import type {
  PropertyValueJson,
  ScrollEntry,
  ScrollFilter,
  ScrollQuery,
  ScrollSort,
} from "../lib/types";

export type ScrollMode = "date" | "tree" | "properties";

export type PropertyFilter =
  | { kind: "any"; name: string }
  | { kind: "eq"; name: string; value: PropertyValueJson };

export interface JournalScrollState {
  enabled: boolean;
  mode: ScrollMode;
  /** Only meaningful when `mode === "properties"`. */
  propertyFilter: PropertyFilter | null;
  anchorPath: string;
  entries: ScrollEntry[];
  /** Most-negative offset (relative to anchor) we've issued a request for. */
  firstOffset: number;
  /** Most-positive offset we've issued a request for. */
  lastOffset: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loading: boolean;
  /** Notebox paths of currently in-view entries; updated by an
   *  IntersectionObserver on each entry frame. */
  visibleEntries: string[];
  /** Scroll-local navigation history — the notes the user has jumped
   *  between via wikilink clicks *inside* the scroll. Drives the header
   *  back/forward arrows while scroll is enabled; the tab's own file
   *  history is irrelevant inside a scroll. */
  navBack: string[];
  navForward: string[];
  /** The note the within-scroll navigation currently considers "current"
   *  (the most recent jump target, or the anchor before any jump). Needed
   *  to know what to push onto the opposite stack on back/forward. */
  navCurrent: string;
  /** A pending request for the view to scroll a path to the top, issued by
   *  `scrollNavBack` / `scrollNavForward`. The `nonce` makes repeated
   *  requests for the same path distinct so the view's effect re-fires.
   *  The view consumes (clears) it via `consumeScrollNavRequest`. */
  scrollNavRequest: { path: string; nonce: number } | null;
  /** Bumped each time `loadInitial` rebuilds the result set. The view
   *  watches it and, on a change, pins the anchor entry to the top of the
   *  viewport through the asynchronous per-entry compiles. */
  anchorPinNonce: number;
}

const HALF_BATCH = 5;
const BATCH = 10;

// Monotonic counter feeding `JournalScrollState.anchorPinNonce` — one bump
// per result-set rebuild so the view can observe each as a distinct event.
let anchorPinCounter = 0;

// Per-tab last-known scroll position. Survives tab-switch unmounts so that
// when the user returns to a Journal Scroll tab they land where they left
// off — switching tabs unmounts the entire <TypstEditor>, taking the scroll
// container's `scrollTop` with it. The map is non-reactive on purpose: the
// view writes via `saveScrollPosition` on every scroll, but no component
// re-renders when this changes. The store resets the entry to 0 whenever
// the loaded result set is rebuilt (mode change, filter change, anchor
// move), so the user doesn't land at an offset that no longer maps onto
// the same content.
const savedScrollByTab = new Map<string, number>();

export function saveScrollPosition(tabId: string, top: number) {
  savedScrollByTab.set(tabId, top);
}

export function getSavedScrollPosition(tabId: string): number {
  return savedScrollByTab.get(tabId) ?? 0;
}

function resetSavedScroll(tabId: string) {
  savedScrollByTab.set(tabId, 0);
}

const [scrollStates, setScrollStates] = createStore<
  Record<string, JournalScrollState>
>({});

// Signals to drive reactivity through the Record<string, ...> store; we bump
// these manually after each mutation so consumers reading by tabId re-track.
const [scrollVersion, setScrollVersion] = createSignal(0);
const [visibleVersion, setVisibleVersion] = createSignal(0);
const bump = () => setScrollVersion((v) => v + 1);
const bumpVisible = () => setVisibleVersion((v) => v + 1);

// === Selectors ===

export function getState(tabId: string): JournalScrollState | undefined {
  scrollVersion();
  return scrollStates[tabId];
}

export function isEnabled(tabId: string): boolean {
  scrollVersion();
  return scrollStates[tabId]?.enabled ?? false;
}

export function getMode(tabId: string): ScrollMode {
  scrollVersion();
  return scrollStates[tabId]?.mode ?? "date";
}

export function getPropertyFilter(tabId: string): PropertyFilter | null {
  scrollVersion();
  return scrollStates[tabId]?.propertyFilter ?? null;
}

export function getEntries(tabId: string): ScrollEntry[] {
  scrollVersion();
  return scrollStates[tabId]?.entries ?? [];
}

export function getAnchorPath(tabId: string): string {
  scrollVersion();
  return scrollStates[tabId]?.anchorPath ?? "";
}

export function isLoading(tabId: string): boolean {
  scrollVersion();
  return scrollStates[tabId]?.loading ?? false;
}

export function hasMoreBefore(tabId: string): boolean {
  scrollVersion();
  return scrollStates[tabId]?.hasMoreBefore ?? false;
}

export function hasMoreAfter(tabId: string): boolean {
  scrollVersion();
  return scrollStates[tabId]?.hasMoreAfter ?? false;
}

export function getVisibleEntries(tabId: string): string[] {
  visibleVersion();
  return scrollStates[tabId]?.visibleEntries ?? [];
}

// === Query construction ===

function buildSort(): ScrollSort {
  switch (settings.journal_scroll.date_sort) {
    case "modified":
      return { kind: "property", name: "file.mtime", direction: "desc" };
    case "zid":
      return { kind: "zid" };
    case "created":
    default:
      return { kind: "property", name: "file.ctime", direction: "desc" };
  }
}

function buildFilter(state: JournalScrollState): ScrollFilter {
  switch (state.mode) {
    case "date":
      return { kind: "all" };
    case "tree": {
      const parts = state.anchorPath.split("/");
      parts.pop();
      const folder = parts.join("/");
      return {
        kind: "folder",
        path: folder,
        recursive: settings.journal_scroll.tree_scope === "recursive",
      };
    }
    case "properties": {
      const f = state.propertyFilter;
      // No filter yet → fall through to All so the view shows something
      // (the pill UI normally requires the user to pick a filter before
      // committing to Properties mode; this is a safety net).
      if (!f) return { kind: "all" };
      if (f.kind === "any") return { kind: "property_any", name: f.name };
      return { kind: "property_eq", name: f.name, value: f.value };
    }
  }
}

function buildQuery(
  state: JournalScrollState,
  offset: number,
  limit: number,
): ScrollQuery {
  return {
    filter: buildFilter(state),
    sort: buildSort(),
    anchor: state.anchorPath,
    offset,
    limit,
  };
}

/** Look up a target path's offset in the same sorted result the scroll
 *  uses, without mutating any state. Returns `null` when the target is
 *  not in the current query. The wikilink-click handler uses this to
 *  decide whether to extend the loaded window toward the target or fall
 *  through to a new tab. */
export async function findOffsetForTarget(
  tabId: string,
  targetPath: string,
): Promise<number | null> {
  const state = scrollStates[tabId];
  if (!state) return null;
  try {
    return await ipc.findOffsetInScrollQuery({
      filter: buildFilter(state),
      sort: buildSort(),
      anchor: state.anchorPath,
      target: targetPath,
    });
  } catch (err) {
    console.error("findOffsetForTarget failed:", err);
    return null;
  }
}

/** Read-only accessors for the pagination cursors. The wikilink-click
 *  loader needs these to decide which direction to page in. */
export function getFirstOffset(tabId: string): number {
  scrollVersion();
  return scrollStates[tabId]?.firstOffset ?? 0;
}
export function getLastOffset(tabId: string): number {
  scrollVersion();
  return scrollStates[tabId]?.lastOffset ?? 0;
}

/** Nonce bumped on every result-set rebuild; the view pins the anchor to
 *  the top of the viewport whenever this changes. */
export function getAnchorPinNonce(tabId: string): number {
  scrollVersion();
  return scrollStates[tabId]?.anchorPinNonce ?? 0;
}

// === Loading ===

async function loadInitial(tabId: string) {
  const state = scrollStates[tabId];
  if (!state) return;

  // Rebuilding the result set: a saved scroll position from a previous
  // load no longer maps onto the same content. Reset so the view starts
  // at the top.
  resetSavedScroll(tabId);

  setScrollStates(
    produce((s) => {
      s[tabId].loading = true;
      s[tabId].entries = [];
      s[tabId].firstOffset = -HALF_BATCH;
      s[tabId].lastOffset = HALF_BATCH;
      s[tabId].hasMoreBefore = true;
      s[tabId].hasMoreAfter = true;
      s[tabId].visibleEntries = [];
      // The result set is being rebuilt — within-scroll navigation history
      // no longer maps onto it. Reset to a clean state anchored on the
      // (possibly new) anchor.
      s[tabId].navBack = [];
      s[tabId].navForward = [];
      s[tabId].navCurrent = s[tabId].anchorPath;
      s[tabId].scrollNavRequest = null;
    }),
  );
  bump();
  bumpVisible();

  // Two parallel unidirectional requests. The split avoids ambiguous
  // clipping at the anchor boundary that a single centered request would
  // introduce — we'd be unable to tell whether "got fewer than asked for"
  // meant we hit the start or the end of the sorted list.
  try {
    const [before, fromAnchor] = await Promise.all([
      ipc.runScrollQuery(buildQuery(state, -HALF_BATCH, HALF_BATCH)),
      ipc.runScrollQuery(buildQuery(state, 0, HALF_BATCH + 1)),
    ]);

    // It's possible the state was cleaned up while loading; re-check.
    if (!scrollStates[tabId]) return;

    setScrollStates(
      produce((s) => {
        s[tabId].entries = [...before, ...fromAnchor];
        s[tabId].hasMoreBefore = before.length === HALF_BATCH;
        s[tabId].hasMoreAfter = fromAnchor.length === HALF_BATCH + 1;
        s[tabId].loading = false;
        // Signal the view to pin the anchor to the top of the viewport
        // (entries before the anchor were just loaded above it). The
        // nonce makes every rebuild a distinct, observable event.
        s[tabId].anchorPinNonce = ++anchorPinCounter;
      }),
    );
    bump();
  } catch (err) {
    console.error("Journal scroll initial load failed:", err);
    setScrollStates(
      produce((s) => {
        if (s[tabId]) s[tabId].loading = false;
      }),
    );
    bump();
  }
}

export async function loadMoreAfter(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || state.loading || !state.hasMoreAfter) return;

  setScrollStates(
    produce((s) => {
      s[tabId].loading = true;
    }),
  );
  bump();

  const nextOffset = state.lastOffset + 1;
  try {
    const newEntries = await ipc.runScrollQuery(
      buildQuery(state, nextOffset, BATCH),
    );
    if (!scrollStates[tabId]) return;
    setScrollStates(
      produce((s) => {
        s[tabId].entries = [...s[tabId].entries, ...newEntries];
        s[tabId].lastOffset = nextOffset + BATCH - 1;
        s[tabId].hasMoreAfter = newEntries.length === BATCH;
        s[tabId].loading = false;
      }),
    );
    bump();
  } catch (err) {
    console.error("Journal scroll loadMoreAfter failed:", err);
    setScrollStates(
      produce((s) => {
        if (s[tabId]) s[tabId].loading = false;
      }),
    );
    bump();
  }
}

export async function loadMoreBefore(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || state.loading || !state.hasMoreBefore) return;

  setScrollStates(
    produce((s) => {
      s[tabId].loading = true;
    }),
  );
  bump();

  const requestOffset = state.firstOffset - BATCH;
  try {
    const newEntries = await ipc.runScrollQuery(
      buildQuery(state, requestOffset, BATCH),
    );
    if (!scrollStates[tabId]) return;
    setScrollStates(
      produce((s) => {
        s[tabId].entries = [...newEntries, ...s[tabId].entries];
        s[tabId].firstOffset = requestOffset;
        s[tabId].hasMoreBefore = newEntries.length === BATCH;
        s[tabId].loading = false;
      }),
    );
    bump();
  } catch (err) {
    console.error("Journal scroll loadMoreBefore failed:", err);
    setScrollStates(
      produce((s) => {
        if (s[tabId]) s[tabId].loading = false;
      }),
    );
    bump();
  }
}

// === Mutations ===

export async function toggleScroll(tabId: string, anchorPath: string) {
  const current = scrollStates[tabId];
  if (current?.enabled) {
    setScrollStates(
      produce((s) => {
        if (s[tabId]) s[tabId].enabled = false;
      }),
    );
    resetSavedScroll(tabId);
    bump();
    return;
  }
  setScrollStates(
    produce((s) => {
      s[tabId] = {
        enabled: true,
        mode: "date",
        propertyFilter: null,
        anchorPath,
        entries: [],
        firstOffset: 0,
        lastOffset: HALF_BATCH,
        hasMoreBefore: true,
        hasMoreAfter: true,
        loading: true,
        visibleEntries: [],
        navBack: [],
        navForward: [],
        navCurrent: anchorPath,
        scrollNavRequest: null,
        anchorPinNonce: 0,
      };
    }),
  );
  bump();
  await loadInitial(tabId);
}

export async function setMode(tabId: string, mode: ScrollMode) {
  const state = scrollStates[tabId];
  if (!state || state.mode === mode) return;
  setScrollStates(
    produce((s) => {
      s[tabId].mode = mode;
      // Clear property filter when leaving Properties mode; setPropertyFilter
      // is the authority for setting it when entering.
      if (mode !== "properties") s[tabId].propertyFilter = null;
    }),
  );
  bump();
  await loadInitial(tabId);
}

export async function setPropertyFilter(
  tabId: string,
  filter: PropertyFilter,
) {
  const state = scrollStates[tabId];
  if (!state) return;
  setScrollStates(
    produce((s) => {
      s[tabId].mode = "properties";
      s[tabId].propertyFilter = filter;
    }),
  );
  bump();
  await loadInitial(tabId);
}

export async function clearPropertyFilter(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || !state.propertyFilter) return;
  // Clearing the property filter while in Properties mode falls back to
  // Date mode — the only mode that doesn't require any extra configuration.
  setScrollStates(
    produce((s) => {
      s[tabId].propertyFilter = null;
      s[tabId].mode = "date";
    }),
  );
  bump();
  await loadInitial(tabId);
}


export async function updateAnchor(tabId: string, newAnchorPath: string) {
  const state = scrollStates[tabId];
  if (!state || !state.enabled) return;
  if (state.anchorPath === newAnchorPath) return;
  setScrollStates(
    produce((s) => {
      s[tabId].anchorPath = newAnchorPath;
    }),
  );
  bump();
  await loadInitial(tabId);
}

// === Within-scroll navigation ===
//
// While scroll is enabled, the header back/forward arrows operate on this
// per-tab history of wikilink jumps *inside* the scroll, not the tab's file
// history. A jump records the note it was made *from* (so "back" returns to
// the note the user clicked the link in), and a back/forward step issues a
// `scrollNavRequest` the view picks up to scroll the target to the top.

let navNonce = 0;

export function canScrollNavBack(tabId: string): boolean {
  scrollVersion();
  return (scrollStates[tabId]?.navBack.length ?? 0) > 0;
}

export function canScrollNavForward(tabId: string): boolean {
  scrollVersion();
  return (scrollStates[tabId]?.navForward.length ?? 0) > 0;
}

/** Record a within-scroll wikilink jump from `fromPath` to `toPath`. The
 *  source note goes on the back stack and the forward stack is cleared,
 *  matching browser-style history. */
export function recordScrollNavigation(
  tabId: string,
  fromPath: string,
  toPath: string,
) {
  if (!scrollStates[tabId] || fromPath === toPath) return;
  setScrollStates(
    produce((s) => {
      s[tabId].navBack.push(fromPath);
      s[tabId].navForward = [];
      s[tabId].navCurrent = toPath;
    }),
  );
  bump();
}

export function scrollNavBack(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || state.navBack.length === 0) return;
  setScrollStates(
    produce((s) => {
      const prev = s[tabId].navBack.pop()!;
      s[tabId].navForward.push(s[tabId].navCurrent);
      s[tabId].navCurrent = prev;
      s[tabId].scrollNavRequest = { path: prev, nonce: ++navNonce };
    }),
  );
  bump();
}

export function scrollNavForward(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || state.navForward.length === 0) return;
  setScrollStates(
    produce((s) => {
      const next = s[tabId].navForward.pop()!;
      s[tabId].navBack.push(s[tabId].navCurrent);
      s[tabId].navCurrent = next;
      s[tabId].scrollNavRequest = { path: next, nonce: ++navNonce };
    }),
  );
  bump();
}

export function getScrollNavRequest(
  tabId: string,
): { path: string; nonce: number } | null {
  scrollVersion();
  return scrollStates[tabId]?.scrollNavRequest ?? null;
}

/** Clear a consumed scroll-nav request so it isn't replayed (e.g. on a
 *  later view remount). Called by the view once it has acted on it. */
export function consumeScrollNavRequest(tabId: string) {
  if (!scrollStates[tabId]?.scrollNavRequest) return;
  setScrollStates(
    produce((s) => {
      s[tabId].scrollNavRequest = null;
    }),
  );
  bump();
}

/** Called by JournalScrollView's IntersectionObserver each time the set of
 *  in-view entries changes. The right-panel "Scroll Context" tab subscribes
 *  via `getVisibleEntries(tabId)`. */
export function setVisibleEntries(tabId: string, paths: string[]) {
  const state = scrollStates[tabId];
  if (!state) return;
  // Avoid bumping when nothing changed — IntersectionObserver can fire often
  // and the right-panel sub-queries (citations, outline) are non-trivial.
  if (
    state.visibleEntries.length === paths.length &&
    state.visibleEntries.every((p, i) => p === paths[i])
  ) {
    return;
  }
  setScrollStates(
    produce((s) => {
      s[tabId].visibleEntries = paths;
    }),
  );
  bumpVisible();
}

export function cleanup(tabId: string) {
  setScrollStates(
    produce((s) => {
      delete s[tabId];
    }),
  );
  savedScrollByTab.delete(tabId);
  bump();
  bumpVisible();
}
