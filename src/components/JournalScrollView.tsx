// ---------------------------------------------------------------------------
// JournalScrollView — continuous, infinite-scrolling list of related notes.
//
// Render pipeline: each entry is compiled to HTML via the same Typst path
// reading mode's continuous-HTML view uses (`compileTypstHtml`). A
// bounded-concurrency render queue caps how many compiles run at once, and
// a module-level LRU cache by path keeps recently-rendered output around so
// that scrolling back to an earlier entry is instant. The cache invalidates
// on `notebox:file-changed`.
//
// Pagination: the feed is one-directional. The anchor is always the first
// row; a single bottom IntersectionObserver sentinel drives `loadMoreAfter`
// as the user scrolls down. Nothing is ever loaded above the anchor.
//
// Scroll anchoring: entries compile asynchronously and grow from short
// placeholders to full notes. WebKitGTK has no native CSS scroll anchoring,
// so a `scrollAnchorRO` ResizeObserver manually folds the growth of any
// entry above the viewport into `scrollTop` — without it the feed visibly
// jumps back to an earlier note as off-screen entries finish compiling.
// ---------------------------------------------------------------------------

import { errorText } from "../lib/errors";
import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import * as ipc from "../lib/ipc";
import { pathEquals } from "../lib/paths";
import { useI18n, tPlural } from "../lib/i18n";
import { onFileChanged } from "../lib/events";
import { showWikilinkContextMenu } from "../lib/wikilink-nav";
import {
  consumeScrollNavRequest,
  findOffsetForTarget,
  getAnchorPath,
  getAnchorPinNonce,
  getEntries,
  getSavedScrollPosition,
  getScrollNavRequest,
  hasMoreAfter,
  isLoading,
  loadMoreAfter,
  recordScrollNavigation,
  saveScrollPosition,
  setVisibleEntries,
  reanchorForNavigation,
} from "../stores/journal-scroll";
import { openTab } from "../stores/tabs";
import { settings } from "../stores/settings";
import { Anchor, MessageSquareWarning, Tags } from "lucide-solid";
import { SquareArrowOutUpRight, SquareArrowInDownLeft } from "./icons";
import { DiagnosticRow } from "./DiagnosticRow";
import type { ConnectionFlags, ScrollEntry, TypstHtmlResult } from "../lib/types";

// === Module-level render cache + bounded-concurrency queue ===

const MAX_CONCURRENT = 3;
const CACHE_CAP = 50;

/** Path → compiled HTML result. */
const htmlCache = new Map<string, TypstHtmlResult>();

/** Path → set of subscriber callbacks called once when the path's
 *  compilation completes (or fails). Used to coalesce multiple in-flight
 *  requests for the same path. */
const pendingSubscribers = new Map<string, Set<(r: TypstHtmlResult) => void>>();

/** Paths currently queued for rendering but not yet started. */
const renderQueue: string[] = [];
let activeWorkers = 0;

function cacheTouch(path: string, result: TypstHtmlResult) {
  if (htmlCache.has(path)) htmlCache.delete(path); // move-to-front
  htmlCache.set(path, result);
  while (htmlCache.size > CACHE_CAP) {
    // Map iteration order is insertion order; first key is oldest.
    const oldest = htmlCache.keys().next().value;
    if (oldest === undefined) break;
    htmlCache.delete(oldest);
  }
}

function notifySubscribers(path: string, result: TypstHtmlResult) {
  const subs = pendingSubscribers.get(path);
  if (!subs) return;
  pendingSubscribers.delete(path);
  for (const cb of subs) {
    try {
      cb(result);
    } catch (err) {
      console.error("journal-scroll subscriber error:", err);
    }
  }
}

async function runOneWorker() {
  while (renderQueue.length > 0) {
    const path = renderQueue.shift()!;
    if (htmlCache.has(path)) {
      // Already rendered while waiting in queue.
      notifySubscribers(path, htmlCache.get(path)!);
      continue;
    }
    try {
      const result = await ipc.compileTypstHtml(path);
      cacheTouch(path, result);
      notifySubscribers(path, result);
    } catch (err) {
      const failResult: TypstHtmlResult = {
        ok: false,
        recovered: false,
        html: "",
        diagnostics: [
          {
            severity: "error",
            message: errorText(err),
            primary: null,
            trace: [],
            hints: [],
          },
        ],
      };
      cacheTouch(path, failResult);
      notifySubscribers(path, failResult);
    }
  }
  activeWorkers--;
}

