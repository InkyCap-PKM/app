// ---------------------------------------------------------------------------
// Scroll Context panel — right-panel surface that summarises the
// currently-visible window of the Journal Scroll. Four sub-panes:
//
//   1. Outline — headings across visible entries, click → scroll-to-heading.
//   2. Connections — notes outside the scroll that link to / from any
//      visible entry, click → open in new tab.
//   3. Tag concentration — tags occurring across visible entries.
//   4. Citations — aggregated citations across visible entries.
//
// Subscribes to `getVisibleEntries(tabId)` from the journal-scroll store;
// the JournalScrollView IntersectionObservers publish the visible set.
//
// Section collapse state persists to localStorage so it survives both
// tab-switches and full app restarts.
// ---------------------------------------------------------------------------

import {
  Component,
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import * as ipc from "../lib/ipc";
import {
  getEntries,
  getVisibleEntries,
  setPropertyFilter,
} from "../stores/journal-scroll";
import { openTab } from "../stores/tabs";
import CitationRow from "./CitationRow";
import type { HeadingInfo } from "../lib/ipc";
import type { AggregatedCitation, LinkInfo } from "../lib/types";

interface ScrollContextPanelProps {
  tabId: string;
}

interface VisibleNote {
  path: string;
  title: string;
}

interface OutlineRow extends VisibleNote {
  headings: HeadingInfo[];
}

interface ConnectionRow {
  /** Path of the related note (outside the scroll). */
  path: string;
  /** Resolved name (file stem). */
  name: string;
  /** Direction(s) of relation against the visible entries. */
  incoming: boolean;
  outgoing: boolean;
}

// ── Section collapse state, persisted across sessions ──────────────────────

type SectionKey = "outline" | "connections" | "tags" | "citations";
type SectionState = Record<SectionKey, boolean>;

const SECTIONS_STORAGE_KEY = "inkycap.scrollContext.sections";
const DEFAULT_SECTIONS: SectionState = {
  outline: true,
  connections: true,
  tags: true,
  citations: true,
};

function loadSections(): SectionState {
  try {
    const raw = localStorage.getItem(SECTIONS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SECTIONS };
    const parsed = JSON.parse(raw) as Partial<SectionState>;
    return { ...DEFAULT_SECTIONS, ...parsed };
  } catch {
    return { ...DEFAULT_SECTIONS };
  }
}

function saveSections(state: SectionState) {
  try {
    localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* no-op: localStorage may be unavailable in some webview contexts */
  }
}

// ── Cross-mount persistence ────────────────────────────────────────────────
//
// The panel unmounts whenever the user views a non-scroll tab and remounts on
// return; without help, all four sub-pane resources would re-issue their IPC
// and the pane would visibly rebuild over a second or two. Two module-level
// caches bridge that gap:
//
//   * `lastVisibleByTab` keeps the most recent non-empty visible set, so the
//     `visible()` memo doesn't collapse to empty during the window where the
//     JournalScrollView has unmounted but not yet re-published its observers.
//   * `dataCache` keeps the last computed datasets per tab; each resource
//     seeds its `initialValue` from it so the pane paints instantly on
//     remount, then refreshes in the background.
//
// Both are keyed by tabId and capped so a long session can't grow them
// without bound.

interface ContextData {
  outline: OutlineRow[];
  connections: ConnectionRow[];
  citations: AggregatedCitation[];
  tags: Array<{ tag: string; count: number }>;
}

const CONTEXT_CACHE_CAP = 24;
const lastVisibleByTab = new Map<string, VisibleNote[]>();
const dataCache = new Map<string, ContextData>();

function cacheContextData(tabId: string, patch: Partial<ContextData>) {
  const prev =
    dataCache.get(tabId) ??
    ({ outline: [], connections: [], citations: [], tags: [] } as ContextData);
  // Re-insert at the end so Map iteration order tracks recency for the cap.
  dataCache.delete(tabId);
  dataCache.set(tabId, { ...prev, ...patch });
  while (dataCache.size > CONTEXT_CACHE_CAP) {
    const oldest = dataCache.keys().next().value;
    if (oldest === undefined) break;
    dataCache.delete(oldest);
  }
}

// ── Section header — mirrors the Links pane's collapsible header so the
//    two right-panel surfaces read consistently. ────────────────────────────

const SectionHeader: Component<{
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}> = (p) => (
  <div
    class="right-panel__section-header right-panel__section-header--clickable"
    onClick={() => p.onToggle()}
    role="button"
    tabindex="0"
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        p.onToggle();
      }
    }}
    aria-expanded={p.open}
  >
    <span>
      {p.label}
      <span class="right-panel__count"> ({p.count})</span>
    </span>
    <div class="right-panel__header-actions">
      <Show
        when={p.open}
        fallback={<ChevronRight size={14} class="right-panel__section-chevron" />}
      >
        <ChevronDown size={14} class="right-panel__section-chevron" />
      </Show>
    </div>
  </div>
);

