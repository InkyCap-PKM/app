// Typewriter mode: keep the line the cursor is on pinned to the vertical
// middle of the editor while the writer types, so the text scrolls up under a
// fixed caret line instead of the caret marching down the page. Manual
// scrolling (wheel, scrollbar, PageUp/Down) is left alone — only edits and
// cursor moves re-centre — so the reader can still look elsewhere and the
// scroll position only snaps back when they resume typing.
//
// Two pieces:
//   1. A symmetric top/bottom padding so *any* line — including the first and
//      last — can actually reach the centre (there has to be blank space above
//      line 1 and below the last line for them to sit mid-viewport). The
//      bottom half mirrors the base editor's `scrollPastEndHalf`; we add the
//      matching top half here, scoped to typewriter mode only.
//   2. A view plugin that re-centres the cursor on every doc change / cursor
//      move, deferred to an animation frame so it never dispatches re-entrantly
//      from inside `update` (CodeMirror forbids that).

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

// Top padding that lets the opening lines rise to the middle of the viewport.
// Mirrors the half-height reach of the base `scrollPastEndHalf` bottom padding
// (typst-editor.ts) so the centred band is symmetric top and bottom.
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

// Re-centre the caret line whenever the document or selection changes. We
// deliberately ignore pure geometry/scroll updates so a user's manual scroll
// isn't yanked back; typing or moving the cursor re-anchors to centre.
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
