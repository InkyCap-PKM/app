// ---------------------------------------------------------------------------
// Journal Scroll store: per-tab state for the scrolling review view.
//
// The feed grows in one direction:
//   * The anchor is offset 0 and always the first row; entries only load below
//     it. Content loading above would push the reader's place down. To see the
//     other side in time, flip `dateDirection` or re-anchor.
//   * `loadMoreAfter` extends `lastOffset` by BATCH. The backend's strict
//     slicing means a response shorter than `limit` is the end.
//   * `dateDirection`: `desc` (default) shows older notes going down, `asc`
//     newer. It is the sort direction of every `ScrollQuery`.
//   * `scope`: `timeline` holds every note in the "Anchor scope" setting;
//     `neighbourhood` the anchor plus the notes it links to and from, with the
//     anchor first.
//   * Merges skip paths already loaded, since a sort property that changes
//     between pages (e.g. `file.mtime`) can repeat a note.
//
// `visibleEntries` is updated by JournalScrollView's IntersectionObserver; the
// Scroll Context tab reads it.
// ---------------------------------------------------------------------------

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import { noteboxSettings } from "./settings";
import { creationRules } from "./creation-rules";
import type {
  ScrollEntry,
  ScrollFilter,
  ScrollQuery,
  ScrollSort,
  SortDir,
} from "../lib/types";

/** Which notes a Journal Scroll holds; see the header comment. */
export type ScrollScope = "timeline" | "neighbourhood";

export interface JournalScrollState {
  enabled: boolean;
  scope: ScrollScope;
  anchorPath: string;
  entries: ScrollEntry[];
  /** Most-positive offset (relative to anchor) we've issued a request for.
   *  The feed is one-directional, so the cursor only ever moves forward. */
  lastOffset: number;
  hasMoreAfter: boolean;
  loading: boolean;
  /**
   * Date order: `desc` (default) shows older notes going down; `asc` newer. Per
   * tab.
   */
  dateDirection: SortDir;
  /** Notebox paths of currently in-view entries; updated by an
   *  IntersectionObserver on each entry frame. */
  visibleEntries: string[];
  /**
   * Back/forward history of wikilink jumps inside the scroll, for the header
   * arrows while scroll is on.
   */
  navBack: string[];
  navForward: string[];
  /**
   * The note navigation considers current (the last jump target, or the
   * anchor), pushed onto the other stack on back/forward.
   */
  navCurrent: string;
  /**
   * A request for the view to scroll a path to the top, from `scrollNavBack` /
   * `scrollNavForward`. `nonce` makes repeats distinct. Cleared by
   * `consumeScrollNavRequest`.
   */
  scrollNavRequest: { path: string; nonce: number } | null;
  /**
   * Bumped when `loadInitial` rebuilds the results; the view then pins the
   * anchor to the top while entries compile.
   */
  anchorPinNonce: number;
}

const BATCH = 10;
// Entries fetched from the anchor forward on the initial (anchor-first)
// load — the anchor row plus BATCH rows after it.
const INITIAL_FORWARD = BATCH + 1;

// Monotonic counter feeding `JournalScrollState.anchorPinNonce` — one bump
// per result-set rebuild so the view can observe each as a distinct event.
let anchorPinCounter = 0;

// Last scroll position per tab, kept across the unmount a tab switch causes.
//
// Stored as the top visible entry's path and its offset from the viewport top,
// not a pixel `scrollTop`: after a remount, entries above may still be
// placeholders, but one entry and an offset can be restored once that entry
// exists.
//
// Not reactive: the view writes it on every scroll. Cleared whenever the
// results are rebuilt.
export interface SavedScrollPosition {
  /** Notebox path of the entry pinned to the top of the viewport. */
  path: string;
  /** Pixel offset of that entry's top edge from the viewport's top edge
   *  (≤ 0 when the entry is scrolled partly above the top). */
  offset: number;
}

const savedScrollByTab = new Map<string, SavedScrollPosition>();

export function saveScrollPosition(tabId: string, pos: SavedScrollPosition) {
  savedScrollByTab.set(tabId, pos);
}

export function getSavedScrollPosition(
  tabId: string,
): SavedScrollPosition | null {
  return savedScrollByTab.get(tabId) ?? null;
}

