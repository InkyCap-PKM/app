// Typewriter mode: keeps the cursor's line in the vertical middle of the editor
// while typing, so the text scrolls up under a fixed line. Scrolling by hand
// (wheel, scrollbar, PageUp/Down) is left alone; only edits and cursor moves
// recentre, so the reader can look elsewhere until they type again.
//
// Two parts:
//
//   1. Equal top and bottom padding, so every line, including the first and
//      last, can reach the middle. The bottom half is the base editor's
//      `scrollPastEndHalf`; the top half is added here, for typewriter mode
//      only.
//   2. A view plugin that recentres the cursor on every document change or
//      cursor move, in an animation frame, since CodeMirror forbids dispatching
//      from inside `update`.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

// Top padding that lets the first lines rise to the middle, matching the base
// `scrollPastEndHalf` bottom padding (typst-editor.ts).
const topPad = (() => {
  const plugin = ViewPlugin.fromClass(
    class {
      height = 0;
      attrs: { style: string } = { style: "padding-top: 0px" };
      update(update: ViewUpdate) {
        const view = update.view as EditorView & {
          viewState: { editorHeight: number };
        };
        const full =
          view.viewState.editorHeight -
          view.defaultLineHeight -
          view.documentPadding.bottom -
          0.5;
        const height = Math.max(0, full * 0.5);
        if (height !== this.height) {
          this.height = height;
          this.attrs = { style: `padding-top: ${height}px` };
        }
      }
    },
  );
  return [
    plugin,
    EditorView.contentAttributes.of((view) => view.plugin(plugin)?.attrs ?? null),
  ];
})();

// Recentre on document or selection changes. Geometry and scroll updates are
// ignored, so a manual scroll isn't pulled back.
const centreCursor = ViewPlugin.fromClass(
  class {
    private frame: number | null = null;

    constructor(view: EditorView) {
      this.schedule(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.schedule(update.view);
      }
    }

    private schedule(view: EditorView) {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (!view.dom.isConnected) return;
        const head = view.state.selection.main.head;
        view.dispatch({
          effects: EditorView.scrollIntoView(head, { y: "center" }),
        });
      });
    }

    destroy() {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
    }
  },
);

/** Typewriter scrolling: pins the cursor line to the vertical centre. */
export function typewriterMode(): Extension {
  return [topPad, centreCursor];
}
