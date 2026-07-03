// Ctrl+\ scaffold picker.
//
// Lists scaffolds and inserts the chosen one into the active editor at the
// cursor (or replacing the selection). If the scaffold begins with a
// `#note(...)` call, its kwargs are merged into the target note's existing
// `#note(...)` — existing values win on conflict; new keys are appended.
//
// The merge + insert happens in the `prepare_scaffold_insert` Tauri command
// which returns the new full source and cursor offset; we replace the
// editor's whole document in one CodeMirror transaction so the operation
// collapses into a single undo step. That transaction is tagged
// `externalReload` so the protected-range change filters (import-line guard,
// #note guard) don't clip the whole-doc replace and clear the note.

import { Component, For, Show, createResource, createSignal, createEffect, createMemo } from "solid-js";
import * as ipc from "../lib/ipc";
import { fuzzyMatch } from "../lib/fuzzy";
import { activeEditorView } from "../stores/editor";
import { getActiveTab } from "../stores/tabs";
import { toastError, showToast } from "../stores/toasts";
import { externalReload } from "../editor/typst-decorations/visual-plugin";
import { useI18n } from "../lib/i18n";
import { createHoverGuard } from "../lib/picker-hover";

interface ScaffoldPickerProps {
  visible: boolean;
  onClose: () => void;
}

const ScaffoldPicker: Component<ScaffoldPickerProps> = (props) => {
  const t = useI18n();
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const hover = createHoverGuard();
  let resultsEl: HTMLDivElement | undefined;

  // Keep the keyboard-selected scaffold in view (the list nests inside <Show>
  // fallbacks, so scroll by the selected row's class rather than child index).
  createEffect(() => {
    selectedIndex();
    query();
    queueMicrotask(() => {
      (resultsEl?.querySelector(".quick-open__result--selected") as HTMLElement | null)
        ?.scrollIntoView({ block: "nearest" });
    });
  });
  const [entries] = createResource(
    () => props.visible,
    async (visible) => (visible ? await ipc.listScaffoldEntries() : []),
  );

  const filtered = createMemo(() => {
    const all = entries() ?? [];
    const q = query().trim();
    if (q.length === 0) return all;
    const scored: { entry: ipc.TemplateEntry; score: number }[] = [];
    for (const entry of all) {
      const m = fuzzyMatch(q, entry.name);
      if (m) scored.push({ entry, score: m.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.entry);
  });

  createEffect(() => {
    if (props.visible) {
      setQuery("");
      setSelectedIndex(0);
    }
  });

  function close() {
    setQuery("");
    setSelectedIndex(0);
    props.onClose();
  }

  async function insertScaffold(entry: ipc.TemplateEntry) {
    const handle = activeEditorView();
    if (!handle) {
      showToast("warning", t("scaffoldPicker.openNoteFirst"));
      close();
      return;
    }
    const view = handle.view;
    const sel = view.state.selection.main;
    const currentSource = view.state.doc.toString();

    // Title for {{title}} expansion: derive from the active tab's filename.
    const tab = getActiveTab();
    const title = tab?.path
      ? (tab.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "")
      : (tab?.title ?? t("bookmarks.untitled"));

    try {
      const result = await ipc.prepareScaffoldInsert({
        scaffoldName: entry.name,
        currentSource,
        title,
        cursorOffset: sel.head,
        selectionFrom: sel.empty ? undefined : sel.from,
        selectionTo: sel.empty ? undefined : sel.to,
      });

      view.dispatch({
        changes: { from: 0, to: currentSource.length, insert: result.new_source },
        selection: { anchor: result.new_cursor_offset },
        // Whole-doc replace: bypass the protected-range change filters that
        // would otherwise preserve the old import/#note lines against this
        // change and shred the result (clearing the note). Same pattern as
        // the editor's own external-reload path.
        annotations: externalReload.of(true),
      });
      view.focus();
      close();
    } catch (e) {
      toastError(t("scaffoldPicker.insertFailed"), e);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const list = filtered();

    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Wrap to the top after the last entry.
      if (list.length > 0) setSelectedIndex((i) => (i + 1) % list.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      // Wrap to the bottom before the first entry.
      if (list.length > 0) setSelectedIndex((i) => (i - 1 + list.length) % list.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const idx = selectedIndex();
      if (list[idx]) {
        void insertScaffold(list[idx]);
      }
      return;
    }
  }

  return (
    <Show when={props.visible}>
      <div
        class="quick-open__overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          class="quick-open scaffold-picker"
          role="dialog"
          aria-modal="true"
          aria-label={t("scaffoldPicker.title")}
        >
          <div class="scaffold-picker__header">
            <span class="scaffold-picker__title">{t("scaffoldPicker.title")}</span>
            <span class="scaffold-picker__hint">{t("scaffoldPicker.hint")}</span>
          </div>
          <input
            class="quick-open__input"
            type="text"
            placeholder={t("scaffoldPicker.filterPlaceholder")}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
          <div class="quick-open__results scaffold-picker__results" ref={resultsEl}>
            <Show
              when={!entries.loading && filtered().length > 0}
              fallback={
                <Show when={!entries.loading}>
                  <Show
                    when={query().trim().length > 0}
                    fallback={
                      <div class="quick-open__empty">
                        {t("scaffoldPicker.emptyBefore")} <code>{".inkycap/scaffolds/"}</code>{t("scaffoldPicker.emptyAfter")}
                      </div>
                    }
                  >
                    <div class="quick-open__empty">{t("scaffoldPicker.noMatching")}</div>
                  </Show>
                </Show>
              }
            >
              <For each={filtered()}>
                {(entry, index) => (
                  <div
                    class={`quick-open__result ${index() === selectedIndex() ? "quick-open__result--selected" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void insertScaffold(entry);
                    }}
                    onMouseMove={(e) => hover.move(e, () => setSelectedIndex(index()))}
                  >
                    <span class="quick-open__result-name">{entry.name}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ScaffoldPicker;
