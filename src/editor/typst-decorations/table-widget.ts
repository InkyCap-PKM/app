import { WidgetType, EditorView } from "@codemirror/view";
import { type TableData, type TableCell, serializeTable, textToGrid, tableToTsv } from "./table-parser";
import { expandFunc } from "./effects";
import {
  CellEditor,
  cellEditorConfig,
  destroyRenderedCell,
  renderIdleCell,
  sourcePosAt,
  type CellNavigation,
  type RenderedCell,
} from "./table-cell-editor";
import { compareName } from "../../lib/sort";
import { t, tPlural } from "../../lib/i18n";
import { showContextMenu, type ContextMenuEntry } from "../../lib/context-menu";

// Lucide grip glyphs for the reorder handles — crisper and less fragile than
// hand-laid dot grids. `grip-horizontal` suits the wide/short column handle,
// `grip-vertical` the narrow/tall row handle. (static-only: lucide grip-*)
const GRIP_HORIZONTAL =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="9" r="1.5"/><circle cx="12" cy="9" r="1.5"/><circle cx="19" cy="9" r="1.5"/><circle cx="5" cy="15" r="1.5"/><circle cx="12" cy="15" r="1.5"/><circle cx="19" cy="15" r="1.5"/></svg>';
/** The corner handle: a small square standing for the whole table. */
const CORNER_SQUARE =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const GRIP_VERTICAL =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>';

/** CSS absolute/relative length units that both Typst and CSS understand, so
 *  an explicit column width / row height can be applied to the preview DOM
 *  verbatim. `fr` and `auto` are content-driven and left to natural layout. */
const CSS_SHARED_LENGTH = /^\d+(?:\.\d+)?(pt|mm|cm|in|em|%|px)$/;
function asCssLength(size: string): string | null {
  return CSS_SHARED_LENGTH.test(size.trim()) ? size.trim() : null;
}

/** Typst point. CSS `pt` and Typst `pt` are both 1/72in, so the px→pt factor
 *  is the CSS px (1/96in) ratio: 1px = 0.75pt. */
function pxToTypstPt(px: number): string {
  return `${Math.round(px * 0.75 * 10) / 10}pt`;
}

/** Minimum drag size so a column/row can't be collapsed to nothing. */
const MIN_RESIZE_PX = 24;

/** The widget wrapper stashes its ResizeObserver here so `destroy` can find
 *  and disconnect it. */
type DomWithObserver = HTMLElement & { __cmTableResizeObserver?: ResizeObserver };

const EMPTY_CELL: TableCell = { content: "", relFrom: 0, relTo: 0 };

/** Element-wise equality for the nullable string arrays in `TableData`
 *  (`columns`, `align`, `rowSizes`). Two nulls are equal; a null and a
 *  present array are not. */
function arraysEqual(a: string[] | null, b: string[] | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Equality for the preserved-styling arg list (`stroke`, `inset`, …),
 *  order-sensitive on both key and verbatim value. */
function extraArgsEqual(
  a: TableData["extraArgs"],
  b: TableData["extraArgs"],
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i].key !== bb[i].key || aa[i].value !== bb[i].value) return false;
  }
  return true;
}

/**
 * Cross-rebuild focus target.
 *
 * A structural change (a row added by Tab at the end of the table, say)
 * rewrites the whole table, and the widget is rebuilt: the old DOM is torn
 * down and a fresh `toDOM` runs. The destination cell is recorded here
 * (keyed by the table's start offset) and the rebuilt widget's `toDOM`
 * consumes it, either editing that fresh cell or selecting it.
 */
let pendingCellFocus: { tableFrom: number; row: number; col: number; mode: CellFocusMode } | null = null;

/** `edit`: caret in the cell with its content selected. `select`: the cell is
 *  highlighted and the table wrapper has focus (navigation mode). */
type CellFocusMode = "edit" | "select";

/** Where the keyboard's cell cursor is in navigation mode. Shared between the
 *  mouse selection and the keyboard handler so each sees the other's moves. */
interface NavState {
  anchorRow: number;
  anchorCol: number;
  headRow: number;
  headCol: number;
}

/** An idle cell's element and what was painted into it. */
interface CellSlot {
  cellDiv: HTMLElement;
  content: string;
  rendered: RenderedCell;
}

/**
 * Everything that lives with a rendered table. The widget instance that
 * owns the DOM changes on every edit (`updateDOM` adopts the DOM for the new
 * instance), so event handlers reach the current instance through `widget`
 * rather than closing over the one that built the DOM.
 */
interface TableDom {
  widget: TableWidget;
  view: EditorView;
  wrap: HTMLElement;
  nav: NavState;
  /** Idle cells by `"row,col"`. */
  slots: Map<string, CellSlot>;
  /** The cell editor, while a cell is being edited. */
  editor: CellEditor | null;
  editorCell: { row: number; col: number } | null;
}

const domStates = new WeakMap<HTMLElement, TableDom>();

/**
 * The tables that currently host a cell editor, by start offset. While a
 * cell is being typed in, its source passes through states the table parser
 * rejects — an opening bracket before its closer, a half-typed call — and
 * the note's decorations would otherwise drop the whole table to raw source
 * mid-keystroke. The decoration builder keeps the widget in place instead
 * (see `TableWidget.unparsed`), over the range recorded here. The range's
 * end is kept as an offset from the end of the document: while a cell is
 * edited every change happens inside the table, so it stays valid even when
 * the syntax tree no longer shows where the call ends.
 */
const editingTables = new Map<number, { fromDocEnd: number }>();

function trackEditingTable(from: number, to: number, docLength: number) {
  editingTables.set(from, { fromDocEnd: docLength - to });
}

/** The range of the table being edited that starts at `from`, or null. */
export function editingTableRange(from: number, docLength: number): { from: number; to: number } | null {
  const entry = editingTables.get(from);
  return entry ? { from, to: docLength - entry.fromDocEnd } : null;
}

/** Start offsets of every table currently hosting a cell editor. */
export function editingTableStarts(): number[] {
  return [...editingTables.keys()];
}

const EMPTY_TABLE: TableData = {
  columns: [],
  align: null,
  rowSizes: null,
  extraArgs: [],
  header: null,
  rows: [],
  sourceText: "",
};

/** The cell editors open in `view`'s tables. */
export function activeCellEditors(view: EditorView): CellEditor[] {
  const editors: CellEditor[] = [];
  for (const wrap of view.dom.querySelectorAll<HTMLElement>(".cm-typst-table-wrap")) {
    const st = domStates.get(wrap);
    if (st?.editor) editors.push(st.editor);
  }
  return editors;
}

/** Close every cell editor in `view`, painting the cells idle again. */
export function closeCellEditors(view: EditorView) {
  for (const wrap of view.dom.querySelectorAll<HTMLElement>(".cm-typst-table-wrap")) {
    const st = domStates.get(wrap);
    if (st?.editor) st.widget.deactivateCell(st);
  }
}

/**
 * Forward a keyboard shortcut to the CM6 editor by refocusing it and
 * re-dispatching a synthetic KeyboardEvent. This is necessary because
 * CM6's `ignoreEvent` returns true for keydown inside widgets, so
 * modifier combos (Ctrl-Z, Ctrl-Y) never reach CM6's keymap.
 */
function forwardToEditor(view: EditorView, e: KeyboardEvent) {
  view.focus();
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
  }));
}

export class TableWidget extends WidgetType {
  /** True for a placeholder standing in for a table whose source does not
   *  parse at this instant (see `unparsed`). `data` is then empty until
   *  `updateDOM` adopts the last good data. */
  readonly unparsed: boolean;

  constructor(
    public data: TableData,
    readonly from: number,
    readonly to: number,
    unparsed = false,
  ) {
    super();
    this.unparsed = unparsed;
  }

  /** A stand-in for a table being edited whose source is momentarily
   *  unparseable. It keeps the existing DOM — and the cell editor in it —
   *  alive; the next parseable state repaints as usual. */
  static unparsed(from: number, to: number): TableWidget {
    return new TableWidget(EMPTY_TABLE, from, to, true);
  }

  get estimatedHeight(): number {
    const rowCount = this.getAllRows().length;
    // ~32px per data row + ~28px control row + 16px margin
    return rowCount * 32 + 28 + 16;
  }

