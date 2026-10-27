// ---------------------------------------------------------------------------
// Scroll Context panel: a right-panel summary of what is visible in the Journal
// Scroll:
//   1. Outline: headings in the visible entries; click to scroll to one.
//   2. Connections: notes outside the scroll linking to or from a visible
//      entry; click to open in a new tab. Linked notes not written yet are
//      listed with a dashed page, and clicking creates them.
//   3. Tags in the visible entries.
//   4. Citations in the visible entries.
// Reads `getVisibleEntries(tabId)` from the journal-scroll store, published by
// JournalScrollView's IntersectionObservers. Collapsed sections are remembered
// in localStorage.
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
import { UnwrittenNoteIcon } from "./icons";
import * as ipc from "../lib/ipc";
import { compareName } from "../lib/sort";
import { getEntries, getVisibleEntries } from "../stores/journal-scroll";
import { indexReady, propertyVersion } from "../stores/notebox";
import { openTab } from "../stores/tabs";
import { navigateWikilink } from "../lib/wikilink-nav";
import { useI18n, tPlural } from "../lib/i18n";
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
  /** Path of the related note (outside the scroll); empty when unwritten. */
  path: string;
  /** Resolved name (file stem), or the link text when unwritten. */
  name: string;
  /** Direction(s) of relation against the visible entries. */
  incoming: boolean;
  outgoing: boolean;
  /** Linked to from a visible entry but not written yet. */
  unwritten: boolean;
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
// The panel unmounts on non-scroll tabs, and on return every sub-pane would
// reload and visibly rebuild. Two caches avoid that:
//   * `lastVisibleByTab` keeps the last non-empty visible set, so `visible()`
//     doesn't go empty before JournalScrollView republishes.
//   * `dataCache` keeps each tab's last data, used as the resources'
//     `initialValue` so the pane paints at once and refreshes behind.
// Both are keyed by tab and capped.

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
  const t = useI18n();
  const visible = createMemo<VisibleNote[]>(() => {
    const paths = getVisibleEntries(props.tabId);
    if (paths.length === 0) {
      // Empty while JournalScrollView remounts; use the last visible set so the
      // panes don't flash empty.
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

  // Also keyed on `propertyVersion`, which changes once a created or edited
  // note is indexed, so a note written from this list stops showing as
  // unwritten.
  const [connections] = createResource<
    ConnectionRow[],
    { notes: VisibleNote[]; pv: number }
  >(
    () => ({ notes: visible(), pv: propertyVersion() }),
    async ({ notes }) => {
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
          unwritten: false,
        };
        if (direction === "incoming") row.incoming = true;
        else row.outgoing = true;
        merged.set(link.path, row);
      };
      await Promise.all([
        ...notes.map(async (n) => {
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
        ipc
          .getUnwrittenNotes(0, [...visiblePaths])
          .then((unwritten) => {
            // Keyed apart from real paths; the backend already merged
            // spellings that differ only in capitals.
            for (const u of unwritten) {
              merged.set(`unwritten:${u.target.toLowerCase()}`, {
                path: "",
                name: u.target,
                incoming: false,
                outgoing: true,
                unwritten: true,
              });
            }
          })
          .catch(() => {
            /* skip: the written connections still show */
          }),
      ]);
      const rows = [...merged.values()].sort((a, b) =>
        compareName(a.name, b.name),
      );
      cacheContextData(props.tabId, { connections: rows });
      return rows;
    },
    { initialValue: dataCache.get(props.tabId)?.connections ?? [] },
  );

  const [citations, { refetch: refetchCitations }] = createResource<AggregatedCitation[], VisibleNote[]>(
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

  {
    const onNoteSaved = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const visiblePaths = visible().map((v) => v.path);
      if (detail?.path && visiblePaths.includes(detail.path)) {
        refetchCitations();
      }
    };
    document.addEventListener("inkycap:note-saved", onNoteSaved);
    onCleanup(() => document.removeEventListener("inkycap:note-saved", onNoteSaved));
  }

  // Keyed on the index build too: while it runs, notes the cache doesn't
  // hold have no metadata yet, so the counts are redone once it finishes.
  const [tagConcentration] = createResource<
    Array<{ tag: string; count: number }>,
    { notes: VisibleNote[]; ready: boolean }
  >(
    () => ({ notes: visible(), ready: indexReady() }),
    async ({ notes }) => {
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
        .sort((a, b) => b.count - a.count || compareName(a.tag, b.tag));
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
  // Clicking a citation outlines every occurrence of its key in the visible
  // entries (each citation has `data-cite-key` in the HTML). An occurrence's
  // glow stays while on screen and clears once it has been seen and scrolled
  // away. A new click clears the rest.
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

    // If none is on screen, scroll to the first occurrence in document order.
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

  /**
   * Scroll to a heading in a visible entry. Headings in the HTML are in
   * document order, as `getNoteHeadings` returns them, so the index picks the
   * element; deep headings rendered as `<div role="heading">` are included. An
   * excerpt (Neighbourhood) has fewer headings, so there the heading is found
   * by text, or the entry's top is used.
   */
  function scrollToHeading(row: OutlineRow, headingIndex: number) {
    const entry = document.querySelector(
      `.journal-scroll [data-path="${CSS.escape(row.path)}"]`,
    );
    if (!entry) return;
    const body = entry.querySelector(".journal-scroll__entry-body");
    const rendered = Array.from(
      body?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, [role='heading']") ?? [],
    );
    const wanted = row.headings[headingIndex]?.text.trim();
    const target =
      rendered.length === row.headings.length
        ? rendered[headingIndex]
        : rendered.find((el) => el.textContent?.trim() === wanted);
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

  return (
    <div class="scroll-context">
      <Show when={visible().length === 0}>
        <div class="scroll-context__empty">
          {t("scrollContext.empty")}
        </div>
      </Show>

      {/* Outline */}
      <div class="right-panel__section">
        <SectionHeader
          label={t("scrollContext.section.outline")}
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
                      title={t("scrollContext.scrollToEntry")}
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
                              onClick={() => scrollToHeading(row, i())}
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
                {t("scrollContext.noHeadings")}
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Connections */}
      <div class="right-panel__section">
        <SectionHeader
          label={t("scrollContext.section.connections")}
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
                  classList={{ "scroll-context__connection--unwritten": row.unwritten }}
                  onClick={() =>
                    row.unwritten
                      ? navigateWikilink(row.name, undefined, true)
                      : openInNewTab(row.path, row.name)
                  }
                  title={
                    row.unwritten
                      ? t("scrollContext.unwrittenTitle", { name: row.name })
                      : `${row.incoming ? t("scrollContext.connDir.incoming") : ""}${
                          row.incoming && row.outgoing ? " · " : ""
                        }${row.outgoing ? t("scrollContext.connDir.outgoing") : ""}`
                  }
                >
                  <Show when={row.unwritten}>
                    <UnwrittenNoteIcon
                      size={13}
                      class="scroll-context__connection-unwritten-icon"
                      aria-label={t("scrollContext.unwritten")}
                    />
                  </Show>
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
                {t("scrollContext.noConnections")}
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Tag concentration */}
      <div class="right-panel__section">
        <SectionHeader
          label={t("scrollContext.section.tags")}
          count={tagConcentration()?.length ?? 0}
          open={openSection().tags}
          onToggle={() => toggle("tags")}
        />
        <Show when={openSection().tags}>
          <div class="scroll-context__section-body">
            <div class="scroll-context__tag-chips">
              <For each={tagConcentration() ?? []}>
                {(row) => (
                  <span
                    class="scroll-context__tag-chip"
                    title={tPlural("scrollContext.tagChipTitle", row.count, { tag: row.tag })}
                  >
                    {row.tag}
                    <span class="scroll-context__tag-count">{row.count}</span>
                  </span>
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
                {t("scrollContext.noTags")}
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Citations */}
      <div class="right-panel__section">
        <SectionHeader
          label={t("scrollContext.section.citations")}
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
                  title={t("scrollContext.citationTitle", { name: c.title ?? c.key })}
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
                {t("scrollContext.noCitations")}
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default ScrollContextPanel;
