/**
 * The note editor's side of tables: entering a table with the arrow keys,
 * clipboard handling, and keeping open cell editors in step with the note. With
 * table-widget.ts, table-cell-editor.ts and table-parser.ts.
 */

import { EditorView, ViewPlugin, type DecorationSet, type ViewUpdate, keymap } from "@codemirror/view";
import { type StateField } from "@codemirror/state";
import { searchPanelOpen, setSearchQuery } from "@codemirror/search";
import {
  TableWidget,
  tableWidgetAt,
  getSelectedCellsText,
  activeCellEditors,
  closeCellEditors,
  focusTableEdge,
  refreshTableSearchMatches,
  revealCell,
  tableCellDomAt,
} from "./table-widget";
import { cellSync } from "./table-cell-editor";
import { type TableData, type TableCell, parseClipboardAsGrid, textToGrid, serializeTable } from "./table-parser";
import { inVerbatimLineContext } from "./keymaps";

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * The table wrapper with keyboard focus, if any. In navigation mode the DOM
 * selection stays wherever it was (usually the note body), and that is where
 * the browser fires copy and paste.
 */
function focusedTableWrap(view: EditorView): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (!active.classList.contains("cm-typst-table-wrap") || !view.dom.contains(active)) return null;
  return active;
}

/**
 * Copy and paste for a table in navigation mode. Listens on the document in the
 * capture phase, and stops the event so the editor doesn't handle it too.
 */
const tableFocusClipboard = ViewPlugin.fromClass(class {
  constructor(private readonly view: EditorView) {
    document.addEventListener("copy", this.onCopy, true);
    document.addEventListener("paste", this.onPaste, true);
  }

  destroy() {
    document.removeEventListener("copy", this.onCopy, true);
    document.removeEventListener("paste", this.onPaste, true);
  }

  /** Copies the selected cells as tab-separated text. */
  private onCopy = (event: ClipboardEvent) => {
    const wrap = focusedTableWrap(this.view);
    if (!wrap) return;
    const text = getSelectedCellsText(wrap);
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData?.setData("text/plain", text);
  };

  /** Pastes over the selection, growing the table downward if needed. */
  private onPaste = (event: ClipboardEvent) => {
    const wrap = focusedTableWrap(this.view);
    if (!wrap) return;
    event.preventDefault();
    event.stopPropagation();
    const widget = tableWidgetAt(this.view, wrap);
    const grid = parseClipboardAsGrid(event) ?? textToGrid(event.clipboardData?.getData("text/plain") ?? "");
    if (widget && grid) widget.pasteAtSelection(this.view, wrap, grid);
  };
});

/** Converts a grid (two or more columns) pasted into the note body into a
 *  new Typst table after the current line. */
const tableBodyPaste = EditorView.domEventHandlers({
  paste(event: ClipboardEvent, view: EditorView) {
    const target = event.target as HTMLElement;
    if (target.closest?.(".cm-typst-table-wrap")) return false;

    // Never turn a paste into a table inside code, math or verse; plain text
    // pasted into a code block must stay as is.
    if (inVerbatimLineContext(view.state, view.state.selection.main.head)) return false;

    const grid = parseClipboardAsGrid(event);
    if (!grid || grid.length === 0) return false;

    const colCount = Math.max(...grid.map(r => r.length));
    if (colCount <= 1) return false;

    event.preventDefault();

    const data: TableData = {
      columns: Array(colCount).fill("auto"),
      align: null,
      rowSizes: null,
      extraArgs: [],
      header: null,
      rows: grid.map(r => {
        const cells: TableCell[] = [];
        for (let i = 0; i < colCount; i++) {
          cells.push({ content: r[i] ?? "", relFrom: 0, relTo: 0 });
        }
        return cells;
      }),
      sourceText: "",
    };

    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    view.dispatch({
      changes: { from: line.to, insert: "\n" + serializeTable(data) + "\n" },
    });

    return true;
  },
});

const tableClipboardHandler = [tableFocusClipboard, tableBodyPaste];

// ---------------------------------------------------------------------------
// Cell editors
// ---------------------------------------------------------------------------

/**
 * Keeps open cell editors in step with the note: changes made in the note (an
 * undo, an edit elsewhere) are copied into them; changes from a cell editor
 * carry `cellSync` and are already there. Focus returning to the note closes
 * them.
 *
 * Focus must also be restored. When the note redraws the table's line it
 * removes and re-adds the table's DOM, and the browser drops focus as the cell
 * editor leaves the document. A keystroke in a cell causes such a redraw, so
 * after every update the cell editor that had focus gets it back once the DOM
 * has settled.
 */
const cellEditorSync = [
  ViewPlugin.fromClass(class {
    update(update: ViewUpdate) {
      const editors = activeCellEditors(update.view);
      if (editors.length === 0) return;
      // Keyed on the active element rather than `hasFocus`, which also asks
      // whether the window itself is focused.
      const focused = editors.find((editor) => editor.hasFocus);
      if (update.docChanged) {
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(cellSync)) continue;
          for (const editor of editors) editor.applyMainChanges(tr.changes);
        }
      }
      if (focused) {
        queueMicrotask(() => {
          const active = document.activeElement;
          if (!active || active === document.body) focused.restoreFocus();
        });
      }
    }
  }),
  EditorView.domEventHandlers({
    focus(_event, view) {
      closeCellEditors(view);
      return false;
    },
  }),
];

