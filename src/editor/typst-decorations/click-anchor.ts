import { EditorView, ViewPlugin, type ViewUpdate, type DecorationSet } from "@codemirror/view";
import { type StateField } from "@codemirror/state";
import { expandFunc } from "./effects";

// Click-anchored scroll preservation.
//
// Many visual-editor interactions reshape the document around the user's
// click: clicking an image collapses it to a pill, clicking a pill expands
// it to raw source. Each changes line heights and shifts every line below
// — and at the bottom of a document the browser also clamps scrollTop.
//
// To keep the click target visually stable, this plugin captures the
// visual line under each mousedown along with the pre-click screen height
// of that line's top edge. After CM applies an update that changes the
// visual decoration set, we measure the same line again and nudge
// scrollTop by the difference so the line stays at the same y. We compare
// the SAME quantity on both sides so a click that changes nothing about
// the layout yields delta ≈ 0 and doesn't introduce drift.
//
// The quantity must be one both states of a block agree on. Measuring
// the caret's own coordinates is not: clicking a rendered code block or
// callout maps to a document position at the widget's edge, where the
// caret sits in a zero-width placeholder at the top of the row, while in
// the block's edit state the same position sits on a line that carries
// the block's outer gap as a margin. Comparing those two heights scrolled
// the page by that difference on every click into a block, and nothing
// ever scrolled it back, so repeated clicks crawled the page upward. The
// line's margin-box top is the edge shared by both states (see
// `lineTopAt`), so a block that keeps its height measures 0. Using mouse
// clientY would likewise bias every click by the offset between the line
// top and the pointer position.
//
// If the desired scrollTop would be clamped (e.g. an at-bottom widget
// collapsed and the doc shrank below where we'd want to land), we bail
// rather than partially compensate. The user sees a one-time jump on
// that click instead of accumulating residue across subsequent clicks.

/** The `.cm-line` element that renders the visual line starting at `lineFrom`. */
function lineElementAt(view: EditorView, lineFrom: number): HTMLElement | null {
  const { node, offset } = view.domAtPos(lineFrom);
  // At a line boundary CM may answer with the content element and a child
  // index; otherwise with a node inside the line.
  const start: Node | null = node === view.contentDOM
    ? node.childNodes[offset] ?? null
    : node;
  const el = start instanceof Element ? start : start?.parentElement ?? null;
  const line = el?.closest(".cm-line") ?? null;
  return line instanceof HTMLElement ? line : null;
}

/** Screen y of the top of the margin box of the visual line at `lineFrom`,
 *  i.e. where the line's space begins. A rendered block widget keeps its
 *  outer gap inside the line, while the block's edit-state lines carry it
 *  as a margin on the line itself; taking the margin into account makes
 *  the two measure alike. */
function lineTopAt(view: EditorView, lineFrom: number): number | null {
  const line = lineElementAt(view, lineFrom);
  if (!line) return null;
  const marginTop = parseFloat(getComputedStyle(line).marginTop) || 0;
  return line.getBoundingClientRect().top - marginTop;
}

export function createClickAnchorPlugin(decoField: StateField<DecorationSet>) {
  return ViewPlugin.fromClass(class {
    pending: { lineFrom: number; oldTop: number; deadline: number } | null = null;

    constructor(view: EditorView) {
      view.scrollDOM.addEventListener("mousedown", (e) => {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        // The visual line's start is the same document position in both of
        // a block's states (a click doesn't change the document), so it is
        // what we look up again after the update. The clicked position
        // itself is not: at a rendered block's edge it may be the block's
        // end, which in the edit state belongs to the block's last line.
        const lineFrom = view.lineBlockAt(pos).from;
        const oldTop = lineTopAt(view, lineFrom);
        if (oldTop == null) return;
        this.pending = { lineFrom, oldTop, deadline: performance.now() + 250 };
      }, true);
    }

    update(update: ViewUpdate) {
      if (!this.pending) return;
      if (performance.now() > this.pending.deadline) {
        this.pending = null;
        return;
      }
      const hasExpandEffect = update.transactions.some(tr =>
        tr.effects.some((e: any) => e.is(expandFunc)),
      );
      if (hasExpandEffect) {
        this.pending = null;
        return;
      }
      const oldDecos = update.startState.field(decoField, false);
      const newDecos = update.state.field(decoField, false);
      if (oldDecos === newDecos) return;

      const { lineFrom, oldTop } = this.pending;
      this.pending = null;
      const view = update.view;
      // Layout reads are forbidden during the update phase. Defer to CM6's
      // measure cycle so the read happens after the DOM catches up —
      // reading layout directly here throws "Reading the editor layout
      // isn't allowed during an update", which CM surfaces as a plugin
      // crash and disables the plugin for the remainder of the session,
      // breaking decoration refresh on subsequent edits.
      const clamped = Math.min(lineFrom, view.state.doc.length);
      view.requestMeasure({
        read(v) { return lineTopAt(v, v.lineBlockAt(clamped).from); },
        write(newTop, v) {
          if (newTop == null) return;
          const delta = newTop - oldTop;
          if (Math.abs(delta) < 0.5) return;
          const scroller = v.scrollDOM;
          const target = scroller.scrollTop + delta;
          const max = scroller.scrollHeight - scroller.clientHeight;
          if (target < -0.5 || target > max + 0.5) return;
          scroller.scrollTop = target;
        },
      });
    }
  });
}
