// ---------------------------------------------------------------------------
// JournalScrollView — continuous, infinite-scrolling list of related notes.
//
// Render pipeline: each entry is compiled to HTML via the same Typst path
// reading mode's continuous-HTML view uses (`compileTypstHtml`). A
// bounded-concurrency render queue caps how many compiles run at once, and
// a module-level LRU cache by path keeps recently-rendered output around so
// that scrolling back to an earlier entry is instant. The cache invalidates
// on `vault:file-changed`.
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
} from "solid-js";
import * as ipc from "../lib/ipc";
import { onFileChanged } from "../lib/events";
import {
  findOffsetForTarget,
  getEntries,
  getFirstOffset,
  getLastOffset,
  getSavedScrollPosition,
  getShowConnections,
  hasMoreAfter,
  hasMoreBefore,
  isLoading,
  loadMoreAfter,
  loadMoreBefore,
  saveScrollPosition,
  setVisibleEntries,
} from "../stores/journal-scroll";
import { openTab } from "../stores/tabs";
import { settings } from "../stores/settings";
import { resolveTextFontSync } from "../lib/fontResolver";
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
  anchorPath: string;
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
  // changes. Flags are computed unconditionally — the pill's Connections
  // toggle only controls whether the styling is shown, so toggling doesn't
  // re-issue IPC. One backend call covers all currently-loaded paths.
  createEffect(() => {
    const entries = getEntries(props.tabId);
    const anchor = props.anchorPath;
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
  //   - modifier-click / middle-click / right-click → open in new tab
  //   - plain click + target is in the currently-loaded entry window →
  //     smooth-scroll to it
  //   - plain click + target is unresolved or outside the loaded window →
  //     fall through to a new tab (Rule A)
  //
  // Resolution is one `getForwardLinks(source)` call per click. The source
  // is the closest `.journal-scroll__entry` ancestor, identified by its
  // `data-path` attribute. Vault-wide resolution would also work but
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
    const isModifier =
      e.ctrlKey || e.metaKey || e.button === 1 || e.button === 2;
    if (isModifier) {
      openTab(
        { type: "file", title: match.name, path: match.path },
        { forceNewTab: true },
      );
      return;
    }
    // Plain click: if the target is already loaded in this scroll, scroll
    // to it. Otherwise check whether the target is in the current query's
    // sorted result. If so, page toward it until it loads, then scroll;
    // if not, fall through to a new tab (Rule A).
    const loaded = getEntries(props.tabId).some(
      (entry) => entry.path === match.path,
    );
    if (loaded) {
      scrollToLoadedEntry(match.path);
      return;
    }
    const reached = await extendUntilLoaded(match.path);
    if (reached) {
      scrollToLoadedEntry(match.path);
    } else {
      openTab(
        { type: "file", title: match.name, path: match.path },
        { forceNewTab: true },
      );
    }
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
      classList={{
        "journal-scroll--connections-on": getShowConnections(props.tabId),
      }}
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

  // Mirror the Reading view's per-entry font/size fallback. Notes that
  // override `#note(font-family:)` already bake the override into the
  // compiled HTML; this only applies when the note has no override and
  // would otherwise fall back to the browser default.
  const contentStyle = () => {
    const s: Record<string, string> = {};
    const font = resolveTextFontSync(settings.fonts);
    if (font) {
      s["font-family"] = `"${font}", var(--editor-font-body, sans-serif)`;
    }
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
      if (!r.ok || !r.html) return;
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
      </div>
      <Show when={result()} fallback={
        <div class="journal-scroll__entry-loading">
          {near() ? "Compiling…" : "…"}
        </div>
      }>
        {(r) => (
          <>
            <Show when={r().diagnostics.length > 0}>
              {/* Reuse the Reading view's structured DiagnosticRow so
                  severity / location / hints render identically across
                  both surfaces. */}
              <div class="typst-reading__diagnostics">
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
