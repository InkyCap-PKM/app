// Right-panel Annotations pane: lists every `#annotation` comment and
// `#suggestion` tracked change in the active note, lets the user click one to
// jump to it in the editor, filters by text at the top, and offers a fixed
// bottom toolbar to insert new markup at the editor cursor. Resolving a
// suggestion (Accept/Reject) happens inline at its widget after jumping —
// this pane is a navigator + author, not a resolver.

import { Component, For, Show, createSignal, createMemo, createEffect } from "solid-js";
import { EditorView } from "@codemirror/view";
import { X, Plus, Minus, Replace, MessageSquare } from "lucide-solid";
import {
  noteAnnotations,
  rescanAnnotations,
  type AnnotationEntry,
  type AnnotationKind,
} from "../editor/typst-decorations/annotation-tracker";
import {
  insertAnnotationMarkup,
  type InsertKind,
} from "../editor/typst-decorations/annotation-insert";
import { activeEditorView } from "../stores/editor";
import { t } from "../lib/i18n";

/** Semantic tone for a kind's icon + badge (mirrors the inline colours). */
function tone(kind: AnnotationKind): string {
  switch (kind) {
    case "insert":
      return "insert";
    case "delete":
      return "delete";
    case "replace":
      return "replace";
    default:
      return "comment";
  }
}

function kindLabel(kind: AnnotationKind): string {
  return t(`annotations.kind.${kind}`);
}

const KindIcon: Component<{ kind: AnnotationKind }> = (props) => {
  switch (props.kind) {
    case "insert":
      return <Plus size={14} />;
    case "delete":
      return <Minus size={14} />;
    case "replace":
      return <Replace size={14} />;
    default:
      return <MessageSquare size={14} />;
  }
};

const AnnotationsPanel: Component = () => {
  const [filter, setFilter] = createSignal("");

  // Scan the active editor when this pane opens (the component mounts) and
  // whenever the active editor changes (tab switch). Live edits while the pane
  // is open are kept current by the annotation tracker plugin.
  createEffect(() => {
    rescanAnnotations(activeEditorView()?.view);
  });

  const visible = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const all = noteAnnotations();
    if (!q) return all;
    return all.filter(
      (a) =>
        a.body.toLowerCase().includes(q) ||
        a.oldText.toLowerCase().includes(q) ||
        a.note.toLowerCase().includes(q) ||
        a.by.toLowerCase().includes(q) ||
        kindLabel(a.kind).toLowerCase().includes(q),
    );
  });

  /** The primary text shown for a row. */
  const primary = (a: AnnotationEntry): string => {
    const body = a.body.trim();
    if (a.kind === "replace") {
      const old = a.oldText.trim();
      if (old && body) return `${old} → ${body}`;
      return body || old || t("annotations.emptyItem");
    }
    return body || t("annotations.emptyItem");
  };

  const attribution = (a: AnnotationEntry): string =>
    [a.by, a.on].filter(Boolean).join(" · ");

  /** Scroll the editor to an item and place the caret at its start, so the
   *  inline widget (and its Accept/Reject menu, for suggestions) is in view. */
  function jumpTo(a: AnnotationEntry) {
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const pos = Math.min(a.from, view.state.doc.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }

  /** Insert markup at the editor cursor. `onMouseDown` + preventDefault keeps
   *  the editor focused so the insert lands at its caret, not the toolbar. */
  function insert(e: MouseEvent, kind: InsertKind) {
    e.preventDefault();
    insertAnnotationMarkup(activeEditorView()?.view, kind);
  }

  return (
    <div class="annotations-panel">
      <div class="right-panel__section-header">
        <span>{t("annotations.title")}</span>
      </div>

      <div class="right-panel__links-filter-wrap">
        <input
          class="right-panel__links-filter-input"
          type="text"
          placeholder={t("annotations.filterPlaceholder")}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter("");
          }}
        />
        <Show when={filter().length > 0}>
          <button
            class="right-panel__links-filter-clear"
            onClick={() => setFilter("")}
            title="Clear filter"
            aria-label="Clear filter"
          >
            <X size={12} />
          </button>
        </Show>
      </div>

      <div class="annotations-panel__list">
        <Show
          when={visible().length > 0}
          fallback={<p class="sidebar-hint">{t("annotations.empty")}</p>}
        >
          <For each={visible()}>
            {(a) => (
              <div
                class="sidebar-item annotations-panel__item"
                onClick={() => jumpTo(a)}
                title={primary(a)}
              >
                <span class={`sidebar-item__icon annotations-panel__icon--${tone(a.kind)}`}>
                  <KindIcon kind={a.kind} />
                </span>
                <span class="annotations-panel__body">
                  <span class="annotations-panel__primary">
                    <span class="sidebar-item__label">{primary(a)}</span>
                    <span class={`annotations-panel__badge annotations-panel__badge--${tone(a.kind)}`}>
                      {kindLabel(a.kind)}
                    </span>
                  </span>
                  <Show when={attribution(a)}>
                    <span class="annotations-panel__secondary">{attribution(a)}</span>
                  </Show>
                  <Show when={a.note.trim()}>
                    <span class="annotations-panel__note">
                      <MessageSquare size={11} /> {a.note.trim()}
                    </span>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="annotations-panel__toolbar">
        <button
          class="annotations-panel__tool annotations-panel__tool--insert"
          onMouseDown={(e) => insert(e, "insert")}
          title={t("annotations.tool.insert")}
          aria-label={t("annotations.tool.insert")}
        >
          <Plus size={16} />
        </button>
        <button
          class="annotations-panel__tool annotations-panel__tool--delete"
          onMouseDown={(e) => insert(e, "delete")}
          title={t("annotations.tool.delete")}
          aria-label={t("annotations.tool.delete")}
        >
          <Minus size={16} />
        </button>
        <button
          class="annotations-panel__tool annotations-panel__tool--replace"
          onMouseDown={(e) => insert(e, "replace")}
          title={t("annotations.tool.replace")}
          aria-label={t("annotations.tool.replace")}
        >
          <Replace size={16} />
        </button>
        <button
          class="annotations-panel__tool annotations-panel__tool--comment"
          onMouseDown={(e) => insert(e, "annotation")}
          title={t("annotations.tool.annotation")}
          aria-label={t("annotations.tool.annotation")}
        >
          <MessageSquare size={16} />
        </button>
      </div>
    </div>
  );
};

export default AnnotationsPanel;