  eq(other: TableWidget) {
    if (this.unparsed || other.unparsed) return false;
    if (this.from !== other.from || this.to !== other.to) return false;
    // Compare column widths element-wise, not just the count — a drag-resize
    // that changes `columns: (1fr, 2fr)` → `(1fr, 3fr)` keeps the same length
    // but must rebuild the widget, otherwise the new sizing never renders
    // until an unrelated edit forces a rebuild (stale-render bug).
    if (!arraysEqual(this.data.columns, other.data.columns)) return false;
    // Likewise for explicit row heights (`rows:` drag-resize).
    if (!arraysEqual(this.data.rowSizes, other.data.rowSizes)) return false;
    if (!arraysEqual(this.data.align, other.data.align)) return false;
    // Preserved styling args don't change the widget DOM, but they DO ride
    // through `replaceTable` on a cell edit — so a reused stale instance would
    // re-emit old styling over an external source change. Rebuild if they differ.
    if (!extraArgsEqual(this.data.extraArgs, other.data.extraArgs)) return false;
    const thisRows = this.getAllRows();
    const otherRows = other.getAllRows();
    if (thisRows.length !== otherRows.length) return false;
    for (let r = 0; r < thisRows.length; r++) {
      for (let c = 0; c < thisRows[r].length; c++) {
        if (thisRows[r][c].content !== otherRows[r][c]?.content) return false;
      }
    }
    return true;
  }