const ScrollContextPanel: Component<ScrollContextPanelProps> = (props) => {
  const visible = createMemo<VisibleNote[]>(() => {
    const paths = getVisibleEntries(props.tabId);
    if (paths.length === 0) {
      // Empty during the JournalScrollView remount window (tab just
      // re-shown). Fall back to the last known visible set so the sub-panes
      // keep their content instead of flashing empty and rebuilding.
      return lastVisibleByTab.get(props.tabId) ?? [];
    }
    const entries = getEntries(props.tabId);
    const titleByPath = new Map(entries.map((e) => [e.path, e.title]));
    const next = paths.map((path) => ({
      path,
      title: titleByPath.get(path) ?? path.split("/").pop() ?? path,
    }));
    lastVisibleByTab.set(props.tabId, next);
    return next;
  });

  const [outline] = createResource<OutlineRow[], VisibleNote[]>(
    visible,
    async (notes) => {
      if (notes.length === 0) return [];
      const results = await Promise.all(
        notes.map(async (n) => {
          try {
            const headings = await ipc.getNoteHeadings(n.path);
            return { ...n, headings };
          } catch {
            return { ...n, headings: [] as HeadingInfo[] };
          }
        }),
      );
      cacheContextData(props.tabId, { outline: results });
      return results;
    },
    { initialValue: dataCache.get(props.tabId)?.outline ?? [] },
  );

  const [connections] = createResource<ConnectionRow[], VisibleNote[]>(
    visible,
    async (notes) => {
      if (notes.length === 0) return [];
      const visiblePaths = new Set(notes.map((n) => n.path));
      const merged = new Map<string, ConnectionRow>();
      const upsert = (link: LinkInfo, direction: "incoming" | "outgoing") => {
        if (visiblePaths.has(link.path)) return;
        const row = merged.get(link.path) ?? {
          path: link.path,
          name: link.name,
          incoming: false,
          outgoing: false,
        };
        if (direction === "incoming") row.incoming = true;
        else row.outgoing = true;
        merged.set(link.path, row);
      };
      await Promise.all(
        notes.map(async (n) => {
          try {
            const [back, forward] = await Promise.all([
              ipc.getBacklinks(n.path),
              ipc.getForwardLinks(n.path),
            ]);
            for (const l of back) upsert(l, "incoming");
            for (const l of forward) upsert(l, "outgoing");
          } catch {
            // Skip on transient failure (e.g., file deleted mid-scan).
          }
        }),
      );
      const rows = [...merged.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      cacheContextData(props.tabId, { connections: rows });
      return rows;
    },
    { initialValue: dataCache.get(props.tabId)?.connections ?? [] },
  );

  const [citations] = createResource<AggregatedCitation[], VisibleNote[]>(
    visible,
    async (notes) => {
      if (notes.length === 0) return [];
      try {
        const rows = await ipc.aggregateCitations(notes.map((n) => n.path));
        cacheContextData(props.tabId, { citations: rows });
        return rows;
      } catch {
        return [];
      }
    },
    { initialValue: dataCache.get(props.tabId)?.citations ?? [] },
  );

  const [tagConcentration] = createResource<
    Array<{ tag: string; count: number }>,
    VisibleNote[]
  >(
    visible,
    async (notes) => {
      if (notes.length === 0) return [];
      const counts = new Map<string, number>();
      await Promise.all(
        notes.map(async (n) => {
          try {
            const meta = await ipc.getFileMetadata(n.path);
            for (const tag of meta.tags ?? []) {
              counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
          } catch {
            /* skip */
          }
        }),
      );
      const rows = [...counts.entries()]
        .filter(([, c]) => c >= 1)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      cacheContextData(props.tabId, { tags: rows });
      return rows;
    },
    { initialValue: dataCache.get(props.tabId)?.tags ?? [] },
  );

  // Collapsible sub-pane state — loaded from and written back to localStorage.
  const [openSection, setOpenSection] = createSignal<SectionState>(
    loadSections(),
  );
  function toggle(key: SectionKey) {
    setOpenSection((o) => {
      const next = { ...o, [key]: !o[key] };
      saveSections(next);
      return next;
    });
  }

  function scrollToEntry(path: string) {
    const el = document.querySelector(
      `.journal-scroll [data-path="${CSS.escape(path)}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── Citation highlight ──────────────────────────────────────────────────
  // Clicking a citation card outlines every occurrence of that key across the
  // visible scroll entries (the compiled HTML tags each citation with
  // `data-cite-key`). The glow on an occurrence persists while it is on
  // screen and clears once it has been seen and then scrolled fully out of
  // view — so the marks don't linger. A new click clears any leftovers.
  let highlightObserver: IntersectionObserver | undefined;
  let highlighted: Element[] = [];

  function clearCitationHighlight() {
    highlightObserver?.disconnect();
    highlightObserver = undefined;
    for (const el of highlighted) el.classList.remove("citation-highlight");
    highlighted = [];
  }

  function highlightCitation(key: string) {
    clearCitationHighlight();
    const container = document.querySelector(".journal-scroll");
    if (!container) return;
    const els = Array.from(
      container.querySelectorAll(`[data-cite-key="${CSS.escape(key)}"]`),
    );
    if (els.length === 0) return;
    highlighted = els;
    for (const el of els) el.classList.add("citation-highlight");

    // If no occurrence is currently on screen, bring the *first* one (in
    // document order — `querySelectorAll` returns elements in order) into
    // view, so a key cited several times across the page lands on its first
    // mention rather than whichever happens to be nearest.
    const containerRect = container.getBoundingClientRect();
    const inView = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.bottom > containerRect.top && r.top < containerRect.bottom;
    };
    if (!els.some(inView)) {
      els[0].scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // Drop each occurrence's glow once it has been seen and then leaves view.
    const seen = new WeakSet<Element>();
    highlightObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            seen.add(entry.target);
          } else if (seen.has(entry.target)) {
            entry.target.classList.remove("citation-highlight");
            highlightObserver?.unobserve(entry.target);
            highlighted = highlighted.filter((e) => e !== entry.target);
          }
        }
      },
      { root: container, threshold: 0 },
    );
    for (const el of els) highlightObserver.observe(el);
  }

  onCleanup(clearCitationHighlight);

  /** Scroll to a specific heading inside a visible scroll entry. Headings in
   *  the compiled HTML appear in document order, matching the order of
   *  `getNoteHeadings`, so the heading's index in that list selects the
   *  corresponding rendered element. Deep headings that Typst lowers to
   *  `<div role="heading">` are included so the mapping stays 1:1. */
  function scrollToHeading(path: string, headingIndex: number) {
    const entry = document.querySelector(
      `.journal-scroll [data-path="${CSS.escape(path)}"]`,
    );
    if (!entry) return;
    const body = entry.querySelector(".journal-scroll__entry-body");
    const headings = body?.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, [role='heading']",
    );
    const target = headings?.[headingIndex] as HTMLElement | undefined;
    (target ?? (entry as HTMLElement)).scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function openInNewTab(path: string, title: string) {
    openTab(
      { type: "file", title, path },
      { forceNewTab: true },
    );
  }

  function narrowByTag(tag: string) {
    void setPropertyFilter(props.tabId, {
      kind: "eq",
      name: "tags",
      value: tag,
    });
  }

  return (
    <div class="scroll-context">
      <Show when={visible().length === 0}>
        <div class="scroll-context__empty">
          Scroll into the view to populate context.
        </div>
      </Show>

      {/* Outline */}
      <div class="right-panel__section">
        <SectionHeader
          label="Outline"
          count={outline()?.reduce((n, r) => n + r.headings.length, 0) ?? 0}
          open={openSection().outline}
          onToggle={() => toggle("outline")}
        />
        <Show when={openSection().outline}>
          <div class="scroll-context__section-body">
            <For each={outline() ?? []}>
              {(row) => (
                <Show when={row.headings.length > 0}>
                  <div class="scroll-context__outline-note">
                    <button
                      type="button"
                      class="scroll-context__outline-title"
                      onClick={() => scrollToEntry(row.path)}
                      title="Scroll to entry"
                    >
                      {row.title}
                    </button>
                    <ul class="scroll-context__outline-list">
                      <For each={row.headings}>
                        {(h, i) => (
                          <li
                            class="scroll-context__outline-heading"
                            style={{
                              "padding-left": `${(h.level - 1) * 10}px`,
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => scrollToHeading(row.path, i())}
                            >
                              {h.text}
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
              )}
            </For>
            <Show
              when={
                outline.state === "ready" &&
                (outline()?.reduce((n, r) => n + r.headings.length, 0) ?? 0) ===
                  0
              }
            >
              <div class="scroll-context__empty-row">
                No headings in visible entries.
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Connections */}
      <div class="right-panel__section">
        <SectionHeader
          label="Connections"
          count={connections()?.length ?? 0}
          open={openSection().connections}
          onToggle={() => toggle("connections")}
        />
        <Show when={openSection().connections}>
          <div class="scroll-context__section-body">
            <For each={connections() ?? []}>
              {(row) => (
                <button
                  type="button"
                  class="scroll-context__connection"
                  onClick={() => openInNewTab(row.path, row.name)}
                  title={`${row.incoming ? "← incoming" : ""}${
                    row.incoming && row.outgoing ? " · " : ""
                  }${row.outgoing ? "outgoing →" : ""}`}
                >
                  <span class="scroll-context__connection-name">
                    {row.name}
                  </span>
                  <span class="scroll-context__connection-dirs">
                    {row.incoming ? "←" : ""}
                    {row.outgoing ? "→" : ""}
                  </span>
                </button>
              )}
            </For>
            <Show
              when={
                connections.state === "ready" &&
                (connections()?.length ?? 0) === 0
              }
            >
              <div class="scroll-context__empty-row">
                No outside connections.
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Tag concentration */}
      <div class="right-panel__section">
        <SectionHeader
          label="Tags"
          count={tagConcentration()?.length ?? 0}
          open={openSection().tags}
          onToggle={() => toggle("tags")}
        />
        <Show when={openSection().tags}>
          <div class="scroll-context__section-body">
            <div class="scroll-context__tag-chips">
              <For each={tagConcentration() ?? []}>
                {(row) => (
                  <button
                    type="button"
                    class="scroll-context__tag-chip"
                    onClick={() => narrowByTag(row.tag)}
                    title={`Narrow scroll to notes tagged ${row.tag}`}
                  >
                    {row.tag}
                    <span class="scroll-context__tag-count">{row.count}</span>
                  </button>
                )}
              </For>
            </div>
            <Show
              when={
                tagConcentration.state === "ready" &&
                (tagConcentration()?.length ?? 0) === 0
              }
            >
              <div class="scroll-context__empty-row">
                No tags on visible entries.
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Citations */}
      <div class="right-panel__section">
        <SectionHeader
          label="Citations"
          count={citations()?.length ?? 0}
          open={openSection().citations}
          onToggle={() => toggle("citations")}
        />
        <Show when={openSection().citations}>
          <div class="scroll-context__section-body">
            <For each={citations() ?? []}>
              {(c) => (
                <CitationRow
                  cite={{
                    key: c.key,
                    title: c.title,
                    authors: c.authors,
                    year: c.year,
                    zoteroItemKey: c.zotero_item_key,
                    count: c.count,
                  }}
                  onActivate={() => highlightCitation(c.key)}
                  title={`${c.title ?? c.key} — click to highlight where it's cited`}
                />
              )}
            </For>
            <Show
              when={
                citations.state === "ready" &&
                (citations()?.length ?? 0) === 0
              }
            >
              <div class="scroll-context__empty-row">
                No citations in visible entries.
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default ScrollContextPanel;
