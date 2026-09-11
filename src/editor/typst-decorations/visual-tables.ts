/**
 * Table-related keyboard and clipboard handlers for the visual editor.
 *
 * Extracted from visual-plugin.ts to keep table interaction logic in one
 * place alongside table-widget.ts and table-parser.ts.
 */

import { EditorView, ViewPlugin, type DecorationSet, keymap } from "@codemirror/view";
import { type StateField } from "@codemirror/state";
import { TableWidget, tableWidgetAt, getSelectedCellsText } from "./table-widget";
import { type TableData, type TableCell, parseClipboardAsGrid, textToGrid, serializeTable } from "./table-parser";
import { inVerbatimLineContext } from "./keymaps";

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * The table wrapper that holds keyboard focus in `view`, if any. In
 * navigation mode the DOM selection stays wherever it last was — usually the
 * note body, sometimes outside the editor — and that, not the focused
 * element, is where the browser fires copy and paste.
 */
function focusedTableWrap(view: EditorView): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (!active.classList.contains("cm-typst-table-wrap") || !view.dom.contains(active)) return null;
  return active;
}

/**
 * Copy and paste for a table in navigation mode. Listens on the document in
 * the capture phase so the event is caught wherever the browser fires it,
 * and stops it there so the editor's own clipboard handling stays out.
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

    // Never reinterpret a paste as a table inside a verbatim region. This is
    // exactly where the cursor sits when editing a fenced code block, so
    // pasting plain text there must stay literal rather than being folded
    // into a `#table(...)` call (it would land inside the fence as garbage).
    // Math and verse are protected for the same reason.
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
// Table entry via arrow keys
// ---------------------------------------------------------------------------

/**
 * Walk the decoration set to find a TableWidget adjacent to `pos` in the
 * given direction. Returns the corresponding DOM wrapper element if found.
 *
 * The `decoField` parameter avoids a circular import — the caller passes
 * the `visualField` (or equivalent `StateField<DecorationSet>`) that owns
 * the table decorations.
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
 * Create a keymap extension that lets ArrowUp/ArrowDown enter an adjacent
 * table widget from the editor body.
 *
 * Returned as a factory so the caller can supply the decoration StateField
 * without creating a circular dependency.
 */
export function createTableEntryKeymap(decoField: StateField<DecorationSet>) {
  return keymap.of([
    {
      key: "ArrowUp",
      run(view) {
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        // On a wrapped line, only enter the table when the cursor is on
        // the first visual line — otherwise let normal cursor movement
        // navigate within the wrapped line first.
        const headCoords = view.coordsAtPos(head);
        const lineStartCoords = view.coordsAtPos(line.from);
        if (headCoords && lineStartCoords && headCoords.top > lineStartCoords.top + 2) {
          return false;
        }
        const wrap = findTableWrapNear(view, head, "up", decoField);
        if (!wrap) return false;
        wrap.focus();
        const cells = wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell");
        if (cells.length > 0) {
          cells[cells.length - 1].classList.add("cm-typst-table-cell--selected");
        }
        return true;
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
        wrap.focus();
        const cells = wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell");
        if (cells.length > 0) {
          cells[0].classList.add("cm-typst-table-cell--selected");
        }
        return true;
      },
    },
  ]);
}

export { tableClipboardHandler };