  /**
   * Adopt the existing DOM for this (newer) instance when the table's shape
   * is unchanged: cells whose content changed are repainted, the open cell
   * editor is re-anchored, and the DOM — cell editor included — survives.
   * A change of shape (rows, columns, header, sizing, styling) rebuilds.
   */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const st = domStates.get(dom);
    if (!st) return false;
    if (this.unparsed) {
      // Hold on to the last good shape and content; only the position moves.
      this.data = st.widget.data;
      this.adoptDom(st, view);
      return true;
    }
    const old = st.widget.data;
    if (
      !arraysEqual(old.columns, this.data.columns) ||
      !arraysEqual(old.rowSizes, this.data.rowSizes) ||
      !arraysEqual(old.align, this.data.align) ||
      !extraArgsEqual(old.extraArgs, this.data.extraArgs) ||
      (old.header !== null) !== (this.data.header !== null) ||
      st.widget.getAllRows().length !== this.getAllRows().length
    ) {
      return false;
    }
    this.adoptDom(st, view);
    const rows = this.getAllRows();
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (st.editorCell && st.editorCell.row === r && st.editorCell.col === c) continue;
        const slot = st.slots.get(`${r},${c}`);
        if (slot && slot.content !== rows[r][c].content) this.paintIdle(st, r, c);
      }
    }
    if (st.editor && st.editorCell) {
      const range = this.cellRange(st, st.editorCell.row, st.editorCell.col);
      if (range) st.editor.setRange(range);
    }
    return true;
  }

  /** Make this instance the one the rendered table acts through. */
  private adoptDom(st: TableDom, view: EditorView) {
    if (st.editor) {
      if (st.widget.from !== this.from) editingTables.delete(st.widget.from);
      trackEditingTable(this.from, this.to, view.state.doc.length);
    }
    st.widget = this;
    st.view = view;
  }

  toDOM(view: EditorView) {
    if (this.unparsed) {
      // No rendered table to keep: show the source until it parses again.
      const raw = document.createElement("span");
      raw.className = "cm-typst-table-unparsed";
      raw.textContent = view.state.sliceDoc(this.from, this.to);
      return raw;
    }
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-table-wrap";
    wrap.tabIndex = 0;

    const st: TableDom = {
      widget: this,
      view,
      wrap,
      nav: { anchorRow: 0, anchorCol: 0, headRow: 0, headCol: 0 },
      slots: new Map(),
      editor: null,
      editorCell: null,
    };
    domStates.set(wrap, st);

    const colCount = this.data.columns.length;

    const table = document.createElement("table");
    table.className = "cm-typst-table";

    // ── Column-width carrier ──
    // A <colgroup> lets explicit column widths (the `columns:` lengths the
    // user sets by dragging) drive the preview without per-cell styling.
    // The first <col> spans the row-handle gutter; the rest map 1:1 to data
    // columns. `auto`/`fr` columns are left content-driven.
    const colgroup = document.createElement("colgroup");
    const gutterCol = document.createElement("col");
    gutterCol.className = "cm-table-gutter-col";
    colgroup.appendChild(gutterCol);
    for (let c = 0; c < colCount; c++) {
      const col = document.createElement("col");
      const css = asCssLength(this.data.columns[c]);
      if (css) col.style.width = css;
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    // ── Control row (column reorder handles) ──
    const controlRow = document.createElement("tr");
    controlRow.className = "cm-table-control-row";

    // The corner stands for the whole table: click selects every cell,
    // right-click opens the table menu — the same click/right-click split
    // the row and column handles have.
    const cornerCell = document.createElement("td");
    cornerCell.className = "cm-table-corner-cell";
    const corner = document.createElement("div");
    corner.className = "cm-table-corner-handle";
    corner.innerHTML = `<span class="cm-table-handle-grip">${CORNER_SQUARE}</span>`;
    corner.title = t("table.handle.table");
    corner.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      e.preventDefault();
      st.widget.selectAllCells(st);
    });
    corner.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      st.widget.showTableMenu(st, e);
    });
    cornerCell.appendChild(corner);
    controlRow.appendChild(cornerCell);

    for (let c = 0; c < colCount; c++) {
      const td = document.createElement("td");
      td.className = "cm-table-col-header-cell";
      td.dataset.col = String(c);

      const handle = document.createElement("div");
      handle.className = "cm-table-col-handle";
      handle.innerHTML = `<span class="cm-table-handle-grip">${GRIP_HORIZONTAL}</span>`;
      handle.title = t("table.handle.reorder");
      const colIdx = c;

      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.button === 0) {
          e.preventDefault();
          st.widget.startPointerDrag(st, table, "col", colIdx, handle, e);
        }
      });
      handle.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        st.widget.showColumnMenu(st, colIdx, e);
      });
      td.appendChild(handle);

      controlRow.appendChild(td);
    }
    table.appendChild(controlRow);

    // ── Build data rows (header + body) ──
    const allLogicalRows = this.getAllRows();

    for (let r = 0; r < allLogicalRows.length; r++) {
      const isHeader = this.data.header !== null && r === 0;
      const tr = document.createElement("tr");
      tr.dataset.logicalRow = String(r);

      // Apply an explicit row height (set by dragging a row edge) to the
      // preview. `auto` rows fit their content naturally.
      const rowCss = this.data.rowSizes ? asCssLength(this.data.rowSizes[r] ?? "auto") : null;
      if (rowCss) tr.style.height = rowCss;

      const handleCell = document.createElement("td");
      handleCell.className = "cm-table-row-handle-cell";

      const handle = document.createElement("div");
      handle.className = "cm-table-row-handle";
      handle.innerHTML = `<span class="cm-table-handle-grip">${GRIP_VERTICAL}</span>`;
      handle.title = t("table.handle.reorder");
      const rowIdx = r;

      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.button === 0) {
          e.preventDefault();
          st.widget.startPointerDrag(st, table, "row", rowIdx, handle, e);
        }
      });
      handle.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        st.widget.showRowMenu(st, rowIdx, e);
      });
      handleCell.appendChild(handle);

      tr.appendChild(handleCell);

      for (let c = 0; c < allLogicalRows[r].length; c++) {
        const cellEl = document.createElement(isHeader ? "th" : "td");
        cellEl.dataset.col = String(c);
        const cellDiv = document.createElement("div");
        cellDiv.className = "cm-typst-table-cell";
        cellEl.appendChild(cellDiv);
        st.slots.set(`${r},${c}`, { cellDiv, content: "", rendered: { widgets: [] } });
        this.paintIdle(st, r, c);
        if (this.data.align && this.data.align[c]) {
          cellEl.style.textAlign = this.data.align[c];
        }
        const cellColIdx = c;
        const cellRowIdx = r;
        cellEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          st.widget.showCellMenu(st, cellRowIdx, cellColIdx, cellEl, e);
        });
        tr.appendChild(cellEl);
      }

      table.appendChild(tr);
    }

    wrap.appendChild(table);

    this.setupCellSelection(st);
    this.setupTableNavigation(st);
    this.setupResize(st, table, colCount);

    // If a structural change triggered this rebuild (see `pendingCellFocus`),
    // land on the intended destination cell once the DOM is mounted.
    if (pendingCellFocus && pendingCellFocus.tableFrom === this.from) {
      const { row, col, mode } = pendingCellFocus;
      pendingCellFocus = null;
      queueMicrotask(() => {
        if (document.body.contains(wrap)) st.widget.landOnCell(st, row, col, mode);
      });
    }

    return wrap;
  }

  destroy(dom: HTMLElement) {
    // Tear down the ResizeObserver that keeps resize handles aligned, so it
    // doesn't outlive the widget DOM.
    const ro = (dom as DomWithObserver).__cmTableResizeObserver;
    if (ro) {
      ro.disconnect();
      delete (dom as DomWithObserver).__cmTableResizeObserver;
    }
    const st = domStates.get(dom);
    if (!st) return;
    domStates.delete(dom);
    for (const slot of st.slots.values()) destroyRenderedCell(slot.rendered);
    const editor = st.editor;
    const at = st.editorCell;
    st.editor = null;
    st.editorCell = null;
    if (!editor || !at) return;
    editingTables.delete(st.widget.from);
    // A rebuild while a cell was being edited (an undo that removed a row,
    // a menu action) would otherwise leave nothing focused. Unless the
    // trigger already chose a destination, land on the same cell — or the
    // nearest one still there — in navigation mode.
    if (!pendingCellFocus) pendingCellFocus = { tableFrom: st.widget.from, row: at.row, col: at.col, mode: "select" };
    // The rebuild may have been triggered from inside the cell editor's own
    // key handler; let that unwind before the editor goes away.
    queueMicrotask(() => editor.destroy());
  }

  /** Everything inside the table is the table's own business, the nested
   *  cell editor included; the note's editor must not act on it. */
  ignoreEvent() {
    return true;
  }

  // ────────────────────────────────────────────────────────
  // Edge-drag resize (column width / row height)
  // ────────────────────────────────────────────────────────

  /**
   * Build the draggable column boundaries that let the user set a column's
   * width. Handles live in an overlay pinned over the table; a
   * ResizeObserver keeps them aligned as the table reflows. Columns are
   * content-fit (`auto`) by default — dragging writes an explicit length
   * into the `columns:` argument, and double-clicking a handle clears the
   * override back to `auto`. Row heights are left to the content: Typst
   * treats a length in `rows:` as an exact track size, so a height chosen
   * against the editor's fonts would clip or overflow in the compiled note.
   */
  private setupResize(st: TableDom, table: HTMLTableElement, colCount: number) {
    const { wrap } = st;
    const overlay = document.createElement("div");
    overlay.className = "cm-table-resize-overlay";
    wrap.appendChild(overlay);

    const colHandles: HTMLElement[] = [];

    for (let c = 0; c < colCount; c++) {
      const h = document.createElement("div");
      h.className = "cm-table-resize-handle cm-table-resize-handle--col";
      h.title = t("table.handle.resize_column");
      this.bindColumnResize(st, table, h, c);
      overlay.appendChild(h);
      colHandles.push(h);
    }

    const layout = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const top = tableRect.top - wrapRect.top;
      const height = tableRect.height;

      for (let c = 0; c < colHandles.length; c++) {
        const cell = wrap.querySelector<HTMLElement>(`tr[data-logical-row] [data-col="${c}"]`);
        if (!cell) continue;
        const x = cell.getBoundingClientRect().right - wrapRect.left;
        const h = colHandles[c];
        h.style.left = `${x}px`;
        h.style.top = `${top}px`;
        h.style.height = `${height}px`;
      }
    };

    const ro = new ResizeObserver(() => layout());
    ro.observe(table);
    (wrap as DomWithObserver).__cmTableResizeObserver = ro;
    requestAnimationFrame(layout);
  }

  private bindColumnResize(st: TableDom, table: HTMLTableElement, handle: HTMLElement, colIdx: number) {
    const { wrap } = st;
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      st.widget.setColumnSize(st.view, colIdx, "auto");
    });
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const cell = wrap.querySelector<HTMLElement>(`tr[data-logical-row] [data-col="${colIdx}"]`);
      if (!cell) return;
      const col = table.querySelectorAll<HTMLElement>("colgroup col")[colIdx + 1];
      const startX = e.clientX;
      const startWidth = cell.getBoundingClientRect().width;
      let width = startWidth;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("cm-table-resize-handle--active");

      // Make the in-progress resize unmistakable: tint the affected column,
      // lock the body cursor, and suppress stray text selection.
      const tinted = wrap.querySelectorAll<HTMLElement>(`tr[data-logical-row] [data-col="${colIdx}"]`);
      tinted.forEach((c) => c.classList.add("cm-table-cell--resizing"));
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        width = Math.max(MIN_RESIZE_PX, startWidth + (ev.clientX - startX));
        if (col) col.style.width = `${width}px`;
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        handle.classList.remove("cm-table-resize-handle--active");
        tinted.forEach((c) => c.classList.remove("cm-table-cell--resizing"));
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        st.widget.setColumnSize(st.view, colIdx, pxToTypstPt(width));
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  // ────────────────────────────────────────────────────────
  // Pointer-based drag reorder
  // ────────────────────────────────────────────────────────

  private startPointerDrag(
    st: TableDom,
    table: HTMLTableElement,
    dragType: "col" | "row",
    fromIdx: number,
    handle: HTMLElement,
    startEvent: PointerEvent,
  ) {
    const { wrap } = st;
    const DRAG_THRESHOLD = 4;
    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    let dragging = false;
    let lastTarget = -1;

    handle.setPointerCapture(startEvent.pointerId);

    // Highlight the source column/row immediately on pointerdown
    if (dragType === "col") {
      this.selectColumn(wrap, fromIdx);
    } else {
      this.selectRow(wrap, fromIdx);
    }

    const clearDropIndicator = () => {
      table.querySelectorAll(".cm-table-drop-before, .cm-table-drop-after").forEach((el) => {
        el.classList.remove("cm-table-drop-before", "cm-table-drop-after");
      });
    };

    const highlightTarget = (e: PointerEvent) => {
      clearDropIndicator();
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el || !wrap.contains(el)) { lastTarget = -1; return; }

      if (dragType === "col") {
        const td = el.closest<HTMLElement>("td, th");
        const colStr = td?.dataset.col;
        if (colStr !== undefined) {
          lastTarget = parseInt(colStr, 10);
          if (lastTarget !== fromIdx) {
            const side = lastTarget < fromIdx ? "cm-table-drop-before" : "cm-table-drop-after";
            table.querySelectorAll<HTMLElement>(`[data-col="${colStr}"]`).forEach((c) =>
              c.classList.add(side),
            );
          }
        } else {
          lastTarget = -1;
        }
      } else {
        const tr = el.closest<HTMLElement>("tr[data-logical-row]");
        if (tr?.dataset.logicalRow !== undefined) {
          lastTarget = parseInt(tr.dataset.logicalRow, 10);
          if (lastTarget !== fromIdx) {
            const side = lastTarget < fromIdx ? "cm-table-drop-before" : "cm-table-drop-after";
            tr.classList.add(side);
          }
        } else {
          lastTarget = -1;
        }
      }
    };

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        handle.classList.add("cm-table-handle--dragging");
      }
      highlightTarget(e);
    };

    const onUp = (_e: PointerEvent) => {
      handle.releasePointerCapture(startEvent.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.classList.remove("cm-table-handle--dragging");
      clearDropIndicator();

      if (dragging && lastTarget >= 0 && lastTarget !== fromIdx) {
        if (dragType === "col") {
          st.widget.moveColumn(st.view, fromIdx, lastTarget);
        } else {
          st.widget.moveRow(st.view, fromIdx, lastTarget);
        }
      }
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // ────────────────────────────────────────────────────────
  // Cells: idle paint and the cell editor
  // ────────────────────────────────────────────────────────

  /** Source range of the content inside the cell's brackets. */
  private cellRange(st: TableDom, row: number, col: number): { from: number; to: number } | null {
    const cell = this.getAllRows()[row]?.[col];
    if (!cell) return null;
    const { from } = this.liveRange(st.view);
    return { from: from + cell.relFrom + 1, to: from + cell.relTo - 1 };
  }

  /** Paint a cell as it reads in the visual editor, from the note's state. */
  private paintIdle(st: TableDom, row: number, col: number) {
    const slot = st.slots.get(`${row},${col}`);
    const range = this.cellRange(st, row, col);
    if (!slot || !range) return;
    destroyRenderedCell(slot.rendered);
    slot.content = this.getAllRows()[row][col].content;
    slot.rendered = renderIdleCell(st.view, slot.cellDiv, range.from, range.to, st.view.state.facet(cellEditorConfig));
  }

  /**
   * Open the cell editor in a cell. `caret` places the caret; `replaceWith`
   * types over the whole content, as typing on a selected cell does. Without
   * an editor config the cell is selected instead.
   */
  private activateCell(st: TableDom, row: number, col: number, caret: "end" | "all" | number, replaceWith?: string) {
    const config = st.view.state.facet(cellEditorConfig);
    const slot = st.slots.get(`${row},${col}`);
    const range = this.cellRange(st, row, col);
    if (!slot || !range) return;
    if (!config) {
      this.landOnCell(st, row, col, "select");
      return;
    }
    if (st.editorCell && (st.editorCell.row !== row || st.editorCell.col !== col)) this.deactivateCell(st);
    clearCellSelection(st.wrap);
    clearHandleSelection(st.wrap);
    this.parkNoteCaret(st);
    if (!st.editor) {
      destroyRenderedCell(slot.rendered);
      slot.cellDiv.replaceChildren();
      slot.cellDiv.classList.add("cm-typst-table-cell--editing");
      st.editor = new CellEditor(st.view, slot.cellDiv, range, this.navigationFor(st), config);
      st.editorCell = { row, col };
      const live = this.liveRange(st.view);
      trackEditingTable(live.from, live.to, st.view.state.doc.length);
    }
    if (replaceWith !== undefined) {
      st.editor.replaceContent(replaceWith);
      st.editor.view.focus();
    } else {
      st.editor.focus(caret);
    }
  }

  /**
   * Move the note's own caret to the end of the table unless it is already
   * at the table. The note's editor keeps a caret of its own while a cell
   * is edited, and undo and redo scroll that caret into view — left where
   * it was before the click, often the top of the note, an undo inside a
   * cell would jump the page there.
   */
  private parkNoteCaret(st: TableDom) {
    const { from, to } = this.liveRange(st.view);
    const { anchor, head } = st.view.state.selection.main;
    if (anchor >= from && anchor <= to && head >= from && head <= to) return;
    st.view.dispatch({ selection: { anchor: to } });
  }

  /** Close the cell editor and paint its cell idle again. */
  deactivateCell(st: TableDom) {
    const editor = st.editor;
    const at = st.editorCell;
    st.editor = null;
    st.editorCell = null;
    if (!editor || !at) return;
    editingTables.delete(st.widget.from);
    editor.destroy();
    const slot = st.slots.get(`${at.row},${at.col}`);
    if (slot) {
      slot.cellDiv.classList.remove("cm-typst-table-cell--editing");
      slot.cellDiv.replaceChildren();
      this.paintIdle(st, at.row, at.col);
    }
  }

  /** Land on a cell: edit it, or select it in navigation mode. A position
   *  past the grid (the row was just removed) lands on the nearest cell. */
  private landOnCell(st: TableDom, row: number, col: number, mode: CellFocusMode) {
    const { rows, cols } = this.gridSize(st.wrap);
    if (rows === 0 || cols === 0) return;
    row = Math.min(row, rows - 1);
    col = Math.min(col, cols - 1);
    if (mode === "edit" && st.view.state.facet(cellEditorConfig)) {
      this.activateCell(st, row, col, "all");
      return;
    }
    this.deactivateCell(st);
    const target = getCellAt(st.wrap, row, col);
    if (!target) return;
    clearCellSelection(st.wrap);
    target.classList.add("cm-typst-table-cell--selected");
    st.nav.anchorRow = st.nav.headRow = row;
    st.nav.anchorCol = st.nav.headCol = col;
    st.wrap.focus({ preventScroll: true });
  }

  /** What the cell editor does when a key leaves the cell. */
  private navigationFor(st: TableDom): CellNavigation {
    const here = () => st.editorCell ?? { row: 0, col: 0 };
    return {
      tab: (shift) => {
        const { row, col } = here();
        const { rows, cols } = this.gridSize(st.wrap);
        if (shift) {
          let r = row, c = col - 1;
          if (c < 0) { c = cols - 1; r--; }
          if (r < 0) st.widget.exitToEditor(st, "before");
          else st.widget.activateCell(st, r, c, "all");
        } else {
          let r = row, c = col + 1;
          if (c >= cols) { c = 0; r++; }
          if (r >= rows) st.widget.appendRowAndEdit(st);
          else st.widget.activateCell(st, r, c, "all");
        }
      },
      enter: () => {
        const { row, col } = here();
        if (row + 1 >= this.gridSize(st.wrap).rows) st.widget.appendRowAndEdit(st);
        else st.widget.activateCell(st, row + 1, col, "all");
      },
      escape: () => {
        const { row, col } = here();
        st.widget.landOnCell(st, row, col, "select");
      },
      arrow: (direction) => {
        const { row, col } = here();
        const next = direction === "up" ? row - 1 : row + 1;
        if (next < 0 || next >= this.gridSize(st.wrap).rows) st.widget.exitToEditor(st, next < 0 ? "before" : "after");
        else st.widget.activateCell(st, next, col, "end");
      },
      pasteGrid: (grid) => {
        const { row, col } = here();
        st.widget.deactivateCell(st);
        st.widget.fillCellsFromGrid(st.view, row, col, grid);
      },
    };
  }

  /** Current rendered grid dimensions (logical rows × data columns). */
  private gridSize(wrap: HTMLElement): { rows: number; cols: number } {
    const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
    const cols = allRows[0]?.querySelectorAll("th, td:not(.cm-table-row-handle-cell)").length ?? 0;
    return { rows: allRows.length, cols };
  }

  /** Logical (row, col) of the data cell containing `cellOrTd`. */
  private cellPosition(wrap: HTMLElement, cellOrTd: HTMLElement): { row: number; col: number } {
    const td = cellOrTd.closest<HTMLElement>("td, th")!;
    const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
    const tr = td.closest<HTMLElement>("tr[data-logical-row]")!;
    const row = allRows.indexOf(tr);
    const dataCells = Array.from(tr.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));
    return { row, col: dataCells.indexOf(td) };
  }

  /**
   * Append a fresh row and edit its first cell — Tab or Enter ran off the
   * end of the table. The rewrite rebuilds the widget; `pendingCellFocus`
   * carries the destination across.
   */
  private appendRowAndEdit(st: TableDom) {
    const allRows = this.getAllRows();
    allRows.push(this.data.columns.map(() => ({ ...EMPTY_CELL })));
    const rs = this.currentRowSizes();
    if (rs) rs.push("auto");
    pendingCellFocus = { tableFrom: this.liveRange(st.view).from, row: allRows.length - 1, col: 0, mode: "edit" };
    this.replaceTable(st.view, this.rebuildFromAllRows(allRows, this.data.header !== null, rs));
  }

  /** Leave the table for the line before or after it. */
  private exitToEditor(st: TableDom, direction: "before" | "after") {
    this.deactivateCell(st);
    const { view } = st;
    const live = this.liveRange(view);
    const pos = direction === "before" ? live.from : live.to;
    const line = view.state.doc.lineAt(pos);
    const target = direction === "before"
      ? (line.number > 1 ? view.state.doc.line(line.number - 1).from : 0)
      : (line.to < view.state.doc.length ? view.state.doc.lineAt(Math.min(line.to + 1, view.state.doc.length)).from : view.state.doc.length);
    view.dispatch({ selection: { anchor: target } });
    view.focus();
  }

  // ────────────────────────────────────────────────────────
  // Cell selection (navigation mode)
  // ────────────────────────────────────────────────────────

  private setupCellSelection(st: TableDom) {
    const { wrap, nav } = st;
    let selecting = false;
    let startCell: HTMLElement | null = null;

    wrap.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      const cell = target.closest<HTMLElement>(".cm-typst-table-cell");
      if (!cell) return;
      // A click inside the open cell editor is the editor's to handle.
      if (st.editorCell && cell === getCellAt(wrap, st.editorCell.row, st.editorCell.col)) return;

      if (e.button === 2) {
        // Right-click: keep focus where it is so the browser does not start
        // editing the cell (which would drop the selection the menu acts on).
        // An unselected cell becomes the selection, as in a spreadsheet.
        e.preventDefault();
        if (!cell.classList.contains("cm-typst-table-cell--selected")) {
          clearCellSelection(wrap);
          clearHandleSelection(wrap);
          cell.classList.add("cm-typst-table-cell--selected");
          const { row, col } = this.cellPosition(wrap, cell);
          nav.anchorRow = nav.headRow = row;
          nav.anchorCol = nav.headCol = col;
        }
        wrap.focus({ preventScroll: true });
        return;
      }
      if (e.button !== 0) return;

      e.preventDefault();
      const { row, col } = this.cellPosition(wrap, cell);
      // A click on the one selected cell starts editing it, at the point
      // clicked, as a second click in a spreadsheet does.
      const selectedCells = wrap.querySelectorAll(".cm-typst-table-cell--selected");
      if (!e.shiftKey && selectedCells.length === 1 && selectedCells[0] === cell) {
        st.widget.activateCell(st, row, col, sourcePosAt(cell, e.clientX, e.clientY) ?? "end");
        return;
      }
      st.widget.deactivateCell(st);
      selecting = true;
      startCell = cell;
      clearCellSelection(wrap);
      clearHandleSelection(wrap);
      cell.classList.add("cm-typst-table-cell--selected");
      nav.anchorRow = nav.headRow = row;
      nav.anchorCol = nav.headCol = col;
    });

    wrap.addEventListener("mousemove", (e) => {
      if (!selecting || !startCell) return;
      e.preventDefault();
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!target) return;
      const cell = target.closest<HTMLElement>(".cm-typst-table-cell");
      if (!cell || !wrap.contains(cell)) return;

      clearCellSelection(wrap);
      selectCellRange(wrap, startCell, cell);
      const { row, col } = this.cellPosition(wrap, cell);
      nav.headRow = row;
      nav.headCol = col;
    });

    // Focus moving to the note body (or anywhere else outside the table)
    // ends editing and drops the selection highlight, which would otherwise
    // linger as a stale selection. A context menu opened on the selection
    // still needs it, so focus going there keeps everything. Focus going
    // nowhere in particular (a click on a popup that takes no focus) is not
    // a departure.
    wrap.addEventListener("focusout", (e) => {
      const next = e.relatedTarget;
      if (!(next instanceof Element)) return;
      if (wrap.contains(next) || next.closest(".context-menu")) return;
      st.widget.deactivateCell(st);
      clearCellSelection(wrap);
      clearHandleSelection(wrap);
    });

    wrap.addEventListener("mouseup", () => {
      if (selecting) {
        selecting = false;
        const selected = wrap.querySelectorAll(".cm-typst-table-cell--selected");
        if (selected.length > 0) {
          wrap.focus();
        }
      }
    });

    wrap.addEventListener("dblclick", (e) => {
      const target = e.target as HTMLElement;
      const cell = target.closest<HTMLElement>(".cm-typst-table-cell");
      if (!cell) return;
      if (st.editorCell && cell === getCellAt(wrap, st.editorCell.row, st.editorCell.col)) return;
      e.preventDefault();
      const { row, col } = this.cellPosition(wrap, cell);
      st.widget.activateCell(st, row, col, sourcePosAt(cell, e.clientX, e.clientY) ?? "end");
    });
  }

  // ────────────────────────────────────────────────────────
  // Table-level keyboard navigation (when wrap has focus)
  // ────────────────────────────────────────────────────────

  private setupTableNavigation(st: TableDom) {
    const { wrap, nav } = st;
    wrap.addEventListener("keydown", (e) => {
      // A key handled by the cell editor still bubbles up here, and may have
      // moved focus onto the wrapper on its way (Escape does): it is not a
      // navigation-mode key.
      if (e.target instanceof Element && e.target.closest(".cm-typst-cell-editor")) return;
      if (document.activeElement !== wrap) return;
      const view = st.view;

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        // The modifier's own keydown arrives before the letter; forwarding it
        // would move focus to the note body before the shortcut completes.
        if (e.key === "Control" || e.key === "Meta" || e.key === "Shift" || e.key === "Alt") return;
        // Native copy/paste — routed back to this table by visual-tables.ts.
        if (e.key === "c" || e.key === "v") return;
        if (e.key === "a") {
          e.preventDefault();
          e.stopPropagation();
          wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell").forEach(c =>
            c.classList.add("cm-typst-table-cell--selected"),
          );
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        forwardToEditor(view, e);
        return;
      }

      const selected = wrap.querySelector<HTMLElement>(".cm-typst-table-cell--selected");
      const selectedAt = selected ? this.cellPosition(wrap, selected) : null;

      // A selection made by Tab or by entering the table from the note body
      // does not pass through this handler, so re-anchor the keyboard cursor
      // on it before moving.
      if (selected) {
        const headCell = getCellAt(wrap, nav.headRow, nav.headCol);
        if (!headCell?.classList.contains("cm-typst-table-cell--selected")) {
          const { row, col } = this.cellPosition(wrap, selected);
          nav.anchorRow = nav.headRow = row;
          nav.anchorCol = nav.headCol = col;
        }
      }

      if (e.key === "F2" || e.key === "Enter") {
        if (selectedAt) {
          e.preventDefault();
          e.stopPropagation();
          st.widget.activateCell(st, selectedAt.row, selectedAt.col, "all");
        }
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();

        const table = wrap.querySelector("table")!;
        const allRows = Array.from(table.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
        const rowCount = allRows.length;
        const colCount = allRows[0]?.querySelectorAll("th, td:not(.cm-table-row-handle-cell)").length ?? 0;

        if (!selected) {
          nav.anchorRow = nav.anchorCol = nav.headRow = nav.headCol = 0;
          const first = getCellAt(wrap, 0, 0);
          if (first) {
            clearCellSelection(wrap);
            first.classList.add("cm-typst-table-cell--selected");
          }
          return;
        }

        let newRow = nav.headRow;
        let newCol = nav.headCol;
        if (e.key === "ArrowDown") newRow++;
        if (e.key === "ArrowUp") newRow--;
        if (e.key === "ArrowRight") newCol++;
        if (e.key === "ArrowLeft") newCol--;

        if (newRow < 0 || newRow >= rowCount) {
          st.widget.exitToEditor(st, newRow < 0 ? "before" : "after");
          return;
        }
        if (newCol < 0 || newCol >= colCount) return;

        nav.headRow = newRow;
        nav.headCol = newCol;

        if (e.shiftKey) {
          clearCellSelection(wrap);
          const a = getCellAt(wrap, nav.anchorRow, nav.anchorCol);
          const h = getCellAt(wrap, nav.headRow, nav.headCol);
          if (a && h) selectCellRange(wrap, a, h);
        } else {
          nav.anchorRow = nav.headRow;
          nav.anchorCol = nav.headCol;
          clearCellSelection(wrap);
          const cell = getCellAt(wrap, nav.headRow, nav.headCol);
          if (cell) cell.classList.add("cm-typst-table-cell--selected");
        }
        return;
      }

      if (e.key === "Tab") {
        if (selected) {
          e.preventDefault();
          e.stopPropagation();
          const cells = Array.from(wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell"));
          const idx = cells.indexOf(selected);
          const nextIdx = e.shiftKey ? idx - 1 : idx + 1;
          if (nextIdx >= 0 && nextIdx < cells.length) {
            clearCellSelection(wrap);
            cells[nextIdx].classList.add("cm-typst-table-cell--selected");
          }
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        const selectedCells = wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell--selected");
        if (selectedCells.length > 0) {
          const positions = new Set<string>();
          const table = wrap.querySelector("table")!;
          const allDomRows = Array.from(table.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
          for (const cell of selectedCells) {
            const td = cell.closest<HTMLElement>("td, th");
            const row = td?.closest<HTMLElement>("tr[data-logical-row]");
            if (!td || !row) continue;
            const r = allDomRows.indexOf(row);
            const cols = Array.from(row.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));
            const c = cols.indexOf(td);
            positions.add(`${r},${c}`);
          }
          const allRows = st.widget.getAllRows();
          for (const key of positions) {
            const [r, c] = key.split(",").map(Number);
            if (allRows[r]?.[c]) {
              allRows[r][c] = { content: "", relFrom: 0, relTo: 0 };
            }
          }
          st.widget.replaceTable(view, st.widget.rebuildFromAllRows(allRows, st.widget.data.header !== null));
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        clearCellSelection(wrap);
        clearHandleSelection(wrap);
        view.focus();
        return;
      }

      // Any printable character: edit the cell, typing over its content.
      if (selectedAt && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        st.widget.activateCell(st, selectedAt.row, selectedAt.col, "end", e.key);
        return;
      }
    });
  }

  // ────────────────────────────────────────────────────────
  // Clipboard (paste into the selection)
  // ────────────────────────────────────────────────────────

  /**
   * Paste a grid over the cells starting at the selection anchor, growing the
   * table downward if needed. Copy and paste events never reach the table
   * wrapper in navigation mode (the DOM selection stays in the note body), so
   * the editor-level handler in `visual-tables.ts` routes them here.
   */
  pasteAtSelection(view: EditorView, wrap: HTMLElement, grid: string[][]) {
    const anchor = getSelectionAnchor(wrap);
    if (!anchor) return;
    this.fillCellsFromGrid(view, anchor.row, anchor.col, grid);
  }

  private fillCellsFromGrid(view: EditorView, startRow: number, startCol: number, grid: string[][]) {
    const allRows = this.getAllRows();
    const colCount = this.data.columns.length;

    const neededRows = startRow + grid.length;
    while (allRows.length < neededRows) {
      allRows.push(this.data.columns.map(() => ({ ...EMPTY_CELL })));
    }

    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length && startCol + c < colCount; c++) {
        allRows[startRow + r][startCol + c] = { content: grid[r][c], relFrom: 0, relTo: 0 };
      }
    }

    const rs = this.currentRowSizes();
    if (rs) { while (rs.length < allRows.length) rs.push("auto"); }
    this.replaceTable(view, this.rebuildFromAllRows(allRows, this.data.header !== null, rs));
  }

  // ────────────────────────────────────────────────────────
  // Context menus
  // ────────────────────────────────────────────────────────

  private showCellMenu(st: TableDom, rowIdx: number, colIdx: number, anchor: HTMLElement, e: MouseEvent) {
    const { wrap } = st;
    const view = st.view;
    const hasSelection = wrap.querySelectorAll(".cm-typst-table-cell--selected").length > 0;
    const selRows = getSelectedRowIndices(wrap);
    const selCols = getSelectedColIndices(wrap);
    const multiRow = selRows.length > 1;
    const multiCol = selCols.length > 1;

    const entries: ContextMenuEntry[] = [
      {
        label: t("common.copy"),
        run: () => {
          if (!hasSelection) {
            clearCellSelection(wrap);
            const cell = anchor.querySelector<HTMLElement>(".cm-typst-table-cell");
            if (cell) cell.classList.add("cm-typst-table-cell--selected");
          }
          navigator.clipboard.writeText(getSelectedCellsText(wrap));
        },
      },
      {
        label: t("common.paste"),
        run: () => {
          navigator.clipboard.readText().then((text) => {
            const grid = textToGrid(text);
            if (!grid) return;
            const start = getSelectionAnchor(wrap) ?? { row: rowIdx, col: colIdx };
            st.widget.fillCellsFromGrid(view, start.row, start.col, grid);
          });
        },
      },
      "separator",
      { label: t("table.menu.insert_row_above"), run: () => st.widget.insertRow(view, rowIdx) },
      { label: t("table.menu.insert_row_below"), run: () => st.widget.insertRow(view, multiRow ? selRows[selRows.length - 1] + 1 : rowIdx + 1) },
      { label: t("table.menu.insert_column_before"), run: () => st.widget.insertColumn(view, colIdx) },
      { label: t("table.menu.insert_column_after"), run: () => st.widget.insertColumn(view, multiCol ? selCols[selCols.length - 1] + 1 : colIdx + 1) },
      "separator",
      {
        label: tPlural("table.menu.delete_rows", multiRow ? selRows.length : 1),
        run: () => multiRow ? st.widget.deleteRows(view, selRows) : this.deleteRow(view, rowIdx),
        danger: true,
      },
      {
        label: tPlural("table.menu.delete_columns", multiCol ? selCols.length : 1),
        run: () => multiCol ? st.widget.deleteColumns(view, selCols) : this.deleteColumn(view, colIdx),
        danger: true,
      },
    ];
    showContextMenu(e.clientX, e.clientY, entries);
  }

  private showColumnMenu(st: TableDom, colIdx: number, e: MouseEvent) {
    const { wrap, view } = st;
    const selCols = getSelectedColIndices(wrap);
    const multi = selCols.length > 1 && selCols.includes(colIdx);

    const entries: ContextMenuEntry[] = [
      { label: t("table.menu.sort_asc"), run: () => st.widget.sortColumn(view, colIdx, "asc") },
      { label: t("table.menu.sort_desc"), run: () => st.widget.sortColumn(view, colIdx, "desc") },
      "separator",
      { label: t("table.menu.insert_column_before"), run: () => st.widget.insertColumn(view, colIdx) },
      { label: t("table.menu.insert_column_after"), run: () => st.widget.insertColumn(view, multi ? selCols[selCols.length - 1] + 1 : colIdx + 1) },
      "separator",
      { label: t("table.menu.move_column_left"), run: () => st.widget.moveColumn(view, colIdx, colIdx - 1) },
      { label: t("table.menu.move_column_right"), run: () => st.widget.moveColumn(view, colIdx, colIdx + 1) },
      "separator",
      { label: t("table.menu.align_left"), run: () => st.widget.setColumnAlign(view, colIdx, "left") },
      { label: t("table.menu.align_centre"), run: () => st.widget.setColumnAlign(view, colIdx, "center") },
      { label: t("table.menu.align_right"), run: () => st.widget.setColumnAlign(view, colIdx, "right") },
      "separator",
      { label: t("table.menu.duplicate_column"), run: () => st.widget.duplicateColumn(view, colIdx) },
      {
        label: tPlural("table.menu.delete_columns", multi ? selCols.length : 1),
        run: () => multi ? st.widget.deleteColumns(view, selCols) : this.deleteColumn(view, colIdx),
        danger: true,
      },
    ];
    showContextMenu(e.clientX, e.clientY, entries);
  }

  private showRowMenu(st: TableDom, rowIdx: number, e: MouseEvent) {
    const { wrap, view } = st;
    const isHeaderRow = this.data.header !== null && rowIdx === 0;
    const selRows = getSelectedRowIndices(wrap);
    const multi = selRows.length > 1 && selRows.includes(rowIdx);

    const entries: ContextMenuEntry[] = [
      { label: t("table.menu.insert_row_above"), run: () => st.widget.insertRow(view, rowIdx) },
      { label: t("table.menu.insert_row_below"), run: () => st.widget.insertRow(view, multi ? selRows[selRows.length - 1] + 1 : rowIdx + 1) },
      "separator",
      { label: t("table.menu.move_row_up"), run: () => st.widget.moveRow(view, rowIdx, rowIdx - 1) },
      { label: t("table.menu.move_row_down"), run: () => st.widget.moveRow(view, rowIdx, rowIdx + 1) },
      "separator",
    ];
    // Heights written into `rows:` are exact in Typst and can clip or
    // overflow the compiled note; offer the way back to content-fit rows.
    if (hasRowSizes(this.data)) {
      entries.push({ label: t("table.menu.fit_rows"), run: () => st.widget.clearRowSizes(view) }, "separator");
    }
    // Typst's `table.header` is always the first row, so only that row can
    // become (or stop being) the header.
    if (rowIdx === 0) {
      entries.push({
        label: isHeaderRow ? t("table.menu.remove_header") : t("table.menu.set_header"),
        run: () => st.widget.toggleHeaderRow(view),
      });
    }
    entries.push(
      {
        label: tPlural("table.menu.duplicate_rows", multi ? selRows.length : 1),
        run: () => {
          if (multi) { for (let i = selRows.length - 1; i >= 0; i--) st.widget.duplicateRow(view, selRows[i]); }
          else st.widget.duplicateRow(view, rowIdx);
        },
      },
      {
        label: tPlural("table.menu.delete_rows", multi ? selRows.length : 1),
        run: () => multi ? st.widget.deleteRows(view, selRows) : this.deleteRow(view, rowIdx),
        danger: true,
      },
    );
    showContextMenu(e.clientX, e.clientY, entries);
  }

  /** The whole-table menu, from the corner handle. */
  private showTableMenu(st: TableDom, e: MouseEvent) {
    const { view } = st;
    const entries: ContextMenuEntry[] = [
      { label: t("table.menu.copy_table"), run: () => { void navigator.clipboard.writeText(tableToTsv(st.widget.data)); } },
      "separator",
    ];
    if (hasRowSizes(this.data)) {
      entries.push({ label: t("table.menu.fit_rows"), run: () => st.widget.clearRowSizes(view) });
    }
    if (this.data.columns.some((c) => c !== "auto")) {
      entries.push({ label: t("table.menu.reset_column_widths"), run: () => st.widget.resetColumnWidths(view) });
    }
    if (entries.length > 2) entries.push("separator");
    entries.push(
      {
        label: this.data.header ? t("table.menu.remove_header") : t("table.menu.set_header"),
        run: () => st.widget.toggleHeaderRow(view),
      },
      { label: t("pill.editSource"), run: () => st.widget.editSource(st) },
      "separator",
      { label: t("table.menu.delete_table"), run: () => st.widget.deleteTable(st), danger: true },
    );
    showContextMenu(e.clientX, e.clientY, entries);
  }

  /** Select every cell, in navigation mode. */
  private selectAllCells(st: TableDom) {
    this.deactivateCell(st);
    clearHandleSelection(st.wrap);
    const cells = st.wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell");
    cells.forEach((c) => c.classList.add("cm-typst-table-cell--selected"));
    const { rows, cols } = this.gridSize(st.wrap);
    st.nav.anchorRow = st.nav.anchorCol = 0;
    st.nav.headRow = Math.max(0, rows - 1);
    st.nav.headCol = Math.max(0, cols - 1);
    st.wrap.focus({ preventScroll: true });
  }

  /** Reveal the table's raw markup in the note, for editing by hand. */
  private editSource(st: TableDom) {
    this.deactivateCell(st);
    const { from } = this.liveRange(st.view);
    st.view.dispatch({ selection: { anchor: from }, effects: expandFunc.of(from) });
    st.view.focus();
  }

  /** Remove the whole table from the note, and the line break after it. */
  private deleteTable(st: TableDom) {
    this.deactivateCell(st);
    const { view } = st;
    const { from, to } = this.liveRange(view);
    const end = view.state.doc.sliceString(to, to + 1) === "\n" ? to + 1 : to;
    view.dispatch({ changes: { from, to: end, insert: "" }, selection: { anchor: from } });
    view.focus();
  }

  // ────────────────────────────────────────────────────────
  // Row / column selection via handle click
  // ────────────────────────────────────────────────────────

  private selectRow(wrap: HTMLElement, logicalRow: number) {
    clearCellSelection(wrap);
    clearHandleSelection(wrap);
    const row = wrap.querySelector<HTMLElement>(`tr[data-logical-row="${logicalRow}"]`);
    if (!row) return;
    row.classList.add("cm-table-row--selected");
    row.querySelectorAll<HTMLElement>(".cm-typst-table-cell").forEach((c) => {
      c.classList.add("cm-typst-table-cell--selected");
    });
    wrap.focus();
  }

  private selectColumn(wrap: HTMLElement, colIdx: number) {
    clearCellSelection(wrap);
    clearHandleSelection(wrap);
    const headerCell = wrap.querySelector<HTMLElement>(`.cm-table-control-row [data-col="${colIdx}"]`);
    if (headerCell) headerCell.classList.add("cm-table-col--selected");
    wrap.querySelectorAll<HTMLElement>(`tr[data-logical-row] [data-col="${colIdx}"]`).forEach((c) => {
      c.classList.add("cm-table-col--selected");
    });
    wrap.querySelectorAll<HTMLElement>(`tr[data-logical-row] [data-col="${colIdx}"] .cm-typst-table-cell`).forEach((c) => {
      c.classList.add("cm-typst-table-cell--selected");
    });
    wrap.focus();
  }

  // ────────────────────────────────────────────────────────
  // Structural operations
  // ────────────────────────────────────────────────────────

  private replaceTable(view: EditorView, newData: TableData) {
    const { from, to } = this.liveRange(view);
    view.dispatch({
      changes: { from, to, insert: serializeTable(newData) },
    });
  }

  /**
   * The table's current source range. Edits elsewhere in the note move the
   * decoration that carries this widget, but not the offsets captured when it
   * was built, so anything that writes back to the source resolves the range
   * here first. Falls back to the construction offsets when the widget is not
   * in the decoration set (a fresh, equal widget replaced it at the same
   * place).
   */
  private liveRange(view: EditorView): { from: number; to: number } {
    for (const set of view.state.facet(EditorView.decorations)) {
      if (typeof set === "function") continue;
      let found: { from: number; to: number } | null = null;
      set.between(0, view.state.doc.length, (from, to, deco) => {
        if (deco.spec?.widget === this) {
          found = { from, to };
          return false;
        }
      });
      if (found) return found;
    }
    return { from: this.from, to: this.to };
  }

  private getAllRows(): TableCell[][] {
    return this.data.header
      ? [this.data.header, ...this.data.rows]
      : [...this.data.rows];
  }

  private rebuildFromAllRows(
    allRows: TableCell[][],
    headerPresent: boolean,
    rowSizes: string[] | null = this.data.rowSizes,
  ): TableData {
    return {
      ...this.data,
      rowSizes: rowSizes && rowSizes.some((s) => s !== "auto") ? rowSizes : null,
      header: headerPresent ? allRows[0] ?? null : null,
      rows: headerPresent ? allRows.slice(1) : allRows,
    };
  }

  private insertRow(view: EditorView, atLogical: number) {
    const newRow: TableCell[] = this.data.columns.map(() => ({ ...EMPTY_CELL }));
    const all = this.getAllRows();
    all.splice(atLogical, 0, newRow);
    const rs = this.currentRowSizes();
    if (rs) rs.splice(atLogical, 0, "auto");
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null, rs));
  }

  private deleteRow(view: EditorView, logicalRow: number) {
    const all = this.getAllRows();
    if (all.length <= 1) return;
    all.splice(logicalRow, 1);
    const rs = this.currentRowSizes();
    if (rs) rs.splice(logicalRow, 1);
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null && logicalRow !== 0, rs));
  }

  private deleteRows(view: EditorView, rowIndices: number[]) {
    const all = this.getAllRows();
    if (all.length - rowIndices.length < 1) return;
    const toDelete = new Set(rowIndices);
    const remaining = all.filter((_, i) => !toDelete.has(i));
    const rs = this.currentRowSizes()?.filter((_, i) => !toDelete.has(i)) ?? null;
    this.replaceTable(view, this.rebuildFromAllRows(remaining, this.data.header !== null && !toDelete.has(0), rs));
  }

  private duplicateRow(view: EditorView, logicalRow: number) {
    const all = this.getAllRows();
    const dup = all[logicalRow].map((c) => ({ ...c, relFrom: 0, relTo: 0 }));
    all.splice(logicalRow + 1, 0, dup);
    const rs = this.currentRowSizes();
    if (rs) rs.splice(logicalRow + 1, 0, rs[logicalRow]);
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null, rs));
  }

  private moveRow(view: EditorView, from: number, to: number) {
    const all = this.getAllRows();
    if (to < 0 || to >= all.length) return;
    const [row] = all.splice(from, 1);
    all.splice(to, 0, row);
    const rs = this.currentRowSizes();
    if (rs) { const [s] = rs.splice(from, 1); rs.splice(to, 0, s); }
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null, rs));
  }

  private insertColumn(view: EditorView, atCol: number) {
    const cols = [...this.data.columns];
    cols.splice(atCol, 0, "auto");
    const align = this.data.align ? [...this.data.align] : null;
    if (align) align.splice(atCol, 0, "left");
    const header = this.data.header
      ? [...this.data.header.slice(0, atCol), { ...EMPTY_CELL }, ...this.data.header.slice(atCol)]
      : null;
    const rows = this.data.rows.map((r) => [...r.slice(0, atCol), { ...EMPTY_CELL }, ...r.slice(atCol)]);
    this.replaceTable(view, { ...this.data, columns: cols, align, header, rows });
  }

  private deleteColumn(view: EditorView, colIdx: number) {
    if (this.data.columns.length <= 1) return;
    const rm = (_: unknown, i: number) => i !== colIdx;
    this.replaceTable(view, {
      ...this.data,
      columns: this.data.columns.filter(rm),
      align: this.data.align?.filter(rm) ?? null,
      header: this.data.header?.filter(rm) ?? null,
      rows: this.data.rows.map((r) => r.filter(rm)),
    });
  }

  private deleteColumns(view: EditorView, colIndices: number[]) {
    if (this.data.columns.length - colIndices.length < 1) return;
    const toDelete = new Set(colIndices);
    const keep = (_: unknown, i: number) => !toDelete.has(i);
    this.replaceTable(view, {
      ...this.data,
      columns: this.data.columns.filter(keep),
      align: this.data.align?.filter(keep) ?? null,
      header: this.data.header?.filter(keep) ?? null,
      rows: this.data.rows.map((r) => r.filter(keep)),
    });
  }

  private duplicateColumn(view: EditorView, colIdx: number) {
    const cols = [...this.data.columns];
    cols.splice(colIdx + 1, 0, cols[colIdx]);
    const align = this.data.align ? [...this.data.align] : null;
    if (align) align.splice(colIdx + 1, 0, align[colIdx]);
    const header = this.data.header
      ? [...this.data.header.slice(0, colIdx + 1), { ...this.data.header[colIdx], relFrom: 0, relTo: 0 }, ...this.data.header.slice(colIdx + 1)]
      : null;
    const rows = this.data.rows.map((r) => [
      ...r.slice(0, colIdx + 1), { ...r[colIdx], relFrom: 0, relTo: 0 }, ...r.slice(colIdx + 1),
    ]);
    this.replaceTable(view, { ...this.data, columns: cols, align, header, rows });
  }

  /** Move column `from` so it sits at index `to`, shifting the columns in
   *  between — the same semantics as `moveRow` and as the drop indicator. */
  private moveColumn(view: EditorView, from: number, to: number) {
    if (to < 0 || to >= this.data.columns.length || from === to) return;
    const move = <T>(arr: T[]): T[] => {
      const copy = [...arr];
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item);
      return copy;
    };
    this.replaceTable(view, {
      ...this.data,
      columns: move(this.data.columns),
      align: this.data.align ? move(this.data.align) : null,
      header: this.data.header ? move(this.data.header) : null,
      rows: this.data.rows.map((r) => move(r)),
    });
  }

  private setColumnAlign(view: EditorView, colIdx: number, align: string) {
    const cur = this.data.align ?? this.data.columns.map(() => "left");
    const next = [...cur];
    next[colIdx] = align;
    this.replaceTable(view, { ...this.data, align: next });
  }

  /** Set (or clear, with `"auto"`) the explicit width of a column. */
  private setColumnSize(view: EditorView, colIdx: number, size: string) {
    const cols = [...this.data.columns];
    cols[colIdx] = size;
    this.replaceTable(view, { ...this.data, columns: cols });
  }

  /** Drop every explicit row height — an array or a bare value — so rows
   *  fit their content again. */
  private clearRowSizes(view: EditorView) {
    this.replaceTable(view, {
      ...this.data,
      rowSizes: null,
      extraArgs: this.data.extraArgs.filter((a) => a.key !== "rows"),
    });
  }

  /** Let every column size to its content again. */
  private resetColumnWidths(view: EditorView) {
    this.replaceTable(view, { ...this.data, columns: this.data.columns.map(() => "auto") });
  }

  /** Row-size array normalised to the current logical row count (padded with
   *  `auto`), or `null` when the table carries no `rows:` argument. */
  private currentRowSizes(): string[] | null {
    if (!this.data.rowSizes) return null;
    const n = this.getAllRows().length;
    const rs = this.data.rowSizes.slice(0, n);
    while (rs.length < n) rs.push("auto");
    return rs;
  }

  private sortColumn(view: EditorView, colIdx: number, dir: "asc" | "desc") {
    // Natural ordering, so a column of `2`, `10`, `100` sorts as numbers
    // rather than as text — the common case for a table column.
    const sorted = [...this.data.rows].sort((a, b) => {
      const x = a[colIdx]?.content ?? "";
      const y = b[colIdx]?.content ?? "";
      return dir === "asc" ? compareName(x, y) : compareName(y, x);
    });
    this.replaceTable(view, { ...this.data, rows: sorted });
  }

  /** Make the first row the header, or demote the header to a body row.
   *  Logical row order is unchanged either way, so explicit row heights stay
   *  aligned. */
  private toggleHeaderRow(view: EditorView) {
    if (this.data.header) {
      this.replaceTable(view, {
        ...this.data,
        header: null,
        rows: [this.data.header, ...this.data.rows],
      });
    } else if (this.data.rows.length > 0) {
      const [first, ...rest] = this.data.rows;
      this.replaceTable(view, { ...this.data, header: first, rows: rest });
    }
  }
}

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

