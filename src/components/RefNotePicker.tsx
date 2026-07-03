import { Component, createSignal, createResource, createEffect, For, Show } from "solid-js";
import type { BibEntry } from "../lib/types";
import * as ipc from "../lib/ipc";
import { activeEditorView } from "../stores/editor";
import { useI18n } from "../lib/i18n";
import { ArrowLeft } from "lucide-solid";
import CitationPicker from "./CitationPicker";
import { createHoverGuard } from "../lib/picker-hover";

interface RefNotePickerProps {
  visible: boolean;
  onClose: () => void;
}

const RefNotePicker: Component<RefNotePickerProps> = (props) => {
  const t = useI18n();
  const [selectedEntry, setSelectedEntry] = createSignal<BibEntry | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [filter, setFilter] = createSignal("");
  const hover = createHoverGuard();
  let resultsEl: HTMLDivElement | undefined;

  // Keep the keyboard-selected note in view. The list sits inside nested
  // <Show> blocks, so scroll by the selected row's class rather than child
  // index.
  createEffect(() => {
    selectedIndex();
    filter();
    queueMicrotask(() => {
      (resultsEl?.querySelector(".cmd-palette__result--selected") as HTMLElement | null)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  const [notes] = createResource(
    () => selectedEntry()?.key,
    async (key) => {
      if (!key) return [];
      try {
        return await ipc.getReferenceNotes(key);
      } catch (err) {
        console.error("Failed to load reference notes:", err);
        throw err;
      }
    },
  );

  function handleReferenceSelected(entry: BibEntry) {
    setSelectedEntry(entry);
    setSelectedIndex(0);
  }

  function insertNote(content: string) {
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const { from, to } = view.state.selection.main;
    const insert = content.trim();
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    view.focus();
    close();
  }

  function close() {
    setSelectedEntry(null);
    setSelectedIndex(0);
    setFilter("");
    props.onClose();
  }

  function goBack() {
    setSelectedEntry(null);
    setSelectedIndex(0);
    setFilter("");
  }

  const filteredNotes = () => {
    const all = notes() ?? [];
    const q = filter().trim().toLowerCase();
    if (!q) return all;
    return all.filter((n) => n.content.toLowerCase().includes(q));
  };

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      goBack();
      return;
    }
    const noteList = filteredNotes();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, noteList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const note = noteList[selectedIndex()];
      if (note) insertNote(note.content);
    }
  }

  function notePreview(content: string, maxLen = 120): string {
    const trimmed = content.trim().replace(/\n+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
  }

  return (
    <>
      <CitationPicker
        visible={props.visible && selectedEntry() === null}
        onClose={close}
        onSelect={handleReferenceSelected}
        placeholder={t("refNotes.searchPlaceholder")}
        filter={(entry) => entry.has_notes}
      />
      <Show when={props.visible && selectedEntry() !== null}>
        <div class="cmd-palette__overlay" onClick={close}>
          <div class="cmd-palette" onClick={(e) => e.stopPropagation()}>
            <div class="ref-note-picker__header">
              <button class="ref-note-picker__back" onClick={goBack} title={t("refNotes.back")}>
                <ArrowLeft size={14} />
              </button>
              <span class="ref-note-picker__ref-label">
                @{selectedEntry()?.key}
                <Show when={selectedEntry()?.title}>
                  {" — "}{selectedEntry()!.title}
                </Show>
              </span>
            </div>
            <input
              class="cmd-palette__input"
              type="text"
              placeholder={t("refNotes.filterPlaceholder")}
              value={filter()}
              onInput={(e) => {
                setFilter(e.currentTarget.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              autofocus
              ref={(el) => queueMicrotask(() => el.focus())}
            />
            <div class="cmd-palette__results" ref={resultsEl}>
              <Show when={notes.loading}>
                <div class="cmd-palette__empty">{t("refNotes.loadingNotes")}</div>
              </Show>
              <Show when={notes.error}>
                <div class="cmd-palette__empty">{t("refNotes.error", { error: String(notes.error) })}</div>
              </Show>
              <Show when={!notes.loading && !notes.error}>
                <Show
                  when={filteredNotes().length > 0}
                  fallback={
                    <div class="cmd-palette__empty">{t("refNotes.noNotes")}</div>
                  }
                >
                  <For each={filteredNotes()}>
                    {(note, index) => (
                      <div
                        class={`cmd-palette__result ref-note-picker__note ${index() === selectedIndex() ? "cmd-palette__result--selected" : ""}`}
                        onClick={() => insertNote(note.content)}
                        onMouseMove={(e) => hover.move(e, () => setSelectedIndex(index()))}
                      >
                        <span class="ref-note-picker__note-preview">
                          {notePreview(note.content)}
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
};

export default RefNotePicker;