function resetSavedScroll(tabId: string) {
  savedScrollByTab.delete(tabId);
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

export function hasMoreAfter(tabId: string): boolean {
  scrollVersion();
  return scrollStates[tabId]?.hasMoreAfter ?? false;
}

/** Current date-feed direction for a tab (`desc` = recent→past). */
export function getScrollDirection(tabId: string): SortDir {
  scrollVersion();
  return scrollStates[tabId]?.dateDirection ?? "desc";
}

/** Current scope of a tab's scroll (Timeline or Neighbourhood). */
export function getScrollScope(tabId: string): ScrollScope {
  scrollVersion();
  return scrollStates[tabId]?.scope ?? "timeline";
}

export function getVisibleEntries(tabId: string): string[] {
  visibleVersion();
  return scrollStates[tabId]?.visibleEntries ?? [];
}

// === Query construction ===

// The `date_sort` setting picks the key; the per-tab direction the order.
function buildSort(direction: SortDir): ScrollSort {
  switch (noteboxSettings.journal_scroll.date_sort) {
    case "modified":
      return { kind: "property", name: "file.mtime", direction };
    case "zid":
      return { kind: "zid", direction };
    case "note_date":
      // `#note(date: ...)`. lib.typ stores dates as `YYYY-MM-DD`, so string
      // order is date order.
      return { kind: "property", name: "date", direction };
    case "created":
    default:
      return { kind: "property", name: "file.ctime", direction };
  }
}

/**
 * The Daily Note rule's folder: the static part of its `target_folder` before
 * the first variable (e.g. `daily` for `daily/{{date:YYYY}}`). Empty without
 * such a rule or with a fully variable folder.
 */
export function dailyNotesFolder(): string {
  const rule = creationRules().find((r) => r.id === "daily-note");
  if (!rule) return "";
  const target = rule.target_folder;
  const varIdx = target.indexOf("{{");
  const prefix = varIdx >= 0 ? target.slice(0, varIdx) : target;
  return prefix.replace(/\/+$/, "");
}

/**
 * The notebox-relative folder the scroll is limited to, or `null` for the whole
 * notebox, from the "Anchor scope" setting.
 */
function scopeFolder(): string | null {
  switch (noteboxSettings.journal_scroll.anchor_scope) {
    case "daily": {
      const folder = dailyNotesFolder();
      return folder || null;
    }
    case "custom": {
      const folder = noteboxSettings.journal_scroll.custom_scope_folder.trim();
      return folder || null;
    }
    case "all":
    default:
      return null;
  }
}

function buildFilter(state: JournalScrollState): ScrollFilter {
  if (state.scope === "neighbourhood") {
    return { kind: "neighbourhood", note: state.anchorPath };
  }
  const folder = scopeFolder();
  if (folder === null) return { kind: "all" };
  return { kind: "folder", path: folder, recursive: true };
}

function buildQuery(
  state: JournalScrollState,
  offset: number,
  limit: number,
): ScrollQuery {
  return {
    filter: buildFilter(state),
    sort: buildSort(state.dateDirection),
    anchor: state.anchorPath,
    offset,
    limit,
  };
}

/**
 * A target's offset in the scroll's sorted results, without changing state;
 * `null` if it isn't there. The wikilink handler uses it to decide between
 * paging to the target and opening a new tab.
 */
export async function findOffsetForTarget(
  tabId: string,
  targetPath: string,
): Promise<number | null> {
  const state = scrollStates[tabId];
  if (!state) return null;
  try {
    return await ipc.findOffsetInScrollQuery({
      filter: buildFilter(state),
      sort: buildSort(state.dateDirection),
      anchor: state.anchorPath,
      target: targetPath,
    });
  } catch (err) {
    console.error("findOffsetForTarget failed:", err);
    return null;
  }
}

/** The furthest offset loaded so far. */
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

  // A saved position from before no longer matches; start at the top.
  resetSavedScroll(tabId);

  setScrollStates(
    produce((s) => {
      s[tabId].loading = true;
      s[tabId].entries = [];
      s[tabId].lastOffset = INITIAL_FORWARD - 1;
      s[tabId].hasMoreAfter = true;
      s[tabId].visibleEntries = [];
      // Navigation history no longer matches; start fresh at the anchor.
      s[tabId].navBack = [];
      s[tabId].navForward = [];
      s[tabId].navCurrent = s[tabId].anchorPath;
      s[tabId].scrollNavRequest = null;
    }),
  );
  bump();
  bumpVisible();

  // One request for the anchor and the rows after it.
  try {
    const fromAnchor = await ipc.runScrollQuery(
      buildQuery(state, 0, INITIAL_FORWARD),
    );

    // It's possible the state was cleaned up while loading; re-check.
    if (!scrollStates[tabId]) return;

    setScrollStates(
      produce((s) => {
        s[tabId].entries = fromAnchor;
        s[tabId].hasMoreAfter = fromAnchor.length === INITIAL_FORWARD;
        s[tabId].loading = false;
        // Signal the view to reset the viewport to the top (the anchor).
        // The nonce makes every rebuild a distinct, observable event.
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
        // Skip notes already loaded. `hasMoreAfter` still uses the raw response
        // length, the backend's end signal.
        const loaded = new Set(s[tabId].entries.map((e) => e.path));
        const fresh = newEntries.filter((e) => !loaded.has(e.path));
        s[tabId].entries = [...s[tabId].entries, ...fresh];
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
        scope: "timeline",
        anchorPath,
        entries: [],
        lastOffset: 0,
        hasMoreAfter: true,
        loading: true,
        dateDirection: "desc",
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

/**
 * Re-anchor on `targetPath`, keeping the back/forward history. Used by
 * in-scroll wikilink navigation.
 */
export async function reanchorForNavigation(
  tabId: string,
  targetPath: string,
) {
  const state = scrollStates[tabId];
  if (!state || !state.enabled) return;

  resetSavedScroll(tabId);

  // Snapshot the nav state before loadInitial resets it.
  const navBack = [...(state.navBack ?? [])];
  const navForward = [...(state.navForward ?? [])];
  const navCurrent = state.navCurrent;

  setScrollStates(
    produce((s) => {
      s[tabId].anchorPath = targetPath;
    }),
  );
  bump();
  await loadInitial(tabId);

  // Restore navigation history.
  setScrollStates(
    produce((s) => {
      s[tabId].navBack = navBack;
      s[tabId].navForward = navForward;
      s[tabId].navCurrent = navCurrent;
    }),
  );
  bump();
}

/** Flip the date-feed direction (recent→past ⇄ past→recent) and rebuild.
 *  The anchor stays put; only which temporal side unfolds downward changes. */
export async function toggleScrollDirection(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || !state.enabled) return;
  setScrollStates(
    produce((s) => {
      s[tabId].dateDirection =
        s[tabId].dateDirection === "desc" ? "asc" : "desc";
    }),
  );
  bump();
  await loadInitial(tabId);
}

/** Switch the scroll between Timeline and Neighbourhood and rebuild. The
 *  anchor and date direction stay as they are. */
export async function setScrollScope(tabId: string, scope: ScrollScope) {
  const state = scrollStates[tabId];
  if (!state || !state.enabled || state.scope === scope) return;
  setScrollStates(
    produce((s) => {
      s[tabId].scope = scope;
    }),
  );
  bump();
  await loadInitial(tabId);
}

// === Within-scroll navigation ===
//
// While scroll is on, the back/forward arrows use this per-tab history of
// wikilink jumps. A jump records the note it was made from, and a step issues a
// `scrollNavRequest` for the view.

let navNonce = 0;

export function canScrollNavBack(tabId: string): boolean {
  scrollVersion();
  return (scrollStates[tabId]?.navBack.length ?? 0) > 0;
}

export function canScrollNavForward(tabId: string): boolean {
  scrollVersion();
  return (scrollStates[tabId]?.navForward.length ?? 0) > 0;
}

/**
 * Record a jump from `fromPath` to `toPath`: the source goes on the back stack
 * and the forward stack is cleared, as in a browser.
 */
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

/**
 * Scroll back to the anchor (the note the scroll was opened from) through a
 * `scrollNavRequest`, without changing back/forward history.
 */
export function scrollToAnchor(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || !state.anchorPath) return;
  setScrollStates(
    produce((s) => {
      s[tabId].scrollNavRequest = {
        path: s[tabId].anchorPath,
        nonce: ++navNonce,
      };
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

/**
 * Called by JournalScrollView's IntersectionObserver when the visible entries
 * change; read with `getVisibleEntries(tabId)`.
 */
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
