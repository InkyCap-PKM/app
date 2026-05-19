// ---------------------------------------------------------------------------
// Journal Scroll store — per-tab state for the scrolling note review surface.
//
// Pagination model — *one-directional*:
//   * The anchor lives at offset 0 in the sorted result and is always the
//     first (top) row. The feed only ever unfolds *downward* from it; there
//     is no loading of entries above the anchor. This is deliberate: an
//     entry compiling above the viewport would shove the reader's content
//     down (the feed "jumps back"), and there is no reliable scroll gesture
//     to trigger an upward load anyway. To see notes on the other temporal
//     side of the anchor, the user flips `dateDirection` (the pill's
//     date-direction toggle) or re-anchors.
//   * `loadMoreAfter` extends `lastOffset` by BATCH each call. The backend's
//     strict-offset slice semantics mean a `result.length < limit` response
//     unambiguously indicates the feed is exhausted.
//   * `dateDirection` chooses whether downward = older (`desc`, the default
//     "recent → past") or newer (`asc`, "past → recent"). It is the sort
//     direction handed to every `ScrollQuery`.
//   * Merges dedupe by path: a sort property that mutates between paginated
//     queries (e.g. `file.mtime` after an edit) can otherwise shift the
//     sorted list so a later page re-returns an already-loaded note.
//
// `visibleEntries` is a signal updated by JournalScrollView's
// IntersectionObserver. The right-panel "Scroll Context" tab subscribes to
// it for outline / connections / tag-concentration / citation sub-panes.
// ---------------------------------------------------------------------------

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import { settings } from "./settings";
import { creationRules } from "./creation-rules";
import type {
  ScrollEntry,
  ScrollFilter,
  ScrollQuery,
  ScrollSort,
  SortDir,
} from "../lib/types";

export interface JournalScrollState {
  enabled: boolean;
  anchorPath: string;
  entries: ScrollEntry[];
  /** Most-positive offset (relative to anchor) we've issued a request for.
   *  The feed is one-directional, so the cursor only ever moves forward. */
  lastOffset: number;
  hasMoreAfter: boolean;
  loading: boolean;
  /** Sort direction of the date feed. `desc` = recent→past (downward scroll
   *  shows older notes, the default); `asc` = past→recent. Toggled per-tab
   *  by the pill's date-direction button. */
  dateDirection: SortDir;
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

const BATCH = 10;
// Entries fetched from the anchor forward on the initial (anchor-first)
// load — the anchor row plus BATCH rows after it.
const INITIAL_FORWARD = BATCH + 1;

// Monotonic counter feeding `JournalScrollState.anchorPinNonce` — one bump
// per result-set rebuild so the view can observe each as a distinct event.
let anchorPinCounter = 0;

// Per-tab last-known scroll position. Survives tab-switch unmounts so that
// when the user returns to a Journal Scroll tab they land where they left
// off — switching tabs unmounts the entire <TypstEditor>, taking the scroll
// container's `scrollTop` with it.
//
// The position is stored *entry-anchored*, not as a raw pixel `scrollTop`:
// the path of the entry at the top of the viewport plus the pixel offset of
// that entry's top edge relative to the viewport top. A raw pixel value is
// unrestorable on remount — entries compile asynchronously, so entries above
// the restore point may still be short placeholders and the same `scrollTop`
// would land somewhere else entirely. An entry + offset can be re-pinned
// precisely once that one entry's frame exists, regardless of what is or
// isn't rendered above it.
//
// The map is non-reactive on purpose: the view writes on every scroll, but
// no component re-renders when it changes. The store clears the entry
// whenever the result set is rebuilt (sort/scope change, anchor move).
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

export function getVisibleEntries(tabId: string): string[] {
  visibleVersion();
  return scrollStates[tabId]?.visibleEntries ?? [];
}

// === Query construction ===

// `date_sort` (a user setting) picks the sort *key*; `direction` (the
// per-tab date-direction toggle) picks the *order*. Every sort variant
// carries the direction — `desc` is recent-first, `asc` reverses it.
function buildSort(direction: SortDir): ScrollSort {
  switch (settings.journal_scroll.date_sort) {
    case "modified":
      return { kind: "property", name: "file.mtime", direction };
    case "zid":
      return { kind: "zid", direction };
    case "note_date":
      // The `date` property authored in `#note(date: ...)`. Datetime values
      // are stringified to ISO `YYYY-MM-DD` by lib.typ, so a lexicographic
      // compare orders them chronologically.
      return { kind: "property", name: "date", direction };
    case "created":
    default:
      return { kind: "property", name: "file.ctime", direction };
  }
}

/** The folder the Daily Note creation rule writes into. The rule's
 *  `target_folder` may interpolate date variables (e.g. `daily/{{date:YYYY}}`);
 *  the scope is the static prefix before the first variable. Empty when no
 *  daily-note rule is present or it has a fully dynamic target. */
export function dailyNotesFolder(): string {
  const rule = creationRules().find((r) => r.id === "daily-note");
  if (!rule) return "";
  const target = rule.target_folder;
  const varIdx = target.indexOf("{{");
  const prefix = varIdx >= 0 ? target.slice(0, varIdx) : target;
  return prefix.replace(/\/+$/, "");
}

/** Resolve the notebox-relative folder the scroll is scoped to, or `null`
 *  for the whole notebox. Driven entirely by the user's "Anchor scope"
 *  setting — the scroll itself no longer has per-tab modes. */
function scopeFolder(): string | null {
  switch (settings.journal_scroll.anchor_scope) {
    case "daily": {
      const folder = dailyNotesFolder();
      return folder || null;
    }
    case "custom": {
      const folder = settings.journal_scroll.custom_scope_folder.trim();
      return folder || null;
    }
    case "all":
    default:
      return null;
  }
}

function buildFilter(): ScrollFilter {
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
    filter: buildFilter(),
    sort: buildSort(state.dateDirection),
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
      filter: buildFilter(),
      sort: buildSort(state.dateDirection),
      anchor: state.anchorPath,
      target: targetPath,
    });
  } catch (err) {
    console.error("findOffsetForTarget failed:", err);
    return null;
  }
}

/** Read-only accessor for the forward pagination cursor — the most-positive
 *  offset loaded so far. The wikilink-click loader uses it to know how far
 *  the feed must extend to reach a target. */
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
      s[tabId].lastOffset = INITIAL_FORWARD - 1;
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

  // One unidirectional request for the anchor and the rows after it.
  // Nothing is ever loaded above the anchor — it sits at the top of the
  // viewport with no asynchronously-growing content to displace it.
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
        // Dedupe against already-loaded paths: if the sort property
        // mutated between pages the slice can re-return a loaded note.
        // `hasMoreAfter` still keys off the raw response length — that is
        // the backend's strict-offset edge signal, independent of dupes.
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

/** Re-anchor the scroll on `targetPath` without clearing the
 *  back/forward navigation history. Used by in-scroll wikilink
 *  navigation where the caller manages the nav stack separately. */
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

/** Reposition the scroll viewport at the anchor entry — the note the scroll
 *  was originally opened from. Issues a `scrollNavRequest` the view consumes
 *  (paging the loaded window toward the anchor first if it has scrolled out
 *  of range). This is a pure viewport jump: it deliberately does *not* touch
 *  the within-scroll back/forward history. */
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
