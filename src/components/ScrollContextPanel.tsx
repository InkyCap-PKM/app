// ---------------------------------------------------------------------------
// Scroll Context panel — right-panel surface that summarises the
// currently-visible window of the Journal Scroll. Four sub-panes:
//
//   1. Outline — headings across visible entries, click → scroll-to.
//   2. Connections — notes outside the scroll that link to / from any
//      visible entry, click → open in new tab.
//   3. Tag concentration — tags occurring across visible entries.
//   4. Citations — placeholder until aggregated citation IPC lands.
//
// Subscribes to `getVisibleEntries(tabId)` from the journal-scroll store;
// the JournalScrollView IntersectionObservers publish the visible set.
// ---------------------------------------------------------------------------

import {
  Component,
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import * as ipc from "../lib/ipc";
import {
  getEntries,
  getVisibleEntries,
  setPropertyFilter,
} from "../stores/journal-scroll";
import { openTab } from "../stores/tabs";
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

const ScrollContextPanel: Component<ScrollContextPanelProps> = (props) => {
  const visible = createMemo<VisibleNote[]>(() => {
    const paths = getVisibleEntries(props.tabId);
    const entries = getEntries(props.tabId);
    const titleByPath = new Map(entries.map((e) => [e.path, e.title]));
    return paths.map((path) => ({
      path,
      title: titleByPath.get(path) ?? path.split("/").pop() ?? path,
    }));
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
      return results;
    },
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
      return [...merged.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
  );

  const [citations] = createResource<AggregatedCitation[], VisibleNote[]>(
    visible,
    async (notes) => {
      if (notes.length === 0) return [];
      try {
        return await ipc.aggregateCitations(notes.map((n) => n.path));
      } catch {
        return [];
      }
    },
  );

  const [tagConcentration] = createResource<
    Array<{ tag: string; count: number }>,
    VisibleNote[]
  >(visible, async (notes) => {
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
    return [...counts.entries()]
      .filter(([, c]) => c >= 1)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  });

  // Collapsible sub-pane state. Outline + Connections open by default
  // because they're typically the most actionable.
  const [openSection, setOpenSection] = createSignal<{
    outline: boolean;
    connections: boolean;
    tags: boolean;
    citations: boolean;
  }>({
    outline: true,
    connections: true,
    tags: true,
    citations: true,
  });
  function toggle(key: keyof ReturnType<typeof openSection>) {
    setOpenSection((o) => ({ ...o, [key]: !o[key] }));
  }

  function scrollToEntry(path: string) {
    const el = document.querySelector(
      `.journal-scroll [data-path="${CSS.escape(path)}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      <section class="scroll-context__section">
        <button
          type="button"
          class="scroll-context__section-header"
          onClick={() => toggle("outline")}
          aria-expanded={openSection().outline}
        >
          <span class="scroll-context__section-label">Outline</span>
          <span class="scroll-context__section-count">
            {outline()?.reduce((n, r) => n + r.headings.length, 0) ?? 0}
          </span>
        </button>
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
                        {(h) => (
                          <li
                            class="scroll-context__outline-heading"
                            style={{
                              "padding-left": `${(h.level - 1) * 10}px`,
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => scrollToEntry(row.path)}
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
          </div>
        </Show>
      </section>

      {/* Connections */}
      <section class="scroll-context__section">
        <button
          type="button"
          class="scroll-context__section-header"
          onClick={() => toggle("connections")}
          aria-expanded={openSection().connections}
        >
          <span class="scroll-context__section-label">Connections</span>
          <span class="scroll-context__section-count">
            {connections()?.length ?? 0}
          </span>
        </button>
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
      </section>

      {/* Tag concentration */}
      <section class="scroll-context__section">
        <button
          type="button"
          class="scroll-context__section-header"
          onClick={() => toggle("tags")}
          aria-expanded={openSection().tags}
        >
          <span class="scroll-context__section-label">Tags</span>
          <span class="scroll-context__section-count">
            {tagConcentration()?.length ?? 0}
          </span>
        </button>
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
      </section>

      {/* Citations */}
      <section class="scroll-context__section">
        <button
          type="button"
          class="scroll-context__section-header"
          onClick={() => toggle("citations")}
          aria-expanded={openSection().citations}
        >
          <span class="scroll-context__section-label">Citations</span>
          <span class="scroll-context__section-count">
            {citations()?.length ?? 0}
          </span>
        </button>
        <Show when={openSection().citations}>
          <div class="scroll-context__section-body">
            <For each={citations() ?? []}>
              {(c) => (
                <div class="scroll-context__citation" title={c.title ?? c.key}>
                  <div class="scroll-context__citation-key">
                    <span class="scroll-context__citation-keyname">
                      @{c.key}
                    </span>
                    <span class="scroll-context__citation-count">
                      {c.count}
                    </span>
                  </div>
                  <Show when={c.title || c.authors.length > 0 || c.year}>
                    <div class="scroll-context__citation-meta">
                      <Show when={c.authors.length > 0}>
                        <span>
                          {c.authors.slice(0, 2).join(", ")}
                          {c.authors.length > 2 ? " et al." : ""}
                        </span>
                      </Show>
                      <Show when={c.year}>
                        <span> ({c.year})</span>
                      </Show>
                      <Show when={c.title}>
                        <span class="scroll-context__citation-title">
                          {" "}{c.title}
                        </span>
                      </Show>
                    </div>
                  </Show>
                </div>
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
      </section>
    </div>
  );
};

export default ScrollContextPanel;
