// Renders the active citation style picker (stores/citationStylePicker.ts):
// every style built into Typst, searchable by title, name or alias. A search
// ending in `.csl` offers that file instead. Mounted once at the app root.
//
// Rows reuse the citation picker's layout (title above, name below), since
// both list one item with a title and the name written into the source.

import { Component, Show, For, createSignal, createMemo, createResource, createEffect } from "solid-js";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errors";
import { fuzzyMatch, compareMatches, type FuzzyMatch } from "../lib/fuzzy";
import { createHoverGuard } from "../lib/picker-hover";
import { isCslPath, loadCitationStyles } from "../lib/citation-styles";
import { activeCitationStylePicker, resolveCitationStylePicker } from "../stores/citationStylePicker";

/** One row: a built-in style, or the `.csl` file typed into the search. */
interface StyleRow {
  name: string;
  title: string;
  aliases: string[];
}

const CitationStylePickerHost: Component = () => {
  const t = useI18n();
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const hover = createHoverGuard();
  let resultsEl: HTMLDivElement | undefined;

  const visible = () => activeCitationStylePicker() !== null;

  const [styles] = createResource(visible, async (open) => (open ? loadCitationStyles() : []));

  const rows = createMemo<StyleRow[]>(() => {
    const all: StyleRow[] = styles.error ? [] : (styles() ?? []);
    const q = query().trim();
    const out: StyleRow[] = [];
    if (isCslPath(q)) {
      const path = q.startsWith("/") ? q : `/${q}`;
      out.push({ name: path, title: t("citationStyles.useFile"), aliases: [] });
    }
    if (q === "") return [...out, ...all];
    const scored: { row: StyleRow; match: FuzzyMatch }[] = [];
    for (const row of all) {
      const m = fuzzyMatch(q, `${row.title} ${row.name} ${row.aliases.join(" ")}`);
      if (m) scored.push({ row, match: m });
    }
    scored.sort((a, b) => compareMatches(a.match, b.match));
    return [...out, ...scored.map((s) => s.row)];
  });

  // Start on the style in use, so the list opens where the writer is.
  createEffect(() => {
    const current = activeCitationStylePicker()?.current;
    const list = styles();
    if (!current || !list) return;
    const idx = list.findIndex((s) => s.name === current || s.aliases.includes(current));
    if (idx >= 0) setSelectedIndex(idx);
  });

  // Keep the keyboard-selected row in view.
  createEffect(() => {
    const idx = selectedIndex();
    rows();
    (resultsEl?.children[idx] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  });

  function settle(style: string | null) {
    setQuery("");
    setSelectedIndex(0);
    resolveCitationStylePicker(style);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const list = rows();
    if (e.key === "Escape") {
      e.preventDefault();
      settle(null);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = list[selectedIndex()];
      if (row) settle(row.name);
    }
  }

  function emptyMessage(): string {
    if (styles.loading) return t("citationStyles.loading");
    if (styles.error) return t("citationStyles.loadFailed", { error: errorText(styles.error) });
    return t("citationStyles.noMatch");
  }

  return (
    <Show when={visible()}>
      <div class="cmd-palette__overlay" onClick={() => settle(null)}>
        <div class="cmd-palette" onClick={(e) => e.stopPropagation()}>
          <input
            class="cmd-palette__input"
            type="text"
            placeholder={t("citationStyles.search")}
            aria-label={t("citationStyles.search")}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div class="cmd-palette__results" ref={resultsEl}>
            <For each={rows()}>
              {(row, index) => (
                <div
                  class={`cmd-palette__result citation-picker__entry ${index() === selectedIndex() ? "cmd-palette__result--selected" : ""}`}
                  onClick={() => settle(row.name)}
                  onMouseMove={(e) => hover.move(e, () => setSelectedIndex(index()))}
                >
                  <span class="citation-picker__title">{row.title}</span>
                  <div class="citation-picker__detail">
                    <span class="citation-picker__key">{row.name}</span>
                    <Show when={row.aliases.length > 0}>
                      <span class="citation-picker__meta">
                        {t("citationStyles.alsoKnownAs", { names: row.aliases.join(", ") })}
                      </span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
            <Show when={rows().length === 0}>
              <div class="cmd-palette__empty">{emptyMessage()}</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default CitationStylePickerHost;