/** The widget rendered as `wrap`, resolved through the decoration set so the
 *  instance is the one the editor currently holds. Null if `wrap` is not
 *  mounted in `view`. */
export function tableWidgetAt(view: EditorView, wrap: HTMLElement): TableWidget | null {
  let pos: number;
  try {
    pos = view.posAtDOM(wrap);
  } catch {
    return null;
  }
  let found: TableWidget | null = null;
  for (const set of view.state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    set.between(pos, pos, (from, _to, deco) => {
      if (from === pos && deco.spec?.widget instanceof TableWidget) {
        found = deco.spec.widget;
        return false;
      }
    });
    if (found) break;
  }
  return found;
}

function clearCellSelection(wrap: HTMLElement) {
  wrap.querySelectorAll(".cm-typst-table-cell--selected").forEach((c) =>
    c.classList.remove("cm-typst-table-cell--selected"),
  );
}

function getSelectedRowIndices(wrap: HTMLElement): number[] {
  const rows = new Set<number>();
  const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
  for (const cell of wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell--selected")) {
    const row = cell.closest<HTMLElement>("tr[data-logical-row]");
    if (row) rows.add(allRows.indexOf(row));
  }
  return Array.from(rows).sort((a, b) => a - b);
}

function getSelectedColIndices(wrap: HTMLElement): number[] {
  const cols = new Set<number>();
  for (const cell of wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell--selected")) {
    const td = cell.closest<HTMLElement>("td, th");
    if (td?.dataset.col != null) cols.add(parseInt(td.dataset.col, 10));
  }
  return Array.from(cols).sort((a, b) => a - b);
}

