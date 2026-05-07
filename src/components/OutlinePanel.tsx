// Outline panel: heading list for the active editor.
//
// Reads the heading signal published by the CM6 heading tracker
// and renders a clickable list. Clicking a heading scrolls the
// editor to that position.

import { Component, For, Show } from "solid-js";
import { headings, type Heading } from "../editor/typst-decorations/heading-tracker";
import { activeEditorView } from "../stores/editor";
import { EditorView } from "@codemirror/view";

const OutlinePanel: Component = () => {
  function scrollToHeading(h: Heading) {
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const pos = Math.min(h.pos, view.state.doc.length);
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
  }

  return (
    <div class="outline-panel">
      <Show
        when={headings().length > 0}
        fallback={<p class="sidebar-hint">No headings</p>}
      >
        <For each={headings()}>
          {(h) => (
            <div
              class="outline-panel__item"
              style={{ "padding-left": `${(h.level - 1) * 16 + 12}px` }}
              onClick={() => scrollToHeading(h)}
            >
              {h.text}
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};

export default OutlinePanel;
