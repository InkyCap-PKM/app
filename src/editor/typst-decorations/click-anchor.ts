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
// To keep the click target visually stable, this plugin captures the doc
// position under each mousedown along with that position's pre-click
// `coordsAtPos.top`. After CM applies an update that changes the visual
// decoration set, we measure the same position again and nudge scrollTop
// by the difference so the position stays at the same y. We compare the
// SAME quantity on both sides so plain-text clicks (where the line
// doesn't actually move) yield delta ≈ 0 and don't introduce drift —
// using mouse clientY here would bias every click by the offset between
// the line top and the pointer position.
//
// If the desired scrollTop would be clamped (e.g. an at-bottom widget
// collapsed and the doc shrank below where we'd want to land), we bail
// rather than partially compensate. The user sees a one-time jump on
// that click instead of accumulating residue across subsequent clicks.
export function createClickAnchorPlugin(decoField: StateField<DecorationSet>) {
  return ViewPlugin.fromClass(class {
    pending: { pos: number; oldTop: number; deadline: number } | null = null;

    constructor(view: EditorView) {
      view.scrollDOM.addEventListener("mousedown", (e) => {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        const coords = view.coordsAtPos(pos);
        if (!coords) return;
        this.pending = { pos, oldTop: coords.top, deadline: performance.now() + 250 };
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

      const { pos, oldTop } = this.pending;
      this.pending = null;
      const view = update.view;
      // Layout reads (coordsAtPos) are forbidden during the update phase.
      // Defer to CM6's measure cycle so the read happens after the DOM
      // catches up — calling coordsAtPos directly here throws "Reading
      // the editor layout isn't allowed during an update", which CM
      // surfaces as a plugin crash and disables the plugin for the
      // remainder of the session, breaking decoration refresh on
      // subsequent edits.
      const clamped = Math.min(pos, view.state.doc.length);
      view.requestMeasure({
        read(v) { return v.coordsAtPos(clamped); },
        write(coords, v) {
          if (!coords) return;
          const delta = coords.top - oldTop;
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
