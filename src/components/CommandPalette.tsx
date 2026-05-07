// Command palette (Ctrl+P).
// Fuzzy searches all registered commands, shows keybinding hints.

import { Component, createSignal, createMemo, For, Show } from "solid-js";
import { searchCommands, type Command } from "../lib/command-registry";
import { fuzzyMatch } from "../lib/fuzzy";

interface CommandPaletteProps {
  visible: boolean;
  onClose: () => void;
}

const MAX_RESULTS = 30;
/** Higher cap for the empty-query default list (every command shown). */
const DEFAULT_LIST_LIMIT = 500;

const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const results = createMemo(() => {
    const q = query().trim();
    // Show every command (grouped by category in the render below)
    // when the input is empty so users see what's available.
    const limit = q.length === 0 ? DEFAULT_LIST_LIMIT : MAX_RESULTS;
    const list = searchCommands(q, limit);
    if (q.length === 0) {
      // Stable sort by category, then by title, so the grouped headers
      // render contiguous blocks instead of category-interleaved noise.
      return [...list].sort((a, b) => {
        const c = a.command.category.localeCompare(b.command.category);
        return c !== 0 ? c : a.command.title.localeCompare(b.command.title);
      });
    }
    return list;
  });

  /** True when no query is entered — render in grouped-list mode. */
  const isDefaultList = () => query().trim().length === 0;

  function executeSelected() {
    const list = results();
    const idx = selectedIndex();
    if (list[idx]) {
      close();
      list[idx].command.execute();
    }
  }

  function close() {
    setQuery("");
    setSelectedIndex(0);
    props.onClose();
  }

  function handleKeyDown(e: KeyboardEvent) {
    const list = results();

    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
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

  return (
    <Show when={props.visible}>
      <div class="cmd-palette__overlay" onClick={close}>
        <div class="cmd-palette" onClick={(e) => e.stopPropagation()}>
          <input
            class="cmd-palette__input"
            type="text"
            placeholder="Type a command..."
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div class="cmd-palette__results">
            <For each={results()}>
              {(item, index) => {
                const prev = () => results()[index() - 1];
                const showHeader = () =>
                  isDefaultList() &&
                  (index() === 0 ||
                    prev()?.command.category !== item.command.category);
                return (
                  <>
                    <Show when={showHeader()}>
                      <div class="cmd-palette__category-header">
                        {item.command.category}
                      </div>
                    </Show>
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
                      <Show when={item.command.keybinding}>
                        <span class="cmd-palette__keybinding">
                          {item.command.keybinding}
                        </span>
                      </Show>
                    </div>
                  </>
                );
              }}
            </For>
            <Show when={results().length === 0 && query().trim().length > 0}>
              <div class="cmd-palette__empty">No matching commands</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CommandPalette;