function requestRender(
  path: string,
  onResult: (r: TypstHtmlResult) => void,
): () => void {
  // Cache hit: short-circuit.
  const cached = htmlCache.get(path);
  if (cached) {
    // Refresh recency.
    cacheTouch(path, cached);
    queueMicrotask(() => onResult(cached));
    return () => {};
  }
  // Subscribe and (if needed) enqueue.
  let subs = pendingSubscribers.get(path);
  if (!subs) {
    subs = new Set();
    pendingSubscribers.set(path, subs);
    renderQueue.push(path);
  }
  subs.add(onResult);

  // Spawn workers up to the cap.
  while (activeWorkers < MAX_CONCURRENT && renderQueue.length > 0) {
    activeWorkers++;
    void runOneWorker();
  }

  return () => {
    const s = pendingSubscribers.get(path);
    if (s) s.delete(onResult);
  };
}

/** Drop a path from the cache and any in-flight subscriptions so the next
 *  view of that entry re-compiles. Called on file-changed events. */
function invalidatePath(path: string) {
  htmlCache.delete(path);
  // Pending compiles will still run; their result populates the cache and
  // any newly-subscribed listeners pick up the latest version. Subscribers
  // already attached get the in-flight result, then a fresh subscription
  // (driven by the file-change effect on the entry) replaces it.
}

// One global file-change listener for the whole app session. Set up lazily
// on first JournalScrollView mount and kept alive — there is no good
// teardown point for a per-tab listener since other tabs may still need it.
let fileChangeListenerInstalled = false;
function ensureFileChangeListener() {
  if (fileChangeListenerInstalled) return;
  fileChangeListenerInstalled = true;
  void onFileChanged((payload) => {
    if (payload.change === "Content") {
      invalidatePath(payload.path);
    }
  });
}

// Module-local visible-paths table, keyed by tabId. Each per-entry
// IntersectionObserver mutates its tab's set and the store's
// `visibleEntries` is published as the union. Local to this module so the
// hack-y global on `window` is avoided.
const visibleByTab = new Map<string, Set<string>>();
function trackVisibility(tabId: string, path: string, isVisible: boolean) {
  let set = visibleByTab.get(tabId);
  if (!set) {
    set = new Set();
    visibleByTab.set(tabId, set);
  }
  if (isVisible) set.add(path);
  else set.delete(path);
  setVisibleEntries(tabId, [...set]);
}

// === View ===

interface JournalScrollViewProps {
  tabId: string;
}

