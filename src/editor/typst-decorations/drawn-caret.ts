// A caret drawn by CodeMirror in place of the browser's, without CodeMirror's
// selection layer.
//
// On WebKitGTK the native caret repaints a frame or more late when the inline
// content around it changes (e.g. a list bullet shifting on Tab), so it briefly
// shows on the wrong side of the bullet. Its position is already correct, so
// JavaScript can't fix the lag; a caret CodeMirror draws follows the layout at
// once.
//
// The stock `drawSelection()` isn't used because its selection layer measures
// with `coordsAtPos`, which is unreliable on WebKitGTK for lines with
// mixed-height content (large headings, a leading pill) and can paint the whole
// row; that's why this editor draws the selection natively (see `inkycapTheme`
// in typst-editor.ts). So only the caret is drawn here.
import { EditorView, layer, RectangleMarker } from "@codemirror/view";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";

// One drawn caret per empty selection range; non-empty ranges are left to
// native `::selection`, so range geometry is never measured. Uses the base
// theme's `.cm-cursorLayer` / `.cm-cursor` classes and blink animation.
const drawnCaretLayer = layer({
  above: true,
  class: "cm-cursorLayer",
  markers(view) {
    const markers: RectangleMarker[] = [];
    for (const r of view.state.selection.ranges) {
      if (!r.empty) continue; // ranges stay native
      const className =
        r === view.state.selection.main
          ? "cm-cursor cm-cursor-primary"
          : "cm-cursor cm-cursor-secondary";
      for (const piece of RectangleMarker.forRange(view, className, EditorSelection.cursor(r.head, r.assoc))) {
        markers.push(piece);
      }
    }
    return markers;
  },
  update(update, dom) {
    // Restart the blink on every selection change (mirrors the stock layer).
    if (update.transactions.some((tr) => tr.selection)) {
      dom.style.animationName = dom.style.animationName === "cm-blink" ? "cm-blink2" : "cm-blink";
    }
    return update.docChanged || update.selectionSet;
  },
  mount(dom) {
    dom.style.animationDuration = "1200ms";
  },
});

// Hide the native caret, leaving `::selection` alone. A focused nested editable
// (verse canvas, table cell) gets its native caret back through `:focus`.
const hideNativeCaret = Prec.highest(
  EditorView.theme({
    ".cm-line": { caretColor: "transparent !important" },
    ".cm-content": {
      caretColor: "transparent !important",
      "& :focus": { caretColor: "auto !important" },
    },
    // Base theme draws the caret as `border-left: 1.2px solid black`; tint it to
    // the editor foreground (the colour the native caret used).
    ".cm-cursor": { borderLeftColor: "var(--fg-primary)" },
  }),
);

/**
 * A CodeMirror-drawn caret that avoids WebKitGTK's late caret repaint (most
 * visible as the caret jumping across a list bullet on indent), leaving native
 * selection as it is.
 */
export const drawnCaret: Extension = [drawnCaretLayer, hideNativeCaret];