// ---------------------------------------------------------------------------
// Scrolling to a cell, and find/replace highlights
// ---------------------------------------------------------------------------

/**
 * Scroll a position inside a table into view by its cell. CodeMirror sees a
 * table as one widget and can only scroll to the whole table, so a find match
 * in a tall table could stay off screen. Positions in the table's own markup
 * are left to CodeMirror. As a `scrollHandler`, it works for find and replace,
 * search results and label jumps alike, honouring the request's placement and
 * the scroll margins.
 */
const tableScrollHandler = EditorView.scrollHandler.of((view, range, request) => {
  const cell = tableCellDomAt(view, range.head);
  if (!cell) return false;
  revealCell(view, cell, request);
  return true;
});

/**
 * Keeps find highlights in table cells up to date. CodeMirror's match
 * decorations land on source the reader doesn't see, so cells paint matches
 * themselves (see cell-search.ts); this tells them when to repaint: the query
 * changed, the panel opened or closed, the current match moved, or text was
 * replaced. The repaint waits a frame so any widget rebuild has finished.
 * Nothing runs while the panel is closed.
 */
const tableSearchSync = ViewPlugin.fromClass(class {
  private frame: number | null = null;

  update(update: ViewUpdate) {
    const open = searchPanelOpen(update.state);
    const wasOpen = searchPanelOpen(update.startState);
    if (!open && !wasOpen) return;
    const matchesMoved =
      open !== wasOpen ||
      update.selectionSet ||
      update.docChanged ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)));
    if (!matchesMoved || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      refreshTableSearchMatches(update.view);
    });
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }
});

// ---------------------------------------------------------------------------
// Table entry via arrow keys
// ---------------------------------------------------------------------------

/**
 * The DOM wrapper of a TableWidget next to `pos` in the given direction, if
 * any. `decoField` (the `visualField`) is passed in to avoid a circular import.
 */
export function findTableWrapNear(
  view: EditorView,
  pos: number,
  direction: "up" | "down",
  decoField: StateField<DecorationSet>,
): HTMLElement | null {
  const decos = view.state.field(decoField, false);
  if (!decos) return null;
  let tableFrom = -1;
  let tableTo = -1;
  decos.between(0, view.state.doc.length, (f, t, deco) => {
    if (!(deco.spec?.widget instanceof TableWidget)) return;
    if (direction === "up" && t <= pos && t > tableTo) {
      tableFrom = f;
      tableTo = t;
    }
    if (direction === "down" && f >= pos && (tableFrom < 0 || f < tableFrom)) {
      tableFrom = f;
      tableTo = t;
    }
  });
  if (tableFrom < 0) return null;
  const line = view.state.doc.lineAt(pos);
  const adjacentLine = direction === "up"
    ? (line.number > 1 ? view.state.doc.line(line.number - 1) : null)
    : (line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : null);
  if (!adjacentLine) return null;
  if (direction === "up" && !(tableTo > adjacentLine.from && tableFrom <= adjacentLine.to)) return null;
  if (direction === "down" && !(tableFrom <= adjacentLine.to && tableTo >= adjacentLine.from)) return null;

  const allWraps = view.dom.querySelectorAll<HTMLElement>(".cm-typst-table-wrap");
  for (const w of allWraps) {
    try {
      const p = view.posAtDOM(w);
      if (p >= tableFrom && p <= tableTo) return w;
    } catch { /* posAtDOM can throw for unmounted nodes */ }
  }
  return null;
}

/**
 * A keymap letting ArrowUp/ArrowDown enter an adjacent table. A factory, so the
 * caller can pass its decoration field without a circular import.
 */
export function createTableEntryKeymap(decoField: StateField<DecorationSet>) {
  return keymap.of([
    {
      key: "ArrowUp",
      run(view) {
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        // On a wrapped line, only enter from its first visual line.
        const headCoords = view.coordsAtPos(head);
        const lineStartCoords = view.coordsAtPos(line.from);
        if (headCoords && lineStartCoords && headCoords.top > lineStartCoords.top + 2) {
          return false;
        }
        const wrap = findTableWrapNear(view, head, "up", decoField);
        if (!wrap) return false;
        return focusTableEdge(view, wrap, "last");
      },
    },
    {
      key: "ArrowDown",
      run(view) {
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        // On a wrapped line, only enter the table when the cursor is on
        // the last visual line.
        const headCoords = view.coordsAtPos(head);
        const lineEndCoords = view.coordsAtPos(line.to);
        if (headCoords && lineEndCoords && headCoords.top < lineEndCoords.top - 2) {
          return false;
        }
        const wrap = findTableWrapNear(view, head, "down", decoField);
        if (!wrap) return false;
        return focusTableEdge(view, wrap, "first");
      },
    },
  ]);
}

export { tableClipboardHandler, cellEditorSync, tableSearchSync, tableScrollHandler };