const JournalScrollView: Component<JournalScrollViewProps> = (props) => {
  const t = useI18n();
  let containerRef: HTMLDivElement | undefined;
  let bottomSentinelRef: HTMLDivElement | undefined;
  // Stop fn for the currently-running `holdEntry` correction loop, if any.
  // A new hold cancels the previous so they never fight each other.
  let activeHoldStop: (() => void) | null = null;
  const [flagsByPath, setFlagsByPath] = createSignal<
    Map<string, ConnectionFlags>
  >(new Map());

  // === Manual scroll anchoring ===
  //
  // WebKitGTK — Tauri's webview on Linux — does not implement CSS scroll
  // anchoring (`overflow-anchor`). So when an entry above the viewport
  // finishes compiling and grows from a short placeholder to a full note,
  // the content the user is reading is shoved downward and the feed
  // appears to "jump back" to an earlier note. (A Chrome/Firefox build
  // would get this compensation for free.)
  //
  // This ResizeObserver, installed on every entry frame, folds the height
  // growth of any entry lying fully above the viewport straight into
  // `scrollTop`, holding the visible content still. Unlike `holdEntry` it
  // never releases on user scroll: growth above the fold is phantom
  // content and must be cancelled no matter what the user is doing.
  const entryHeights = new WeakMap<Element, number>();
  const scrollAnchorRO = new ResizeObserver((records) => {
    const container = containerRef;
    if (!container) return;
    // A running `holdEntry` loop already pins an entry by absolute
    // measurement, which subsumes above-the-fold growth — relative
    // compensation on top would double-count. Keep baselines current so
    // there is no spurious jump once the hold ends.
    if (activeHoldStop) {
      for (const rec of records) {
        entryHeights.set(
          rec.target,
          (rec.target as HTMLElement).getBoundingClientRect().height,
        );
      }
      return;
    }
    const cTop = container.getBoundingClientRect().top;
    let delta = 0;
    for (const rec of records) {
      const el = rec.target as HTMLElement;
      const r = el.getBoundingClientRect();
      const prev = entryHeights.get(el);
      entryHeights.set(el, r.height);
      if (prev === undefined) continue; // first callback = baseline
      const grew = r.height - prev;
      // Only fold in growth of an entry fully above the viewport top; a
      // straddling or on-screen entry's growth belongs in view.
      if (grew !== 0 && r.bottom <= cTop + 1) delta += grew;
    }
    if (delta !== 0) container.scrollTop += delta;
  });
  onCleanup(() => scrollAnchorRO.disconnect());

  // `<For>` keys rows by element reference. The store rebuilds its `entries`
  // array on every pagination step, and elements round-tripped through the
  // reactive store do not keep a stable identity — so `<For each={getEntries()}>`
  // would tear down and recreate EVERY entry component on each load-more.
  // Recreated entries reset to placeholders, the feed momentarily collapses,
  // `scrollTop` clamps against the now-short content, and the viewport snaps
  // back toward the anchor. This memo hands `<For>` a per-path-stable object:
  // the same path always yields the same reference, so existing entry
  // components survive a load-more untouched and only new entries mount.
  const entryIdentity = new Map<string, ScrollEntry>();
  const stableEntries = createMemo<ScrollEntry[]>(() => {
    const raw = getEntries(props.tabId);
    const seen = new Set<string>();
    const out: ScrollEntry[] = [];
    for (const e of raw) {
      // Skip a path already emitted this pass. The store dedupes on merge,
      // but guarding here too means a duplicate can never reach `<For>` as
      // two identical references (which it cannot key apart).
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      let stable = entryIdentity.get(e.path);
      if (!stable) {
        stable = { path: e.path, title: e.title };
        entryIdentity.set(e.path, stable);
      }
      out.push(stable);
    }
    // Drop identities for entries no longer loaded so the map can't grow
    // unbounded across a long session of re-anchoring.
    if (entryIdentity.size > seen.size) {
      for (const key of [...entryIdentity.keys()]) {
        if (!seen.has(key)) entryIdentity.delete(key);
      }
    }
    return out;
  });

  onMount(ensureFileChangeListener);

  // On mount: focus the feed (so the keyboard scrolls it right away) and
  // restore the saved scroll position. Restoration re-pins the saved entry
  // to its saved viewport offset via `holdEntry` — a correction loop, not a
  // one-shot `scrollTop` assignment, because entries compile asynchronously
  // and the saved entry and its neighbours grow from placeholders to full
  // height over the first frames after mount; a single assignment would
  // clamp against the still-short content and land near the top.
  onMount(() => {
    if (!containerRef) return;
    containerRef.focus({ preventScroll: true });
    const saved = getSavedScrollPosition(props.tabId);
    if (saved) holdEntry(saved.path, saved.offset);
  });

  onCleanup(() => activeHoldStop?.());

  // Recompute connection flags whenever the loaded entry set or anchor
  // changes. The anchor is read from the store (not a prop) so a re-anchor
  // — e.g. a tree-mode file-tree click — recomputes against the new anchor.
  // One backend call covers all currently-loaded paths.
  createEffect(() => {
    const entries = getEntries(props.tabId);
    const anchor = getAnchorPath(props.tabId);
    if (entries.length === 0 || !anchor) {
      setFlagsByPath(new Map());
      return;
    }
    const paths = entries.map((e) => e.path);
    void (async () => {
      try {
        const flags = await ipc.computeConnectionFlags(anchor, paths);
        const map = new Map<string, ConnectionFlags>();
        for (const f of flags) map.set(f.path, f);
        setFlagsByPath(map);
      } catch (err) {
        console.error("connection flags failed:", err);
      }
    })();
  });

  // Scroll-nav requests: the within-scroll back/forward arrows and the
  // anchor-return button issue a `scrollNavRequest` through the store; here
  // we consume it. The `nonce` makes repeated requests for the same path
  // distinct so this effect re-fires. Request-clearing and async scroll
  // work run untracked so the effect's only dependency is the request.
  //
  // The anchor is always the first row, so a request to return to it is an
  // exact, instant `scrollTop = 0` — no smooth-scroll through a feed of
  // still-compiling, resizing entries (which lands unpredictably).
  createEffect(() => {
    const req = getScrollNavRequest(props.tabId);
    if (!req) return;
    untrack(() => {
      consumeScrollNavRequest(props.tabId);
      if (pathEquals(req.path, getAnchorPath(props.tabId))) {
        activeHoldStop?.();
        if (containerRef) containerRef.scrollTop = 0;
        return;
      }
      void navigateScrollTo(req.path);
    });
  });

  // On every result-set rebuild, reset the viewport to the anchor (the
  // first row) — a plain scrollTop 0.
  //
  // CRITICAL: the `nonce !== prevNonce` guard is load-bearing. Every store
  // mutation calls `bump()`, which ticks the `scrollVersion` signal that
  // *every* journal-scroll selector reads — including `getAnchorPinNonce`.
  // So this `on` effect re-fires on every `bump()` (each `loadMoreAfter`,
  // each loading-flag flip), not only when the nonce changes. Without the
  // guard, `pinAnchorToTop` would run on every pagination step and the feed
  // would snap back to the anchor the instant you scrolled to the bottom.
  // `defer: true` skips the initial run so a tab-return (which restores the
  // saved scroll position) isn't overridden.
  createEffect(
    on(
      () => getAnchorPinNonce(props.tabId),
      (nonce, prevNonce) => {
        if (nonce !== prevNonce && nonce > 0) pinAnchorToTop();
      },
      { defer: true },
    ),
  );

  // Bottom sentinel observer drives downward pagination. The feed is
  // one-directional — there is no top sentinel and nothing loads above the
  // anchor.
  createEffect(() => {
    if (!containerRef || !bottomSentinelRef) return;

    const bottomObserver = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          !isLoading(props.tabId) &&
          hasMoreAfter(props.tabId)
        ) {
          void loadMoreAfter(props.tabId);
        }
      },
      { root: containerRef, rootMargin: "0px 0px 200px 0px" },
    );

    bottomObserver.observe(bottomSentinelRef);
    onCleanup(() => bottomObserver.disconnect());
  });

  // Wikilink click routing (delegated on the container so it covers every
  // entry without per-entry handler installation). Smart routing:
  //   - right-click → wikilink context menu (open-as destinations)
  //   - modifier-click / middle-click → open in new tab
  //   - plain click + target is in the currently-loaded entry window →
  //     smooth-scroll to it
  //   - plain click + target is unresolved or outside the loaded window →
  //     fall through to a new tab (Rule A)
  //
  // Resolution is one `getForwardLinks(source)` call per click. The source
  // is the closest `.journal-scroll__entry` ancestor, identified by its
  // `data-path` attribute. Notebox-wide resolution would also work but
  // forward-links is already cached in the LinkIndex and avoids surfacing a
  // new IPC for a per-click lookup.
  async function handleWikilinkClick(e: MouseEvent) {
    const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      "a.inkycap-wikilink",
    );
    if (!a) return;
    e.preventDefault();
    const entryEl = (
      e.target as HTMLElement | null
    )?.closest<HTMLElement>(".journal-scroll__entry");
    const sourcePath = entryEl?.dataset.path;
    if (!sourcePath) return;
    const rawName = a.dataset.target ?? "";
    if (!rawName) return;
    const baseName = rawName.split("::")[0].split("#")[0].trim();
    if (!baseName) return;
    // Right-click: offer the open-as destinations rather than acting.
    if (e.type === "contextmenu") {
      const label = rawName.includes("::")
        ? rawName.split("::")[1].trim() || undefined
        : undefined;
      showWikilinkContextMenu(e.clientX, e.clientY, baseName, label);
      return;
    }
    let forwardLinks;
    try {
      forwardLinks = await ipc.getForwardLinks(sourcePath);
    } catch (err) {
      console.error("wikilink resolve failed:", err);
      return;
    }
    const match = forwardLinks.find(
      (l) => l.name.toLowerCase() === baseName.toLowerCase(),
    );
    if (!match) return;
    const isModifier = e.ctrlKey || e.metaKey || e.button === 1;
    if (isModifier) {
      openTab(
        { type: "file", title: match.name, path: match.path },
        { forceNewTab: true, newTabAction: true },
      );
      return;
    }
    // Plain click: try to navigate within the scroll (scroll to it if
    // loaded, else page toward it). If that succeeds, record the jump so
    // the header back arrow can return to the note the link was clicked
    // in; if the target isn't in this query at all, fall through to a new
    // tab (Rule A).
    const reached = await navigateScrollTo(match.path);
    if (reached) {
      recordScrollNavigation(props.tabId, sourcePath, match.path);
    } else {
      openTab(
        { type: "file", title: match.name, path: match.path },
        { forceNewTab: true },
      );
    }
  }

  // Navigate within the scroll to `targetPath`: scroll straight to it when
  // already loaded, otherwise re-anchor the scroll on the target so it
  // becomes the first entry. Returns false when the target isn't part of
  // the current query result (caller decides the fallback). Shared by
  // wikilink clicks and the header back/forward arrows.
  async function navigateScrollTo(targetPath: string): Promise<boolean> {
    if (getEntries(props.tabId).some((e) => pathEquals(e.path, targetPath))) {
      scrollToLoadedEntry(targetPath);
      return true;
    }
    // Check whether the target exists in this query at all.
    const targetOffset = await findOffsetForTarget(props.tabId, targetPath);
    if (targetOffset === null) return false;
    // Re-anchor the scroll on the target — clears the current entries
    // and loads a fresh window starting from the target note, preserving
    // the back/forward nav stack.
    await reanchorForNavigation(props.tabId, targetPath);
    return getEntries(props.tabId).some((e) => pathEquals(e.path, targetPath));
  }

  function scrollToLoadedEntry(path: string) {
    if (!containerRef) return;
    const el = containerRef.querySelector(
      `[data-path="${CSS.escape(path)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Hold the entry at `path` pinned to viewport offset `offsetTop` through
  // a per-frame correction loop. Entries compile asynchronously and grow
  // from placeholders to full height; without this the viewport drifts as
  // content above the pinned entry changes size. The loop releases as soon
  // as the user scrolls (wheel / pointer / touch / key) — their intent wins
  // — or after a generous deadline. Used to restore a saved scroll position
  // on tab return (the initial anchor pin needs no loop: the anchor is the
  // first row, so scrollTop 0 alone holds it — see `pinAnchorToTop`). A new
  // hold cancels any hold already running so they never fight `scrollTop`.
  function holdEntry(path: string, offsetTop: number) {
    const container = containerRef;
    if (!container || !path) return;
    activeHoldStop?.();
    const userEvents = ["wheel", "pointerdown", "touchstart", "keydown"];
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const ev of userEvents) container.removeEventListener(ev, stop);
      if (activeHoldStop === stop) activeHoldStop = null;
    };
    for (const ev of userEvents) {
      container.addEventListener(ev, stop, { passive: true });
    }
    activeHoldStop = stop;
    const deadline = performance.now() + 4000;
    const tick = () => {
      if (stopped || containerRef !== container) return;
      const el = container.querySelector(
        `[data-path="${CSS.escape(path)}"]`,
      ) as HTMLElement | null;
      if (el) {
        const delta =
          el.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          offsetTop;
        if (Math.abs(delta) > 0.5) container.scrollTop += delta;
      }
      if (performance.now() < deadline) requestAnimationFrame(tick);
      else stop();
    };
    // Run the first correction synchronously so the very first painted
    // frame is already at the target position — otherwise the view paints
    // at scrollTop 0 for a frame, flashing the top of the feed.
    tick();
  }

  function pinAnchorToTop() {
    // Anchor-first loading makes the anchor the first row, so resetting the
    // viewport to it is simply scrollTop 0. Nothing is loaded above it, so
    // 0 stays correct as the rows below compile and grow — no correction
    // loop. Cancel any restore hold so the two don't fight over scrollTop.
    if (!containerRef) return;
    activeHoldStop?.();
    containerRef.scrollTop = 0;
    // The result set was just rebuilt; the <For> may not have committed
    // yet. A second assignment next frame catches that case.
    requestAnimationFrame(() => {
      if (containerRef) containerRef.scrollTop = 0;
    });
  }

  // Save the scroll position entry-anchored — the topmost visible entry's
  // path plus its pixel offset from the viewport top. A raw `scrollTop`
  // can't be restored after a remount (entries above may still be
  // placeholders), but an entry + offset can.
  //
  // Runs synchronously on every scroll event (no rAF throttle): a throttled
  // capture can be outrun by a tab switch — the unmount lands before the
  // queued frame fires, so the *last* scroll never gets saved and the tab
  // returns to a stale position. The scan breaks at the first entry
  // crossing the viewport top, so it reads only a handful of rects.
  function captureScrollPosition() {
    if (!containerRef) return;
    // Suppress while a programmatic hold is steering scrollTop (the initial
    // position restore): the in-flight value isn't the user's intent and
    // would clobber the saved position we're restoring toward. A real user
    // gesture stops the hold, after which captures resume normally.
    if (activeHoldStop) return;
    const cTop = containerRef.getBoundingClientRect().top;
    const frames = containerRef.querySelectorAll<HTMLElement>(
      ".journal-scroll__entry",
    );
    for (const el of frames) {
      const r = el.getBoundingClientRect();
      // The first entry whose bottom edge is still below the viewport top
      // is the one occupying the top of the viewport.
      if (r.bottom > cTop + 1) {
        const path = el.dataset.path;
        if (path) {
          saveScrollPosition(props.tabId, { path, offset: r.top - cTop });
        }
        return;
      }
    }
  }

  return (
    <div
      class="journal-scroll"
      ref={containerRef}
      /* Focusable so the keyboard's PageUp/PageDown/arrows scroll the feed
         the moment the tab is shown — see the focus() call in onMount. */
      tabindex={-1}
      onClick={(e) => void handleWikilinkClick(e)}
      onAuxClick={(e) => void handleWikilinkClick(e)}
      onContextMenu={(e) => void handleWikilinkClick(e)}
      onScroll={captureScrollPosition}
    >
      <Show when={isLoading(props.tabId) && getEntries(props.tabId).length === 0}>
        <div class="journal-scroll__loading">{t("common.loading")}</div>
      </Show>
      <For each={stableEntries()}>
        {(entry) => (
          <JournalScrollEntryView
            entry={entry}
            tabId={props.tabId}
            container={containerRef!}
            scrollAnchorRO={scrollAnchorRO}
            flags={flagsByPath().get(entry.path) ?? null}
          />
        )}
      </For>
      <Show
        when={
          !isLoading(props.tabId) && getEntries(props.tabId).length === 0
        }
      >
        <div class="journal-scroll__empty">
          {t("journalScroll.empty")}
        </div>
      </Show>
      <div ref={bottomSentinelRef} class="journal-scroll__sentinel" />
    </div>
  );
};

// === Per-entry component ===

// Connection badges shown in each entry's header. The colored accent strip
// down the entry's left edge encodes the same relation by color alone; the
// header icon + tooltip make that color self-documenting (and, unlike the
// single-color strip, all applicable relations show at once). Icon colors
// are set in CSS to match their corresponding strip color so the two cues
// reinforce each other. Order here is the cascade order of the strip CSS:
// anchor > links-to > linked-from > shares-tags.
const CONNECTION_BADGES: ReadonlyArray<{
  key: "is_anchor" | "links_to_anchor" | "linked_from_anchor" | "shares_tags";
  Icon: Component<{ size?: number }>;
  labelKey: string;
  cls: string;
}> = [
  {
    key: "is_anchor",
    Icon: Anchor,
    labelKey: "journalScroll.badge.anchor",
    cls: "anchor",
  },
  {
    key: "links_to_anchor",
    Icon: SquareArrowOutUpRight,
    labelKey: "journalScroll.badge.linksTo",
    cls: "links-to-anchor",
  },
  {
    key: "linked_from_anchor",
    Icon: SquareArrowInDownLeft,
    labelKey: "journalScroll.badge.linkedFrom",
    cls: "linked-from-anchor",
  },
  {
    key: "shares_tags",
    Icon: Tags,
    labelKey: "journalScroll.badge.sharesTags",
    cls: "shares-tags",
  },
];

interface JournalScrollEntryViewProps {
  entry: ScrollEntry;
  tabId: string;
  container: HTMLDivElement;
  /** Shared scroll-anchoring observer — every entry frame registers with
   *  it so above-the-viewport compile growth is compensated. */
  scrollAnchorRO: ResizeObserver;
  flags: ConnectionFlags | null;
}

const JournalScrollEntryView: Component<JournalScrollEntryViewProps> = (
  props,
) => {
  const t = useI18n();
  let frameRef: HTMLDivElement | undefined;
  let bodyRef: HTMLDivElement | undefined;
  const [result, setResult] = createSignal<TypstHtmlResult | null>(null);
  const [near, setNear] = createSignal(false);
  const [visible, setVisible] = createSignal(false);
  // Compile diagnostics are hidden behind a header button by default — in
  // Journal Scroll the warning is incidental and can be ignored; the button
  // reveals the full message on demand.
  const [showDiag, setShowDiag] = createSignal(false);
  const diagnostics = () => result()?.diagnostics ?? [];
  const hasError = () => diagnostics().some((d) => d.severity === "error");

  // Journal Scroll is an in-app review surface, not a print preview, so its
  // body text uses the Visual Editor font (`--md-body-font`) rather than the
  // document text font — this distinguishes it as an app function instead of
  // implying a preview of the printed output. Notes that override
  // `#note(font-family:)` still bake that override into the compiled HTML;
  // this only sets the fallback for notes with no override.
  const contentStyle = () => {
    const s: Record<string, string> = {};
    s["font-family"] = "var(--md-body-font, var(--editor-font-body, sans-serif))";
    if (settings.document.text_size) {
      s["font-size"] = `${settings.document.text_size}pt`;
    }
    return s;
  };

  // Pre-compile when within ~2 viewport-heights of the visible area.
  createEffect(() => {
    if (!frameRef) return;
    const nearObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setNear(true);
        }
      },
      { root: props.container, rootMargin: "200% 0px 200% 0px" },
    );
    const visibleObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          setVisible(e.isIntersecting);
        }
      },
      { root: props.container, threshold: 0 },
    );
    nearObserver.observe(frameRef);
    visibleObserver.observe(frameRef);
    onCleanup(() => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
    });
  });

  // Publish per-entry visibility to the store. The right-panel
  // Scroll Context tab (step 14) subscribes via `getVisibleEntries`.
  createEffect(
    on([visible, () => props.entry.path], ([isVis, path]) => {
      trackVisibility(props.tabId, path, isVis);
    }),
  );
  onCleanup(() => {
    trackVisibility(props.tabId, props.entry.path, false);
  });

  // Register this frame with the shared scroll-anchoring observer so its
  // compile-driven growth is compensated when it sits above the viewport.
  onMount(() => {
    if (frameRef) props.scrollAnchorRO.observe(frameRef);
  });
  onCleanup(() => {
    if (frameRef) props.scrollAnchorRO.unobserve(frameRef);
  });

  // Trigger render when the entry approaches view; subscribe to results.
  createEffect(
    on([near, () => props.entry.path], ([isNear, path]) => {
      if (!isNear) return;
      setResult(null);
      const unsub = requestRender(path, (r) => setResult(r));
      onCleanup(unsub);
    }),
  );

  // Mount the compiled HTML into the entry's body, stripping <script> tags.
  createEffect(
    on(result, (r) => {
      if (!bodyRef) return;
      if (!r) return;
      while (bodyRef.firstChild) bodyRef.removeChild(bodyRef.firstChild);
      // Render whenever HTML is present — `ok` is false for a recovered
      // (partial) render, but that HTML is still worth showing.
      if (!r.html) return;
      const parser = new DOMParser();
      const doc = parser.parseFromString(r.html, "text/html");
      doc.querySelectorAll("script").forEach((s) => s.remove());
      const body = doc.body;
      if (!body) return;
      while (body.firstChild) bodyRef.appendChild(body.firstChild);
    }),
  );

  function handleTitleClick() {
    // The header title button is "Open in new tab" — it always opens a
    // fresh, regular file tab in the user's default editor mode.
    // `allowDuplicate` is essential, not optional: the anchor entry's path
    // IS the Journal Scroll tab's own path, so without it openTab would
    // match the scroll tab and just re-focus the scroll instead of opening
    // the note. (A new tabId carries no scroll state, so the new tab
    // renders as a normal editor regardless of path.)
    openTab(
      {
        type: "file",
        title: props.entry.title,
        path: props.entry.path,
      },
      { forceNewTab: true, allowDuplicate: true },
    );
  }

  return (
    <div
      class="journal-scroll__entry"
      classList={{
        "journal-scroll__entry--anchor": !!props.flags?.is_anchor,
        "journal-scroll__entry--links-to-anchor":
          !!props.flags?.links_to_anchor,
        "journal-scroll__entry--linked-from-anchor":
          !!props.flags?.linked_from_anchor,
        "journal-scroll__entry--shares-tags": !!props.flags?.shares_tags,
      }}
      data-path={props.entry.path}
      ref={frameRef}
    >
      <div class="journal-scroll__entry-accent" aria-hidden="true" />
      <div class="journal-scroll__entry-header">
        <button
          class="journal-scroll__entry-title"
          onClick={handleTitleClick}
          title={t("wikilink.menu.openNewTab")}
        >
          {props.entry.title}
        </button>
        <div class="journal-scroll__entry-header-end">
          <Show when={diagnostics().length > 0}>
            <button
              type="button"
              class="journal-scroll__entry-warning"
              classList={{ "is-error": hasError() }}
              onClick={() => setShowDiag((v) => !v)}
              title={tPlural(
                hasError() ? "journalScroll.diag.issue" : "journalScroll.diag.warning",
                diagnostics().length,
                {
                  count: diagnostics().length,
                  action: t(showDiag() ? "journalScroll.diag.hide" : "journalScroll.diag.view"),
                },
              )}
              aria-expanded={showDiag()}
            >
              <MessageSquareWarning size={15} />
            </button>
          </Show>
          <Show when={props.flags}>
            {(f) => (
              <For each={CONNECTION_BADGES.filter((b) => f()[b.key])}>
                {(b) => (
                  <span
                    class={`journal-scroll__entry-connection journal-scroll__entry-connection--${b.cls}`}
                    title={t(b.labelKey)}
                    aria-label={t(b.labelKey)}
                  >
                    <b.Icon size={14} />
                  </span>
                )}
              </For>
            )}
          </Show>
        </div>
      </div>
      <Show when={result()} fallback={
        <div class="journal-scroll__entry-loading">
          {near() ? t("journalScroll.compiling") : "…"}
        </div>
      }>
        {(r) => (
          <>
            <Show when={r().diagnostics.length > 0 && showDiag()}>
              {/* Reuse the Reading view's structured DiagnosticRow so
                  severity / location / hints render identically across
                  both surfaces. Toggled by the header warning button. */}
              <div class="typst-reading__diagnostics">
                <Show when={r().recovered}>
                  <div class="typst-reading__recovered-note">
                    {t("journalScroll.recoveredNote")}
                  </div>
                </Show>
                <For each={r().diagnostics}>
                  {(d) => <DiagnosticRow d={d} />}
                </For>
              </div>
            </Show>
            {/* Share `.typst-reading__html-content` with the dedicated
                Reading view so the same compiled Typst HTML renders
                identically in both surfaces — headings, lists, code,
                tables, blockquotes, footnotes all get one set of rules
                rather than two surfaces drifting apart. The same
                document-font + size fallback is applied at the body
                level so notes that don't override `#note(font-family:)`
                pick up the user's global font choice the same way the
                Reading view does. */}
            <div
              class="journal-scroll__entry-body typst-reading__html-content"
              style={contentStyle()}
              ref={bodyRef}
            />
          </>
        )}
      </Show>
    </div>
  );
};

export default JournalScrollView;
