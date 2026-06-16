// A CodeMirror-drawn caret that replaces the native browser caret in the editor
// content — WITHOUT adopting CodeMirror's selection-range layer.
//
// Why: on WebKitGTK the native caret repaints a frame (or more) late when the
// inline DOM around it changes — e.g. a list item's bullet widget shifting when
// you press Tab to indent. The caret is briefly painted on the wrong side of the
// bullet before the compositor catches up. The caret's logical/DOM position is
// already correct (measured: `coordsAtPos` and the DOM selection agree at every
// frame), so this is purely a native-caret paint lag that JS can't observe or
// nudge. A caret drawn by CodeMirror is positioned by CodeMirror itself and
// tracks the layout immediately, so there is no lag.
//
// Why NOT the stock `drawSelection()`: it bundles a selection-range layer that
// measures range endpoints with `coordsAtPos`, which is unreliable on WebKitGTK
// for lines with mixed-height inline content (large headings, a leading pill
// widget) and can paint the whole row — the exact reason this editor renders
// selection natively (see `inkycapTheme` in typst-editor.ts). `drawSelection`
// also makes native `::selection` transparent. This module deliberately keeps
// only the caret and leaves the reliable native selection rendering alone.
import { EditorView, layer, RectangleMarker } from "@codemirror/view";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";

// The caret layer: one drawn caret per empty selection range. Non-empty ranges
// are left to native `::selection`, so this never measures range geometry (the
// unreliable path). Reuses the base theme's `.cm-cursorLayer` / `.cm-cursor`
// styles and blink animation by matching their class names — the same ones the
// stock cursor layer uses.
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

// Hide the native caret (we draw our own) while leaving `::selection` untouched
// so native selection ranges still render. A focused nested editable — the
// verse canvas or a table cell, both `contentEditable` — gets its own native
// caret back via `:focus`, so typing inside those widgets still shows a caret.
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

/** A CodeMirror-drawn caret that fixes the WebKitGTK native-caret repaint flash
 *  (most visible as a list bullet's caret jumping left→right on indent) while
 *  leaving native selection rendering and its WebKitGTK-safe `::selection`
 *  styling exactly as-is. */
export const drawnCaret: Extension = [drawnCaretLayer, hideNativeCaret];
