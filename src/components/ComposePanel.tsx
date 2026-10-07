// Compose mode: write a new note (the draft, in the editor) beside cards
// holding the passages in other notes that link to the note Compose was
// started from (in the right panel).
//
// Started from the Links pane's Compose button. The draft is made exactly as
// Ctrl+N makes a note, so the user's naming, folder, template and ZID
// settings all apply. A passage can be copied in as it is or as a quote that
// links back to its note; either way its note is added to the draft's
// `derived-from` property. Session state lives in stores/compose.ts.

import { Component, For, Show, createSignal, onCleanup, createEffect, on } from "solid-js";
import { CopyPlus, GripVertical, Link, NotebookPen, X } from "lucide-solid";
import type { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import * as ipc from "../lib/ipc";
import { t, useI18n } from "../lib/i18n";
import { createDragReorder } from "../lib/drag-reorder";
import { pathEquals } from "../lib/paths";
import { typstStringEscape } from "../lib/typst";
import { CopyQuoteIcon } from "./icons";
import { registerRightPanel } from "./right-panel-registry";
import { externalReload } from "../editor/typst-decorations/visual-plugin";
import { triggerCreationRule } from "../stores/creation-rules";
import { openCreatedNote, openTab, tabs } from "../stores/tabs";
import { focusedActiveTabId } from "../stores/panes";
import { editorViewFor } from "../stores/editor";
import { setRightCollapsed, setRightPanelTab } from "../stores/layout";
import { toastError } from "../stores/toasts";
import {
  beginComposeSession,
  composeSessionFor,
  dismissCard,
  moveCard,
  visibleCards,
  type ComposeCard,
} from "../stores/compose";

const PANEL_ID = "compose";

/** How a passage goes into the draft: as written, as a quote crediting its
 *  note, or only as a link to its note. */
type InsertMode = "copy" | "quote" | "link";

let unregisterPanel: (() => void) | null = null;

/** Create a draft the way Ctrl+N does, open it, and show the Compose panel
 *  with the passages around `origin`'s inbound links. Does nothing if the
 *  user cancels naming the note. */
export async function startCompose(origin: { path: string; name: string }): Promise<void> {
  try {
    const result = await triggerCreationRule("new-note");
    if (!result) return;
    const name = result.path.split("/").pop() ?? "";
    const tabId = openCreatedNote(
      { type: "file", title: name, path: result.path },
      { cursorOffset: result.cursor_offset ?? undefined },
    );
    // Registered once and left in place: the `when` gate hides the tab
    // whenever the focused tab has no session.
    unregisterPanel ??= registerRightPanel({
      id: PANEL_ID,
      label: t("compose.tabTitle"),
      icon: NotebookPen,
      component: ComposePanel,
      when: () => !!composeSessionFor(focusedActiveTabId()),
    });
    setRightCollapsed(false);
    setRightPanelTab(PANEL_ID);
    await beginComposeSession(tabId, origin);
  } catch (e) {
    toastError(t("compose.startFailed"), e);
  }
}

const ComposePanel: Component = () => {
  const t = useI18n();
  const draftTabId = () => focusedActiveTabId();
  const session = () => composeSessionFor(draftTabId());
  const draftPath = () => tabs.find((tab) => tab.id === draftTabId())?.path;

  // Names of the notes the draft already links to, read from the editor's
  // text (saved or not). Refreshed on save and after each insert.
  const [linkedNames, setLinkedNames] = createSignal<string[]>([]);
  async function refreshLinkedNames() {
    const handle = draftTabId() ? editorViewFor(draftTabId()!) : undefined;
    if (!handle) return;
    try {
      setLinkedNames(await ipc.wikilinkNames(handle.view.state.doc.toString()));
    } catch {
      /* keep the previous dimming */
    }
  }
  createEffect(on(draftTabId, () => void refreshLinkedNames()));
  const onSaved = (e: Event) => {
    const path = (e as CustomEvent).detail?.path;
    if (path && pathEquals(path, draftPath())) void refreshLinkedNames();
  };
  document.addEventListener("inkycap:note-saved", onSaved);
  onCleanup(() => document.removeEventListener("inkycap:note-saved", onSaved));

  const isUsed = (card: ComposeCard) => linkedNames().includes(card.source.name.toLowerCase());

  const drag = createDragReorder((fromId, targetId, position) => {
    const id = draftTabId();
    if (id) moveCard(id, fromId, targetId, position);
  });

  /** Put `cards` into the draft at the cursor, in order. Copies add their
   *  notes to `derived-from`; links don't, since the link itself records
   *  the connection. */
  async function insert(cards: ComposeCard[], mode: InsertMode) {
    if (cards.length === 0) return;
    const id = draftTabId();
    const view = id ? editorViewFor(id)?.view : undefined;
    if (!view) {
      toastError(t("compose.needsEditor"));
      return;
    }
    if (mode === "link") {
      const names = uniqueNames(cards);
      if (names.length === 1) insertInline(view, wikilinkMarkup(names[0]));
      else insertBlock(view, names.map((n) => `- ${wikilinkMarkup(n)}`).join("\n"));
    } else {
      const blocks = cards.map((c) =>
        mode === "quote"
          ? quoteMarkup(c.source.name, c.passage.paragraph.source)
          : c.passage.paragraph.source,
      );
      insertBlock(view, blocks.join("\n\n"));
      await recordSources(view, uniqueNames(cards));
    }
    void refreshLinkedNames();
  }

  function openSource(card: ComposeCard) {
    // A "new tab" action, so the user's "switch to new tabs" setting decides
    // whether the draft stays in view.
    openTab(
      { type: "file", title: card.source.name, path: card.source.path },
      { forceNewTab: true, newTabAction: true },
    );
  }

  /** The three insert buttons, for one card or for all of them. */
  const InsertButtons: Component<{ cards: () => ComposeCard[]; all?: boolean }> = (props) => (
    <>
      <button
        class="ui-icon-btn"
        onClick={() => void insert(props.cards(), "copy")}
        title={props.all ? t("compose.copyAll") : t("compose.copy")}
        aria-label={props.all ? t("compose.copyAll") : t("compose.copy")}
      >
        <CopyPlus size={16} />
      </button>
      <button
        class="ui-icon-btn"
        onClick={() => void insert(props.cards(), "quote")}
        title={props.all ? t("compose.copyAllQuote") : t("compose.copyQuote")}
        aria-label={props.all ? t("compose.copyAllQuote") : t("compose.copyQuote")}
      >
        <CopyQuoteIcon size={16} />
      </button>
      <button
        class="ui-icon-btn"
        onClick={() => void insert(props.cards(), "link")}
        title={props.all ? t("compose.insertAllLinks") : t("compose.insertLink")}
        aria-label={props.all ? t("compose.insertAllLinks") : t("compose.insertLink")}
      >
        <Link size={16} />
      </button>
    </>
  );

  return (
    <div class="right-panel__pane">
      <Show when={session()}>
        {(s) => (
          <>
            <div class="compose__header">
              <p class="compose__origin">{t("compose.origin", { name: s().origin.name })}</p>
              <Show when={visibleCards(s()).length > 0}>
                <div class="compose__all">
                  <span class="compose__all-label">{t("compose.allPassages")}</span>
                  <InsertButtons cards={() => visibleCards(s())} all />
                </div>
              </Show>
            </div>
            <div class="right-panel__pane-body">
              <Show when={s().loading}>
                <p class="sidebar-hint">{t("compose.loading")}</p>
              </Show>
              <Show when={!s().loading && visibleCards(s()).length === 0}>
                <p class="sidebar-hint">{t("compose.empty")}</p>
              </Show>
              <For each={visibleCards(s())}>
                {(card) => (
                  <div
                    classList={{
                      compose__card: true,
                      "compose__card--used": isUsed(card),
                      "reorder--dragging": drag.draggingId() === card.id,
                      "reorder--drop-above":
                        drag.dragOverId() === card.id && drag.dropPosition() === "before",
                      "reorder--drop-below":
                        drag.dragOverId() === card.id && drag.dropPosition() === "after",
                    }}
                    onDragOver={(e) => drag.onDragOver(e, card.id)}
                    onDragLeave={() => drag.onDragLeave(card.id)}
                    onDrop={(e) => drag.onDrop(e, card.id)}
                  >
                    <div class="compose__card-head">
                      <span
                        class="compose__grip"
                        draggable={true}
                        onDragStart={(e) => drag.onDragStart(e, card.id)}
                        onDragEnd={drag.onDragEnd}
                        title={t("compose.dragToReorder")}
                      >
                        <GripVertical size={14} />
                      </span>
                      <button
                        class="compose__source"
                        onClick={() => openSource(card)}
                        title={t("compose.openSource", { name: card.source.name })}
                      >
                        {card.source.name}
                      </button>
                    </div>
                    <Show when={card.passage.heading}>
                      <p class="compose__heading">{card.passage.heading}</p>
                    </Show>
                    <p class="compose__text">{card.passage.paragraph.text}</p>
                    <div class="compose__actions">
                      <InsertButtons cards={() => [card]} />
                      <button
                        class="ui-icon-btn"
                        onClick={() => dismissCard(draftTabId()!, card.id)}
                        title={t("compose.dismiss")}
                        aria-label={t("compose.dismiss")}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

/** The notice under a Compose draft's editor toolbar: the cards last only
 *  until the tab closes, and a button brings the Compose tab back into view. */
export const ComposeNotice: Component<{ tabId: string }> = (props) => {
  const t = useI18n();
  return (
    <Show when={composeSessionFor(props.tabId)}>
      <div class="editor-notice" role="note">
        <NotebookPen class="editor-notice__icon" size={15} />
        <span>{t("compose.notice")}</span>
        <button
          class="btn btn--ghost btn--sm"
          onClick={() => {
            setRightCollapsed(false);
            setRightPanelTab(PANEL_ID);
          }}
        >
          {t("compose.showCards")}
        </button>
      </div>
    </Show>
  );
};

/** The cards' note names, once each, in card order. */
function uniqueNames(cards: ComposeCard[]): string[] {
  return [...new Set(cards.map((c) => c.source.name))];
}

function wikilinkMarkup(name: string): string {
  return `#wikilink("${typstStringEscape(name)}")`;
}

/** A block quote of `source` attributed to a link to note `name`. */
function quoteMarkup(name: string, source: string): string {
  return `#quote(block: true, attribution: [${wikilinkMarkup(name)}])[\n${source.trim()}\n]`;
}

/** Insert `text` at the draft's cursor, within the line. */
function insertInline(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** Insert `text` at the draft's cursor as a block of its own, with a blank
 *  line before and after, and leave the cursor after it. */
function insertBlock(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  const before = view.state.doc.sliceString(Math.max(0, from - 2), from);
  const lead = from === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const insert = `${lead}${text}\n\n`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  });
  view.focus();
}

/** Add notes `names` to the draft's `derived-from` property, changing only
 *  the `#note(...)` call so the cursor and the writer's undo history stay
 *  put. */
async function recordSources(view: EditorView, names: string[]) {
  try {
    // The writer may type while the new text is worked out; start again from
    // the fresh text when that happens.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = view.state.doc.toString();
      let after = before;
      for (const name of names) after = (await ipc.noteWithDerivedFrom(after, name)) ?? after;
      if (after === before) return;
      if (view.state.doc.toString() !== before) continue;
      let start = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start++;
      let endBefore = before.length;
      let endAfter = after.length;
      while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore--;
        endAfter--;
      }
      view.dispatch({
        changes: { from: start, to: endBefore, insert: after.slice(start, endAfter) },
        // The `#note(...)` call is locked against typing in the visual
        // editor; this marks the change as the app's own, like a
        // properties-panel edit.
        annotations: [externalReload.of(true), Transaction.addToHistory.of(true)],
      });
      return;
    }
  } catch (e) {
    toastError(t("compose.recordSourceFailed"), e);
  }
}

export default ComposePanel;
