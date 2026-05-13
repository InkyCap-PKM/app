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
// collapses into a single undo step.

import { Component, For, Show, createResource, createSignal, createEffect } from "solid-js";
import * as ipc from "../lib/ipc";
import { activeEditorView } from "../stores/editor";
import { getActiveTab } from "../stores/tabs";
import { toastError, showToast } from "../stores/toasts";

interface ScaffoldPickerProps {
  visible: boolean;
  onClose: () => void;
}

const ScaffoldPicker: Component<ScaffoldPickerProps> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [entries] = createResource(
    () => props.visible,
    async (visible) => (visible ? await ipc.listScaffoldEntries() : []),
  );

  createEffect(() => {
    if (props.visible) setSelectedIndex(0);
  });

  function close() {
    setSelectedIndex(0);
    props.onClose();
  }

  async function insertScaffold(entry: ipc.TemplateEntry) {
    const handle = activeEditorView();
    if (!handle) {
      showToast("warning", "Open a note first");
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
      : (tab?.title ?? "Untitled");

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
      });
      view.focus();
      close();
    } catch (e) {
      toastError("Failed to insert scaffold", e);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const list = entries() ?? [];

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
          aria-label="Insert scaffold"
        >
          <div class="scaffold-picker__header">
            <span class="scaffold-picker__title">Insert scaffold</span>
            <span class="scaffold-picker__hint">↑↓ to choose, Enter to insert, Esc to cancel</span>
          </div>
          <div
            class="quick-open__results scaffold-picker__results"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          >
            <Show
              when={!entries.loading && (entries() ?? []).length > 0}
              fallback={
                <Show when={!entries.loading}>
                  <div class="quick-open__empty">
                    No scaffolds in <code>.inkycap/scaffolds/</code>. Create one
                    from the Templates panel.
                  </div>
                </Show>
              }
            >
              <For each={entries()}>
                {(entry, index) => (
                  <div
                    class={`quick-open__result ${index() === selectedIndex() ? "quick-open__result--selected" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void insertScaffold(entry);
                    }}
                    onMouseEnter={() => setSelectedIndex(index())}
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
