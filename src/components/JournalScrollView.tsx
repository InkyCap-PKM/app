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
// Pagination: top + bottom IntersectionObserver sentinels drive
// `loadMoreBefore` / `loadMoreAfter`. Prepend preserves scroll position by
// measuring the previously-first entry's position before and after the DOM
// update and adjusting `scrollTop` by the delta.
// ---------------------------------------------------------------------------

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import * as ipc from "../lib/ipc";
import { onFileChanged } from "../lib/events";
import { showWikilinkContextMenu } from "../lib/wikilink-nav";
import {
  consumeScrollNavRequest,
  findOffsetForTarget,
  getAnchorPath,
  getAnchorPinNonce,
  getEntries,
  getFirstOffset,
  getLastOffset,
  getSavedScrollPosition,
  getScrollNavRequest,
  hasMoreAfter,
  hasMoreBefore,
  isLoading,
  loadMoreAfter,
  loadMoreBefore,
  recordScrollNavigation,
  saveScrollPosition,
  setVisibleEntries,
} from "../stores/journal-scroll";
import { openTab } from "../stores/tabs";
import { settings } from "../stores/settings";
import { Anchor, MessageSquareWarning, Tags } from "lucide-solid";
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
            message: err instanceof Error ? err.message : String(err),
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
  let containerRef: HTMLDivElement | undefined;
  let topSentinelRef: HTMLDivElement | undefined;
  let bottomSentinelRef: HTMLDivElement | undefined;
  const [flagsByPath, setFlagsByPath] = createSignal<
    Map<string, ConnectionFlags>
  >(new Map());

  onMount(ensureFileChangeListener);

  // Restore the previously-saved scroll position. Two rAFs: the first
  // lets the <For> commit its entry frames into the DOM, the second
  // lets layout settle after the initial near-viewport entries hit the
  // module-level htmlCache (cached results paint in a microtask).
  // Without both ticks, the scrollTop assignment can clamp to the
  // current (smaller) content height and silently land at 0.
  onMount(() => {
    if (!containerRef) return;
    const saved = getSavedScrollPosition(props.tabId);
    if (saved <= 0) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (containerRef) containerRef.scrollTop = saved;
      });
    });
  });

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

  // Within-scroll back/forward navigation: the header arrows issue a
  // `scrollNavRequest` through the store; here we consume it and scroll the
  // requested note to the top. The `nonce` on the request makes repeated
  // navigations to the same path distinct so this effect re-fires. The
  // request-clearing and async scroll work run untracked so the effect's
  // only dependency is the request itself.
  createEffect(() => {
    const req = getScrollNavRequest(props.tabId);
    if (!req) return;
    untrack(() => {
      consumeScrollNavRequest(props.tabId);
      void navigateScrollTo(req.path);
    });
  });

  // On every result-set rebuild, pin the anchor entry to the top of the
  // viewport. Entries loaded *before* the anchor sit above it and compile
  // asynchronously — growing from small placeholders to full notes — and
  // that growth would otherwise push the anchor down ("the scroll jumps").
  // `defer: true` skips the initial run so a tab-return (which restores the
  // saved scroll position instead) isn't overridden; only genuine rebuilds
  // that happen while mounted trigger a pin.
  createEffect(
    on(
      () => getAnchorPinNonce(props.tabId),
      (nonce) => {
        if (nonce > 0) pinAnchorToTop();
      },
      { defer: true },
    ),
  );

  // Top + bottom sentinel observers drive bidirectional pagination.
  createEffect(() => {
    if (!containerRef || !topSentinelRef || !bottomSentinelRef) return;

    const topObserver = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          !isLoading(props.tabId) &&
          hasMoreBefore(props.tabId)
        ) {
          void handleLoadMoreBefore();
        }
      },
      { root: containerRef, rootMargin: "200px 0px 0px 0px" },
    );
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

    topObserver.observe(topSentinelRef);
    bottomObserver.observe(bottomSentinelRef);
    onCleanup(() => {
      topObserver.disconnect();
      bottomObserver.disconnect();
    });
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
        { forceNewTab: true },
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
  // already loaded, otherwise page the loaded window toward it and then
  // scroll. Returns false when the target isn't part of the current query
  // result (caller decides the fallback). Shared by wikilink clicks and the
  // header back/forward arrows.
  async function navigateScrollTo(targetPath: string): Promise<boolean> {
    if (getEntries(props.tabId).some((e) => e.path === targetPath)) {
      scrollToLoadedEntry(targetPath);
      return true;
    }
    const reached = await extendUntilLoaded(targetPath);
    if (reached) {
      scrollToLoadedEntry(targetPath);
      return true;
    }
    return false;
  }

  // Extend the loaded window toward `targetPath` if it sits in the
  // current query result. Returns true once the entry is loaded, false
  // if the target isn't in the result or the search exhausted before
  // reaching it. The safety cap (`MAX_BATCHES`) bounds the work even on
  // a misbehaving query — at BATCH=10 entries each, 30 iterations covers
  // 300 entries in either direction, which is well past any reasonable
  // wikilink jump distance.
  async function extendUntilLoaded(targetPath: string): Promise<boolean> {
    const targetOffset = await findOffsetForTarget(props.tabId, targetPath);
    if (targetOffset === null) return false;
    const MAX_BATCHES = 30;
    for (let i = 0; i < MAX_BATCHES; i++) {
      if (
        getEntries(props.tabId).some((entry) => entry.path === targetPath)
      ) {
        return true;
      }
      const first = getFirstOffset(props.tabId);
      const last = getLastOffset(props.tabId);
      if (targetOffset < first && hasMoreBefore(props.tabId)) {
        await loadMoreBefore(props.tabId);
      } else if (targetOffset > last && hasMoreAfter(props.tabId)) {
        await loadMoreAfter(props.tabId);
      } else {
        // Cursor on target side but no more pages — entry should be in
        // the loaded window now. One more loop checks for it.
        if (
          getEntries(props.tabId).some((entry) => entry.path === targetPath)
        ) {
          return true;
        }
        return false;
      }
    }
    return false;
  }

  function scrollToLoadedEntry(path: string) {
    if (!containerRef) return;
    const el = containerRef.querySelector(
      `[data-path="${CSS.escape(path)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Keep the anchor entry clamped to the top of the viewport while the
  // entries above it compile and grow. Runs a per-frame correction loop
  // that re-aligns the anchor's top edge with the container's top edge,
  // releasing as soon as the user scrolls (wheel / pointer / touch / key)
  // or after a generous timeout — whichever comes first. `onCleanup`
  // tears it down if the view unmounts or the effect re-fires mid-pin.
  function pinAnchorToTop() {
    const container = containerRef;
    if (!container) return;
    const anchorPath = getAnchorPath(props.tabId);
    if (!anchorPath) return;
    const userEvents = ["wheel", "pointerdown", "touchstart", "keydown"];
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const ev of userEvents) container.removeEventListener(ev, stop);
    };
    for (const ev of userEvents) {
      container.addEventListener(ev, stop, { passive: true });
    }
    const deadline = performance.now() + 4000;
    const tick = () => {
      if (stopped || containerRef !== container) return;
      const el = container.querySelector(
        `[data-path="${CSS.escape(anchorPath)}"]`,
      ) as HTMLElement | null;
      if (el) {
        const delta =
          el.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.5) container.scrollTop += delta;
      }
      if (performance.now() < deadline) requestAnimationFrame(tick);
      else stop();
    };
    requestAnimationFrame(tick);
    onCleanup(stop);
  }

  // Scroll-position preservation on prepend. Measure the
  // previously-first entry's top-relative-to-container before the load,
  // then restore the same offset after the DOM updates.
  async function handleLoadMoreBefore() {
    if (!containerRef) return;
    const oldFirst = getEntries(props.tabId)[0];
    let beforeOffset: number | null = null;
    if (oldFirst) {
      const el = containerRef.querySelector(
        `[data-path="${CSS.escape(oldFirst.path)}"]`,
      ) as HTMLElement | null;
      if (el) {
        beforeOffset =
          el.getBoundingClientRect().top -
          containerRef.getBoundingClientRect().top;
      }
    }
    await loadMoreBefore(props.tabId);
    if (beforeOffset === null || !oldFirst) return;
    requestAnimationFrame(() => {
      if (!containerRef) return;
      const el = containerRef.querySelector(
        `[data-path="${CSS.escape(oldFirst.path)}"]`,
      ) as HTMLElement | null;
      if (!el) return;
      const afterOffset =
        el.getBoundingClientRect().top -
        containerRef.getBoundingClientRect().top;
      containerRef.scrollTop += afterOffset - beforeOffset;
    });
  }

  return (
    <div
      class="journal-scroll"
      ref={containerRef}
      onClick={(e) => void handleWikilinkClick(e)}
      onAuxClick={(e) => void handleWikilinkClick(e)}
      onContextMenu={(e) => void handleWikilinkClick(e)}
      onScroll={(e) =>
        saveScrollPosition(props.tabId, e.currentTarget.scrollTop)
      }
    >
      <div ref={topSentinelRef} class="journal-scroll__sentinel" />
      <Show when={isLoading(props.tabId) && getEntries(props.tabId).length === 0}>
        <div class="journal-scroll__loading">Loading…</div>
      </Show>
      <For each={getEntries(props.tabId)}>
        {(entry) => (
          <JournalScrollEntryView
            entry={entry}
            tabId={props.tabId}
            container={containerRef!}
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
          No notes match the current scroll filter.
        </div>
      </Show>
      <div ref={bottomSentinelRef} class="journal-scroll__sentinel" />
    </div>
  );
};

// === Per-entry component ===

// Two of the connection icons aren't in lucide — they're custom variants of
// lucide's square-arrow family chosen by the user to read as "points out to
// the anchor" vs. "comes in from the anchor". They mirror lucide's standard
// SVG frame (24×24, currentColor stroke) so they style and size identically
// to the lucide icons alongside them.
const lucideFrame = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
});

/** Custom "square-arrow-out-up-right" — an arrow leaving the box toward the
 *  upper right. Used for "links to the anchor". */
const SquareArrowOutUpRight: Component<{ size?: number }> = (props) => (
  <svg {...lucideFrame(props.size ?? 24)}>
    <path d="m 21,13 v 6 a 2,2 0 0 1 -2,2 H 5 A 2,2 0 0 1 3,19 V 5 A 2,2 0 0 1 5,3 h 6" />
    <g transform="rotate(90,8.953924,11.970112)">
      <path d="m 3,3 9,9" />
      <path d="M 3,9 V 3 h 6" />
    </g>
  </svg>
);

/** Custom "square-arrow-in-down-left" — an arrow entering the box from the
 *  lower left. Used for "linked from the anchor". */
const SquareArrowInDownLeft: Component<{ size?: number }> = (props) => (
  <svg {...lucideFrame(props.size ?? 24)}>
    <path d="M13 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6" />
    <g transform="rotate(180,9.0080946,9.0379826)">
      <path d="m 3,3 9,9" />
      <path d="M 3,9 V 3 h 6" />
    </g>
  </svg>
);

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
  label: string;
  cls: string;
}> = [
  {
    key: "is_anchor",
    Icon: Anchor,
    label: "Anchor note: journal is scrolling relative to this note",
    cls: "anchor",
  },
  {
    key: "links_to_anchor",
    Icon: SquareArrowOutUpRight,
    label: "Links to the anchor note",
    cls: "links-to-anchor",
  },
  {
    key: "linked_from_anchor",
    Icon: SquareArrowInDownLeft,
    label: "Linked from the anchor note",
    cls: "linked-from-anchor",
  },
  {
    key: "shares_tags",
    Icon: Tags,
    label: "Shares a tag with the anchor note",
    cls: "shares-tags",
  },
];

interface JournalScrollEntryViewProps {
  entry: ScrollEntry;
  tabId: string;
  container: HTMLDivElement;
  flags: ConnectionFlags | null;
}

const JournalScrollEntryView: Component<JournalScrollEntryViewProps> = (
  props,
) => {
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
    openTab(
      {
        type: "file",
        title: props.entry.title,
        path: props.entry.path,
      },
      { forceNewTab: true },
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
          title="Open in new tab"
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
              title={`${diagnostics().length} compile ${
                hasError() ? "issue" : "warning"
              }${diagnostics().length === 1 ? "" : "s"} — click to ${
                showDiag() ? "hide" : "view"
              }`}
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
                    title={b.label}
                    aria-label={b.label}
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
          {near() ? "Compiling…" : "…"}
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
                    Showing a partial render — the errored content below was
                    skipped so the rest of the entry stays visible.
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