function getCellAt(wrap: HTMLElement, row: number, col: number): HTMLElement | null {
  const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
  if (row < 0 || row >= allRows.length) return null;
  const dataCells = allRows[row].querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)");
  if (col < 0 || col >= dataCells.length) return null;
  return dataCells[col]?.querySelector<HTMLElement>(".cm-typst-table-cell") ?? null;
}

/** Top-left selected cell, or null when nothing is selected. */
function getSelectionAnchor(wrap: HTMLElement): { row: number; col: number } | null {
  const selected = wrap.querySelector<HTMLElement>(".cm-typst-table-cell--selected");
  if (!selected) return null;
  const td = selected.closest<HTMLElement>("td, th");
  const row = td?.closest<HTMLElement>("tr[data-logical-row]");
  if (!td || !row) return null;
  const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
  const dataCells = Array.from(row.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));
  const rowIdx = allRows.indexOf(row);
  const colIdx = dataCells.indexOf(td);
  return rowIdx >= 0 && colIdx >= 0 ? { row: rowIdx, col: colIdx } : null;
}

function clearHandleSelection(wrap: HTMLElement) {
  wrap.querySelectorAll(".cm-table-row--selected").forEach((el) =>
    el.classList.remove("cm-table-row--selected"),
  );
  wrap.querySelectorAll(".cm-table-col--selected").forEach((el) =>
    el.classList.remove("cm-table-col--selected"),
  );
}

