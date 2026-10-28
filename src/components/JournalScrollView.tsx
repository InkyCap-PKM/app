// ---------------------------------------------------------------------------
// JournalScrollView: an infinitely scrolling list of related notes.
//
// Each entry is compiled to HTML through the same Typst path as reading mode
// (`compileTypstHtml`), with a limit on concurrent compiles. A module-level
// cache by path makes scrolling back instant; it is cleared on
// `notebox:file-changed`.
//
// The feed only grows downwards: the anchor is the first row, and a bottom
// IntersectionObserver calls `loadMoreAfter`.
//
// Entries compile asynchronously and grow from placeholders. WebKitGTK has no
// CSS scroll anchoring, so `scrollAnchorRO` adds the growth of entries above
// the viewport to `scrollTop`; otherwise the feed jumps back.
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
import { openLink } from "../lib/open-link";
import { sanitizeNoteHtml } from "../lib/safe-html";
import {
  consumeScrollNavRequest,
  findOffsetForTarget,
  getAnchorPath,
  getAnchorPinNonce,
  getScrollScope,
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
import {
  Anchor,
  ChevronsDownUp,
  ChevronsUpDown,
  MessageSquareWarning,
  MessageSquareX,
  Tags,
} from "lucide-solid";
import { FlagNoticeIcon } from "./icons/FlagNotice";
import { SquareArrowOutUpRight, SquareArrowInDownLeft } from "./icons";
import { DiagnosticRow } from "./DiagnosticRow";
import type { ConnectionFlags, ScrollEntry, TypstHtmlResult } from "../lib/types";

// === Render cache and concurrency queue ===
//
// A render is a whole note or, in Neighbourhood, an excerpt around its links to
// the anchor. Both are cached by a key naming the note and, for an excerpt, the
// anchor (see `renderKey`).

const MAX_CONCURRENT = 3;
const CACHE_CAP = 50;

/** What to compile: the note at `path`, or only its passages around links
 *  to `excerptOf` when that is set. */
interface RenderJob {
  path: string;
  excerptOf?: string;
}

/** A compiled entry. `truncated` is set on an excerpt that left part of the
 *  note out. */
type RenderResult = TypstHtmlResult & { truncated?: boolean };

/** Separates the note from the anchor in an excerpt's key; a path can't
 *  hold it. */
const KEY_SEPARATOR = "\u0000";

function renderKey(job: RenderJob): string {
  return job.excerptOf ? `${job.path}${KEY_SEPARATOR}${job.excerptOf}` : job.path;
}

/** Render key → compiled HTML result. */
const htmlCache = new Map<string, RenderResult>();

/**
 * Render key → callbacks waiting for that render, so concurrent requests share
 * one compile.
 */
const pendingSubscribers = new Map<string, Set<(r: RenderResult) => void>>();

/** Renders queued but not yet started. */
const renderQueue: RenderJob[] = [];
let activeWorkers = 0;

function cacheTouch(key: string, result: RenderResult) {
  if (htmlCache.has(key)) htmlCache.delete(key); // move-to-front
  htmlCache.set(key, result);
  while (htmlCache.size > CACHE_CAP) {
    // Map iteration order is insertion order; first key is oldest.
    const oldest = htmlCache.keys().next().value;
    if (oldest === undefined) break;
    htmlCache.delete(oldest);
  }
}

function notifySubscribers(key: string, result: RenderResult) {
  const subs = pendingSubscribers.get(key);
  if (!subs) return;
  pendingSubscribers.delete(key);
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
    const job = renderQueue.shift()!;
    const key = renderKey(job);
    if (htmlCache.has(key)) {
      // Already rendered while waiting in queue.
      notifySubscribers(key, htmlCache.get(key)!);
      continue;
    }
    try {
      const result: RenderResult = job.excerptOf
        ? await ipc.compileTypstHtmlExcerpt(job.path, job.excerptOf)
        : await ipc.compileTypstHtml(job.path);
      cacheTouch(key, result);
      notifySubscribers(key, result);
    } catch (err) {
      const failResult: RenderResult = {
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
      cacheTouch(key, failResult);
      notifySubscribers(key, failResult);
    }
  }
  activeWorkers--;
}

function requestRender(
  job: RenderJob,
  onResult: (r: RenderResult) => void,
): () => void {
  const key = renderKey(job);
  // Cache hit: short-circuit.
  const cached = htmlCache.get(key);
  if (cached) {
    // Refresh recency.
    cacheTouch(key, cached);
    queueMicrotask(() => onResult(cached));
    return () => {};
  }
  // Subscribe and (if needed) enqueue.
  let subs = pendingSubscribers.get(key);
  if (!subs) {
    subs = new Set();
    pendingSubscribers.set(key, subs);
    renderQueue.push(job);
  }
  subs.add(onResult);

  // Spawn workers up to the cap.
  while (activeWorkers < MAX_CONCURRENT && renderQueue.length > 0) {
    activeWorkers++;
    void runOneWorker();
  }

  return () => {
    const s = pendingSubscribers.get(key);
    if (s) s.delete(onResult);
  };
}

/** Drop every cached render of a note (whole and excerpts) so the next view
 *  of that entry re-compiles. Called on file-changed events. */
function invalidatePath(path: string) {
  for (const key of [...htmlCache.keys()]) {
    if (key === path || key.startsWith(path + KEY_SEPARATOR)) htmlCache.delete(key);
  }
  // Pending compiles still run and fill the cache; the entry's file-change
  // effect subscribes again for the new version.
}

// One file-change listener for the session, installed on first mount and kept,
// since other tabs may need it.
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

// Visible paths per tab. Each entry's IntersectionObserver updates its tab's
// set, and the store's `visibleEntries` is their union.
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

  // === Scroll anchoring ===
  //
  // WebKitGTK doesn't implement CSS scroll anchoring, so when an entry above
  // the viewport finishes compiling and grows, the content being read moves
  // down. This ResizeObserver adds that growth to `scrollTop`. Unlike
  // `holdEntry` it doesn't stop when the user scrolls.
  const entryHeights = new WeakMap<Element, number>();
  const scrollAnchorRO = new ResizeObserver((records) => {
    const container = containerRef;
    if (!container) return;
    // A running `holdEntry` already pins by absolute position, so don't
    // compensate as well; just keep the baselines current.
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

  // `<For>` keys rows by reference, and entries coming back from the store aren't
  // the same objects after each load-more, so every entry would be recreated and
  // the feed would collapse and jump back. This map returns the same object for
  // the same path, so existing entries survive.
  const entryIdentity = new Map<string, ScrollEntry>();
  const stableEntries = createMemo<ScrollEntry[]>(() => {
    const raw = getEntries(props.tabId);
    const seen = new Set<string>();
    const out: ScrollEntry[] = [];
    for (const e of raw) {
      // `<For>` can't tell two identical references apart, so skip duplicates
      // here too.
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      let stable = entryIdentity.get(e.path);
      if (!stable) {
        stable = { path: e.path, title: e.title, out_of_scope: e.out_of_scope };
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

  // On mount, focus the feed and restore the saved position with `holdEntry`,
  // which keeps correcting while the entries above grow; a single `scrollTop`
  // would land near the top.
  onMount(() => {
    if (!containerRef) return;
    containerRef.focus({ preventScroll: true });
    const saved = getSavedScrollPosition(props.tabId);
    if (saved) holdEntry(saved.path, saved.offset);
  });

  onCleanup(() => activeHoldStop?.());

  // Recompute connection flags when the entries or the anchor change (the
  // anchor comes from the store, so re-anchoring counts). One backend call for
  // all loaded paths.
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

  // Handle `scrollNavRequest` from the back/forward arrows and the
  // return-to-anchor button. `nonce` makes repeated requests distinct; the rest
  // runs untracked. Returning to the anchor is `scrollTop = 0`, since it is
  // always the first row.
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

  // On every result-set rebuild, scroll back to the anchor (`scrollTop = 0`).
  //
  // The `nonce !== prevNonce` guard is essential: every store change ticks the
  // signal all selectors read, so this effect runs on every pagination step and
  // would otherwise snap back to the anchor. `defer: true` keeps it from
  // overriding a restored position on tab return.
  createEffect(
    on(
      () => getAnchorPinNonce(props.tabId),
      (nonce, prevNonce) => {
        if (nonce !== prevNonce && nonce > 0) pinAnchorToTop();
      },
      { defer: true },
    ),
  );

  // The bottom sentinel loads more; nothing loads above the anchor.
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

  // Wikilink clicks, delegated on the container:
  //   - right-click: the wikilink context menu
  //   - modifier or middle click: new tab
  //   - plain click on a target in the loaded entries: scroll to it
  //   - plain click otherwise: new tab
  //
  // The target is resolved with one `getForwardLinks(source)` call (already
  // cached in the LinkIndex), where the source is the closest
  // `.journal-scroll__entry`'s `data-path`.
  async function handleWikilinkClick(e: MouseEvent) {
    const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      "a.inkycap-wikilink",
    );
    if (!a) {
      // Other links (URLs, `#link(...)` to files) go through `openLink` instead
      // of navigating the webview. The context menu is left alone so "Copy
      // link" works.
      if (e.type === "contextmenu") return;
      const other = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        "a[href]",
      );
      const href = other?.getAttribute("href")?.trim();
      if (href) {
        e.preventDefault();
        void openLink(href);
      }
      return;
    }
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
    // Plain click: navigate within the scroll and record the jump for the back
    // arrow; if the target isn't in this scroll, open a new tab.
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

  // Go to `targetPath` in the scroll: scroll to it if loaded, otherwise
  // re-anchor on it. False when it isn't part of this scroll. Used by wikilinks
  // and the back/forward arrows.
  async function navigateScrollTo(targetPath: string): Promise<boolean> {
    if (getEntries(props.tabId).some((e) => pathEquals(e.path, targetPath))) {
      scrollToLoadedEntry(targetPath);
      return true;
    }
    // Check whether the target exists in this query at all.
    const targetOffset = await findOffsetForTarget(props.tabId, targetPath);
    if (targetOffset === null) return false;
    // Re-anchor on the target, keeping the back/forward stack.
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

  // Keep the entry at `path` at viewport offset `offsetTop` with a per-frame
  // loop while entries compile and grow. Stops when the user scrolls (wheel,
  // pointer, touch, key) or after a deadline. Used to restore a saved position;
  // the anchor needs no loop (see `pinAnchorToTop`). A new hold cancels the
  // previous one.
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
    // Correct once now, so the first frame isn't painted at the top.
    tick();
  }

  function pinAnchorToTop() {
    // The anchor is the first row, so scrollTop 0 holds it. Cancel any restore
    // hold.
    if (!containerRef) return;
    activeHoldStop?.();
    containerRef.scrollTop = 0;
    // The result set was just rebuilt; the <For> may not have committed
    // yet. A second assignment next frame catches that case.
    requestAnimationFrame(() => {
      if (containerRef) containerRef.scrollTop = 0;
    });
  }

  // Save the position as the topmost visible entry's path and its offset from
  // the top, which can be restored after a remount (a raw `scrollTop` can't).
  // Runs on every scroll event, without throttling, so a tab switch can't beat
  // the last save. Stops at the first entry crossing the top.
  function captureScrollPosition() {
    if (!containerRef) return;
    // Not while a hold is restoring the position; the in-between values aren't
    // the user's.
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

// Connection badges in each entry's header. They explain the coloured strip on
// the entry's left edge (and show every relation at once); their colours match
// the strip's. Order follows the strip CSS: anchor, links-to, linked-from,
// shares-tags.
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
  const [result, setResult] = createSignal<RenderResult | null>(null);
  // In Neighbourhood every entry but the anchor shows only its passages
  // around the anchor, until "Show more" expands it to the whole note.
  const [expanded, setExpanded] = createSignal(false);
  const excerptOf = () => {
    const anchor = getAnchorPath(props.tabId);
    return getScrollScope(props.tabId) === "neighbourhood" &&
      !expanded() &&
      !pathEquals(props.entry.path, anchor)
      ? anchor
      : undefined;
  };
  // A new anchor or scope makes a new excerpt, so start collapsed again.
  createEffect(
    on(
      [() => getScrollScope(props.tabId), () => getAnchorPath(props.tabId)],
      () => setExpanded(false),
      { defer: true },
    ),
  );
  const [near, setNear] = createSignal(false);
  const [visible, setVisible] = createSignal(false);
  // Shown while the entry is an excerpt that left something out, and after
  // "Show more" so the reader can switch back.
  const showStrip = () => expanded() || !!result()?.truncated;
  function toggleExpanded() {
    const collapsing = expanded();
    setExpanded(!collapsing);
    // Collapsing a long note read to its end would leave the reader far
    // below it; bring its top back into view.
    if (collapsing && frameRef && frameRef.getBoundingClientRect().top < props.container.getBoundingClientRect().top) {
      frameRef.scrollIntoView({ block: "start" });
    }
  }

  // Diagnostics are behind a header button; in Journal Scroll they are
  // incidental.
  const [showDiag, setShowDiag] = createSignal(false);
  const diagnostics = () => result()?.diagnostics ?? [];
  const hasError = () => diagnostics().some((d) => d.severity === "error");

  // Journal Scroll is a review view, not a print preview, so the fallback body
  // font is the visual editor's (`--md-body-font`). A note's own
  // `#note(font-family:)` still applies.
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
    on([near, () => props.entry.path, excerptOf], ([isNear, path, of]) => {
      if (!isNear) return;
      setResult(null);
      const unsub = requestRender({ path, excerptOf: of }, (r) => setResult(r));
      onCleanup(unsub);
    }),
  );

  // Mount the compiled HTML into the entry's body, filtered for safety.
  createEffect(
    on(result, (r) => {
      if (!bodyRef) return;
      if (!r) return;
      while (bodyRef.firstChild) bodyRef.removeChild(bodyRef.firstChild);
      // Render whenever HTML is present — `ok` is false for a recovered
      // (partial) render, but that HTML is still worth showing.
      if (!r.html) return;
      bodyRef.appendChild(sanitizeNoteHtml(r.html));
    }),
  );

  function handleTitleClick() {
    // The title button opens the note in a new regular tab. `allowDuplicate` is
    // required: the anchor's path is the scroll tab's own path, so `openTab`
    // would otherwise just focus the scroll.
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
              {/* Errors get their own icon so the two states differ by
                  shape, not only by colour. */}
              <Show when={hasError()} fallback={<MessageSquareWarning size={15} />}>
                <MessageSquareX size={15} />
              </Show>
            </button>
          </Show>
          <Show when={props.entry.out_of_scope}>
            <span
              class="journal-scroll__entry-connection journal-scroll__entry-connection--out-of-scope"
              title={t("journalScroll.badge.outOfScope")}
              aria-label={t("journalScroll.badge.outOfScope")}
            >
              <FlagNoticeIcon size={14} />
            </span>
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
                  {(d) => <DiagnosticRow d={d} notePath={props.entry.path} />}
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
            <Show when={showStrip()}>
              <button
                type="button"
                class="journal-scroll__show-more"
                onClick={toggleExpanded}
                aria-expanded={expanded()}
              >
                <span>{expanded() ? t("journalScroll.showLess") : t("journalScroll.showMore")}</span>
                <Show when={expanded()} fallback={<ChevronsUpDown size={14} aria-hidden="true" />}>
                  <ChevronsDownUp size={14} aria-hidden="true" />
                </Show>
              </button>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

export default JournalScrollView;
