// Command palette (Ctrl+P).
// Fuzzy searches all registered commands, shows keybinding hints.
// Default (empty-query) view groups commands into collapsible categories.

import { Component, createSignal, createMemo, For, Show } from "solid-js";
import { searchCommands, type Command } from "../lib/command-registry";
import { fuzzyMatch } from "../lib/fuzzy";

interface CommandPaletteProps {
  visible: boolean;
  onClose: () => void;
}

const MAX_RESULTS = 50;
const DEFAULT_LIST_LIMIT = 500;

/** Preferred display order for categories in the grouped view. */
const CATEGORY_ORDER: string[] = [
  "File",
  "Edit",
  "View",
  "Navigate",
  "Tools",
  "References",
  "Format",
  "Structure",
  "Insert",
  "Style",
  "InkyCap",
  "Creation Rules",
];

function categoryRank(cat: string): number {
  const idx = CATEGORY_ORDER.indexOf(cat);
  return idx >= 0 ? idx : CATEGORY_ORDER.length;
}

interface CategoryGroup {
  category: string;
  commands: { command: Command; match: { score: number; ranges: [number, number][] } }[];
}

const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [expandedCategory, setExpandedCategory] = createSignal<string | null>(null);

  /** True when no query is entered. */
  const isDefaultList = () => query().trim().length === 0;

  // ── Flat search results (used when query is non-empty) ──

  const searchResults = createMemo(() => {
    const q = query().trim();
    if (q.length === 0) return [];
    return searchCommands(q, MAX_RESULTS);
  });

  // ── Grouped categories (used when query is empty) ──

  const groupedCategories = createMemo((): CategoryGroup[] => {
    if (!isDefaultList()) return [];
    const all = searchCommands("", DEFAULT_LIST_LIMIT);
    const map = new Map<string, CategoryGroup>();
    for (const item of all) {
      let group = map.get(item.command.category);
      if (!group) {
        group = { category: item.command.category, commands: [] };
        map.set(item.command.category, group);
      }
      group.commands.push(item);
    }
    // Sort commands within each group by title
    for (const group of map.values()) {
      group.commands.sort((a, b) => a.command.title.localeCompare(b.command.title));
    }
    return [...map.values()].sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
  });

  /** Build a flat list of selectable rows for keyboard navigation in grouped mode.
   *  Each entry is either a category header or a command within the expanded category. */
  type NavRow =
    | { type: "header"; category: string; count: number }
    | { type: "command"; command: Command; match: { score: number; ranges: [number, number][] } };

  const navRows = createMemo((): NavRow[] => {
    if (!isDefaultList()) return [];
    const rows: NavRow[] = [];
    const expanded = expandedCategory();
    for (const group of groupedCategories()) {
      rows.push({ type: "header", category: group.category, count: group.commands.length });
      if (group.category === expanded) {
        for (const item of group.commands) {
          rows.push({ type: "command", command: item.command, match: item.match });
        }
      }
    }
    return rows;
  });

  function executeSelected() {
    if (isDefaultList()) {
      const rows = navRows();
      const row = rows[selectedIndex()];
      if (!row) return;
      if (row.type === "header") {
        toggleCategory(row.category);
      } else {
        close();
        row.command.execute();
      }
    } else {
      const list = searchResults();
      const item = list[selectedIndex()];
      if (item) {
        close();
        item.command.execute();
      }
    }
  }

  function toggleCategory(category: string) {
    const rows = navRows();
    if (expandedCategory() === category) {
      // Collapse — selection stays on the header
      setExpandedCategory(null);
    } else {
      // Expand — move selection to first item inside
      setExpandedCategory(category);
      // Find the header row index for this category, then +1 is first item
      const headerIdx = rows.findIndex(
        (r) => r.type === "header" && r.category === category,
      );
      if (headerIdx >= 0) {
        setSelectedIndex(headerIdx + 1);
      }
    }
  }

  function close() {
    setQuery("");
    setSelectedIndex(0);
    setExpandedCategory(null);
    props.onClose();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      // If a category is expanded, collapse it first
      if (isDefaultList() && expandedCategory() !== null) {
        const expanded = expandedCategory()!;
        setExpandedCategory(null);
        // Move selection to the header of the category that was expanded
        const rows = navRows();
        const headerIdx = rows.findIndex(
          (r) => r.type === "header" && r.category === expanded,
        );
        // After collapsing, navRows will recompute — find the header again
        // We need to recompute: after setting expandedCategory to null,
        // navRows is all headers. Find this category's header index.
        const groups = groupedCategories();
        const catIdx = groups.findIndex((g) => g.category === expanded);
        if (catIdx >= 0) setSelectedIndex(catIdx);
        return;
      }
      close();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (isDefaultList()) {
        const rows = navRows();
        setSelectedIndex((i) => Math.min(i + 1, rows.length - 1));
      } else {
        const list = searchResults();
        setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }

    if (e.key === "ArrowRight" && isDefaultList()) {
      const rows = navRows();
      const row = rows[selectedIndex()];
      if (row?.type === "header" && expandedCategory() !== row.category) {
        e.preventDefault();
        toggleCategory(row.category);
        return;
      }
    }

    if (e.key === "ArrowLeft" && isDefaultList()) {
      e.preventDefault();
      const rows = navRows();
      const row = rows[selectedIndex()];
      if (row?.type === "command" && expandedCategory()) {
        // Collapse and move to header
        const expanded = expandedCategory()!;
        setExpandedCategory(null);
        const groups = groupedCategories();
        const catIdx = groups.findIndex((g) => g.category === expanded);
        if (catIdx >= 0) setSelectedIndex(catIdx);
        return;
      }
      if (row?.type === "header" && expandedCategory() === row.category) {
        setExpandedCategory(null);
        return;
      }
    }

    if (e.key === "Enter") {
      e.preventDefault();
      executeSelected();
      return;
    }
  }

  /** Render a title with matched characters highlighted. */
  function HighlightedTitle(props: { title: string; ranges: [number, number][] }) {
    if (props.ranges.length === 0) return <>{props.title}</>;

    const parts: { text: string; highlight: boolean }[] = [];
    let pos = 0;

    for (const [start, end] of props.ranges) {
      if (start > pos) {
        parts.push({ text: props.title.slice(pos, start), highlight: false });
      }
      parts.push({ text: props.title.slice(start, end), highlight: true });
      pos = end;
    }

    if (pos < props.title.length) {
      parts.push({ text: props.title.slice(pos), highlight: false });
    }

    return (
      <>
        <For each={parts}>
          {(part) =>
            part.highlight ? (
              <span class="cmd-palette__highlight">{part.text}</span>
            ) : (
              <>{part.text}</>
            )
          }
        </For>
      </>
    );
  }

  /** Scroll the selected item into view. */
  let resultsEl: HTMLDivElement | undefined;
  function scrollSelectedIntoView() {
    if (!resultsEl) return;
    const selected = resultsEl.querySelector(".cmd-palette__result--selected, .cmd-palette__group-header--selected");
    if (selected) {
      (selected as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <Show when={props.visible}>
      <div class="cmd-palette__overlay" onClick={close}>
        <div class="cmd-palette cmd-palette--tall" onClick={(e) => e.stopPropagation()}>
          <input
            class="cmd-palette__input"
            type="text"
            placeholder="Type a command..."
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
              setExpandedCategory(null);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div class="cmd-palette__results" ref={resultsEl}>
            {/* ── Grouped (default) view ── */}
            <Show when={isDefaultList()}>
              <For each={navRows()}>
                {(row, index) => {
                  if (row.type === "header") {
                    const isExpanded = () => expandedCategory() === row.category;
                    const isSelected = () => index() === selectedIndex();
                    return (
                      <div
                        class={`cmd-palette__group-header ${isSelected() ? "cmd-palette__group-header--selected" : ""}`}
                        onClick={() => {
                          setSelectedIndex(index());
                          toggleCategory(row.category);
                        }}
                        onMouseEnter={() => setSelectedIndex(index())}
                        ref={() => queueMicrotask(scrollSelectedIntoView)}
                      >
                        <span class="cmd-palette__group-chevron">
                          {isExpanded() ? "▾" : "▸"}
                        </span>
                        <span class="cmd-palette__group-name">{row.category}</span>
                        <span class="cmd-palette__group-count">{row.count}</span>
                      </div>
                    );
                  }
                  // Command row inside expanded group
                  const isSelected = () => index() === selectedIndex();
                  return (
                    <div
                      class={`cmd-palette__result cmd-palette__result--nested ${isSelected() ? "cmd-palette__result--selected" : ""}`}
                      onClick={() => {
                        close();
                        row.command.execute();
                      }}
                      onMouseEnter={() => setSelectedIndex(index())}
                      ref={() => queueMicrotask(scrollSelectedIntoView)}
                    >
                      <span class="cmd-palette__result-title">
                        {row.command.title}
                      </span>
                      <Show when={row.command.shortcut}>
                        <span class="cmd-palette__shortcut">
                          {row.command.shortcut}
                        </span>
                      </Show>
                      <Show when={row.command.keybinding}>
                        <span class="cmd-palette__keybinding">
                          {row.command.keybinding}
                        </span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>

            {/* ── Search results view ── */}
            <Show when={!isDefaultList()}>
              <For each={searchResults()}>
                {(item, index) => (
                  <div
                    class={`cmd-palette__result ${index() === selectedIndex() ? "cmd-palette__result--selected" : ""}`}
                    onClick={() => {
                      close();
                      item.command.execute();
                    }}
                    onMouseEnter={() => setSelectedIndex(index())}
                  >
                    <span class="cmd-palette__result-category">
                      {item.command.category}
                    </span>
                    <span class="cmd-palette__result-title">
                      <HighlightedTitle
                        title={item.command.title}
                        ranges={item.match.ranges}
                      />
                    </span>
                    <Show when={item.command.shortcut}>
                      <span class="cmd-palette__shortcut">
                        {item.command.shortcut}
                      </span>
                    </Show>
                    <Show when={item.command.keybinding}>
                      <span class="cmd-palette__keybinding">
                        {item.command.keybinding}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={searchResults().length === 0 && query().trim().length > 0}>
                <div class="cmd-palette__empty">No matching commands</div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CommandPalette;