function selectCellRange(wrap: HTMLElement, start: HTMLElement, end: HTMLElement) {
  const startTd = start.closest<HTMLElement>("td, th");
  const endTd = end.closest<HTMLElement>("td, th");
  if (!startTd || !endTd) return;

  const startRow = startTd.closest<HTMLElement>("tr[data-logical-row]");
  const endRow = endTd.closest<HTMLElement>("tr[data-logical-row]");
  if (!startRow || !endRow) return;

  const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
  const r1 = allRows.indexOf(startRow);
  const r2 = allRows.indexOf(endRow);

  const dataCellsOf = (row: HTMLElement) =>
    Array.from(row.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));

  const c1 = dataCellsOf(startRow).indexOf(startTd);
  const c2 = dataCellsOf(endRow).indexOf(endTd);

  const rMin = Math.min(r1, r2), rMax = Math.max(r1, r2);
  const cMin = Math.min(c1, c2), cMax = Math.max(c1, c2);

  for (let r = rMin; r <= rMax; r++) {
    const cells = dataCellsOf(allRows[r]);
    for (let c = cMin; c <= cMax; c++) {
      const cell = cells[c]?.querySelector<HTMLElement>(".cm-typst-table-cell");
      if (cell) cell.classList.add("cm-typst-table-cell--selected");
    }
  }
}

/** Whether the table carries any `rows:` argument, modelled or verbatim. */
function hasRowSizes(data: TableData): boolean {
  return data.rowSizes !== null || data.extraArgs.some((a) => a.key === "rows");
}

/** The selected cells' source text as tab-separated rows, for the clipboard. */
export function getSelectedCellsText(wrap: HTMLElement): string {
  const data = domStates.get(wrap)?.widget.data;
  const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
  const lines: string[] = [];
  for (let r = 0; r < allRows.length; r++) {
    const dataCells = Array.from(allRows[r].querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));
    const texts: string[] = [];
    for (let c = 0; c < dataCells.length; c++) {
      const cell = dataCells[c].querySelector<HTMLElement>(".cm-typst-table-cell");
      if (!cell?.classList.contains("cm-typst-table-cell--selected")) continue;
      const logical = data ? (data.header ? [data.header, ...data.rows] : data.rows) : null;
      texts.push(logical?.[r]?.[c]?.content ?? cell.textContent ?? "");
    }
    if (texts.length > 0) lines.push(texts.join("\t"));
  }
  return lines.join("\n");
}

