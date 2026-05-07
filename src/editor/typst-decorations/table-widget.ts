import { WidgetType, type EditorView } from "@codemirror/view";
import { type TableData, type TableCell, serializeTable, parseClipboardAsGrid, parseTsvToGrid } from "./table-parser";

const EMPTY_CELL: TableCell = { content: "", relFrom: 0, relTo: 0 };

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
  constructor(
    readonly data: TableData,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  get estimatedHeight(): number {
    const rowCount = this.getAllRows().length;
    // ~32px per data row + ~28px control row + 16px margin
    return rowCount * 32 + 28 + 16;
  }

  eq(other: TableWidget) {
    if (this.from !== other.from || this.to !== other.to) return false;
    if (this.data.columns.length !== other.data.columns.length) return false;
    const a = this.data.align, b = other.data.align;
    if ((a == null) !== (b == null)) return false;
    if (a && b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
    }
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

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-table-wrap";
    wrap.tabIndex = 0;

    const colCount = this.data.columns.length;

    const table = document.createElement("table");
    table.className = "cm-typst-table";

    // ── Control row (column handles + add-buttons) ──
    const controlRow = document.createElement("tr");
    controlRow.className = "cm-table-control-row";

    const cornerCell = document.createElement("td");
    cornerCell.className = "cm-table-corner-cell";
    controlRow.appendChild(cornerCell);

    for (let c = 0; c < colCount; c++) {
      const td = document.createElement("td");
      td.className = "cm-table-col-header-cell";
      td.dataset.col = String(c);

      if (c === 0) {
        const addBefore = this.makeAddColBtn(view, 0);
        td.appendChild(addBefore);
      }

      const handle = document.createElement("div");
      handle.className = "cm-table-col-handle";
      handle.innerHTML = '<span class="cm-table-handle-grip">⠿</span>';
      handle.title = "Right-click for options · drag to reorder";
      const colIdx = c;

      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.button === 0) {
          e.preventDefault();
          this.startPointerDrag(view, wrap, table, "col", colIdx, handle, e);
        }
      });
      handle.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showColumnMenu(view, wrap, colIdx, handle);
      });
      td.appendChild(handle);

      const addAfter = this.makeAddColBtn(view, c + 1);
      td.appendChild(addAfter);

      controlRow.appendChild(td);
    }
    table.appendChild(controlRow);

    // ── Build data rows (header + body) ──
    const allLogicalRows = this.getAllRows();

    for (let r = 0; r < allLogicalRows.length; r++) {
      const isHeader = this.data.header !== null && r === 0;
      const tr = document.createElement("tr");
      tr.dataset.logicalRow = String(r);

      const handleCell = document.createElement("td");
      handleCell.className = "cm-table-row-handle-cell";

      if (r === 0) {
        const addBefore = this.makeAddRowBtn(view, 0);
        handleCell.appendChild(addBefore);
      }

      const handle = document.createElement("div");
      handle.className = "cm-table-row-handle";
      handle.innerHTML = '<span class="cm-table-handle-grip">⠿</span>';
      handle.title = "Right-click for options · drag to reorder";
      const rowIdx = r;

      handle.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.button === 0) {
          e.preventDefault();
          this.startPointerDrag(view, wrap, table, "row", rowIdx, handle, e);
        }
      });
      handle.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showRowMenu(view, wrap, rowIdx, handle);
      });
      handleCell.appendChild(handle);

      const addAfter = this.makeAddRowBtn(view, r + 1);
      handleCell.appendChild(addAfter);

      tr.appendChild(handleCell);

      for (let c = 0; c < allLogicalRows[r].length; c++) {
        const cellEl = document.createElement(isHeader ? "th" : "td");
        cellEl.dataset.col = String(c);
        this.setupCell(cellEl, allLogicalRows[r][c], view, wrap);
        if (this.data.align && this.data.align[c]) {
          cellEl.style.textAlign = this.data.align[c];
        }
        const cellColIdx = c;
        const cellRowIdx = r;
        cellEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showCellMenu(view, wrap, cellRowIdx, cellColIdx, cellEl);
        });
        tr.appendChild(cellEl);
      }

      table.appendChild(tr);
    }

    wrap.appendChild(table);

    this.setupCellSelection(wrap);
    this.setupTableNavigation(view, wrap);
    this.setupClipboard(view, wrap);


    return wrap;
  }

  ignoreEvent(e: Event) {
    return (
      e.type === "mousedown" ||
      e.type === "mouseup" ||
      e.type === "mousemove" ||
      e.type === "input" ||
      e.type === "keydown" ||
      e.type === "keyup" ||
      e.type === "focus" ||
      e.type === "blur" ||
      e.type === "focusin" ||
      e.type === "focusout" ||
      e.type === "contextmenu" ||
      e.type === "click" ||
      e.type === "dblclick" ||
      e.type === "selectstart" ||
      e.type === "select" ||
      e.type === "copy" ||
      e.type === "paste" ||
      e.type === "dragstart" ||
      e.type === "dragover" ||
      e.type === "dragleave" ||
      e.type === "dragend" ||
      e.type === "drop" ||
      e.type === "drag" ||
      e.type === "pointerdown" ||
      e.type === "pointermove" ||
      e.type === "pointerup"
    );
  }

  // ────────────────────────────────────────────────────────
  // Small button factories
  // ────────────────────────────────────────────────────────

  private makeAddColBtn(view: EditorView, atCol: number): HTMLElement {
    const btn = document.createElement("div");
    btn.className = "cm-table-add-btn cm-table-add-btn--col";
    btn.innerHTML = "<span>+</span>";
    btn.title = atCol === 0 ? "Add column before" : "Add column after";
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.insertColumn(view, atCol);
    });
    return btn;
  }

  private makeAddRowBtn(view: EditorView, atRow: number): HTMLElement {
    const btn = document.createElement("div");
    btn.className = "cm-table-add-btn cm-table-add-btn--row";
    btn.innerHTML = "<span>+</span>";
    btn.title = atRow === 0 ? "Add row above" : "Add row below";
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.insertRow(view, atRow);
    });
    return btn;
  }

  // ────────────────────────────────────────────────────────
  // Pointer-based drag reorder
  // ────────────────────────────────────────────────────────

  private startPointerDrag(
    view: EditorView,
    wrap: HTMLElement,
    table: HTMLTableElement,
    dragType: "col" | "row",
    fromIdx: number,
    handle: HTMLElement,
    startEvent: PointerEvent,
  ) {
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
          this.moveColumn(view, fromIdx, lastTarget);
        } else {
          this.moveRow(view, fromIdx, lastTarget);
        }
      }
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // ────────────────────────────────────────────────────────
  // Cell setup
  // ────────────────────────────────────────────────────────

  private setupCell(
    el: HTMLElement,
    cell: TableCell,
    view: EditorView,
    wrap: HTMLElement,
  ) {
    const cellDiv = document.createElement("div");
    cellDiv.className = "cm-typst-table-cell";
    cellDiv.contentEditable = "true";
    cellDiv.spellcheck = false;
    cellDiv.textContent = cell.content;

    const tableFrom = this.from;
    const relFrom = cell.relFrom;
    const relTo = cell.relTo;

    cellDiv.addEventListener("focus", () => {
      cellDiv.textContent = cell.content;
      clearCellSelection(wrap);
      cellDiv.classList.add("cm-typst-table-cell--editing");
    });

    cellDiv.addEventListener("blur", () => {
      cellDiv.classList.remove("cm-typst-table-cell--editing");
      const newContent = cellDiv.textContent ?? "";
      if (newContent !== cell.content) {
        const absFrom = tableFrom + relFrom + 1;
        const absTo = tableFrom + relTo - 1;
        const currentFull = view.state.doc.sliceString(tableFrom, tableFrom + relTo + 1);
        if (
          currentFull.length > relTo - 1 &&
          currentFull[relFrom] === "[" &&
          currentFull[relTo - 1] === "]"
        ) {
          view.dispatch({
            changes: { from: absFrom, to: absTo, insert: newContent },
          });
        }
      }
    });

    cellDiv.addEventListener("keydown", (e) => {
      e.stopPropagation();

      // Forward undo/redo to CM6 editor
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === "z" || e.key === "y") {
          e.preventDefault();
          cellDiv.blur();
          forwardToEditor(view, e);
          return;
        }
        if (e.key === "b") {
          e.preventDefault();
          wrapSelection(cellDiv, "*", "*");
          return;
        }
        if (e.key === "i") {
          e.preventDefault();
          wrapSelection(cellDiv, "_", "_");
          return;
        }
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.navigateCell(wrap, el, 1, 0, view);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.navigateCell(wrap, el, -1, 0, view);
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        const cells = Array.from(
          wrap.querySelectorAll<HTMLElement>(".cm-typst-table-cell"),
        );
        const idx = cells.indexOf(cellDiv);
        const nextIdx = e.shiftKey ? idx - 1 : idx + 1;
        if (nextIdx >= 0 && nextIdx < cells.length) {
          cellDiv.blur();
          cells[nextIdx].focus();
          selectAllContent(cells[nextIdx]);
        }
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.navigateCell(wrap, el, 1, 0, view);
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        cellDiv.blur();
        clearCellSelection(wrap);
        cellDiv.classList.add("cm-typst-table-cell--selected");
        wrap.focus();
        return;
      }
    });

    cellDiv.addEventListener("copy", (e) => {
      const selected = wrap.querySelectorAll(".cm-typst-table-cell--selected");
      if (selected.length > 1) {
        e.preventDefault();
        const text = getSelectedCellsText(wrap);
        e.clipboardData!.setData("text/plain", text);
      }
    });

    cellDiv.addEventListener("paste", (e) => {
      const grid = parseClipboardAsGrid(e);
      if (grid && (grid.length > 1 || (grid.length === 1 && grid[0].length > 1))) {
        e.preventDefault();
        e.stopPropagation();
        cellDiv.blur();
        const allDataRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
        const row = el.closest<HTMLElement>("tr[data-logical-row]")!;
        const rowIdx = allDataRows.indexOf(row);
        const dataCells = Array.from(row.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));
        const colIdx = dataCells.indexOf(el);
        this.fillCellsFromGrid(view, rowIdx, colIdx, grid);
      }
    });

    el.appendChild(cellDiv);
  }

  private navigateCell(wrap: HTMLElement, currentTd: HTMLElement, rowDelta: number, colDelta: number, view?: EditorView) {
    const table = currentTd.closest("table")!;
    const allRows = Array.from(table.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
    const row = currentTd.closest<HTMLElement>("tr[data-logical-row]")!;
    const rowIdx = allRows.indexOf(row);
    const dataCells = Array.from(row.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));
    const colIdx = dataCells.indexOf(currentTd);

    const newRow = rowIdx + rowDelta;
    const newCol = colIdx + colDelta;

    if (newRow < 0 || newRow >= allRows.length) {
      if (view) this.exitToEditor(view, newRow < 0 ? "before" : "after");
      return;
    }
    const targetRow = allRows[newRow];
    const targetCells = targetRow.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)");
    const targetCol = Math.min(Math.max(0, newCol), targetCells.length - 1);
    const targetCell = targetCells[targetCol]?.querySelector<HTMLElement>(".cm-typst-table-cell");
    if (targetCell) {
      const currentCell = currentTd.querySelector<HTMLElement>(".cm-typst-table-cell");
      if (currentCell) currentCell.blur();
      targetCell.focus();
      selectAllContent(targetCell);
    }
  }

  private exitToEditor(view: EditorView, direction: "before" | "after") {
    const pos = direction === "before" ? this.from : this.to;
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

  private setupCellSelection(wrap: HTMLElement) {
    let selecting = false;
    let startCell: HTMLElement | null = null;

    wrap.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      const cell = target.closest<HTMLElement>(".cm-typst-table-cell");
      if (!cell) return;
      if (e.button !== 0) return;

      if (document.activeElement === cell) return;

      e.preventDefault();
      selecting = true;
      startCell = cell;
      clearCellSelection(wrap);
      clearHandleSelection(wrap);
      cell.classList.add("cm-typst-table-cell--selected");
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
      e.preventDefault();
      clearCellSelection(wrap);
      cell.focus();
      selectAllContent(cell);
    });
  }

  // ────────────────────────────────────────────────────────
  // Table-level keyboard navigation (when wrap has focus)
  // ────────────────────────────────────────────────────────

  private setupTableNavigation(view: EditorView, wrap: HTMLElement) {
    let anchorRow = 0;
    let anchorCol = 0;
    let headRow = 0;
    let headCol = 0;

    wrap.addEventListener("keydown", (e) => {
      if (document.activeElement !== wrap) return;

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === "c" || e.key === "v") {
          return;
        }
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

      if (e.key === "F2" || e.key === "Enter") {
        if (selected) {
          e.preventDefault();
          e.stopPropagation();
          clearCellSelection(wrap);
          selected.focus();
          selectAllContent(selected);
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
          anchorRow = anchorCol = headRow = headCol = 0;
          const first = getCellAt(wrap, 0, 0);
          if (first) {
            clearCellSelection(wrap);
            first.classList.add("cm-typst-table-cell--selected");
          }
          return;
        }

        let newRow = headRow;
        let newCol = headCol;
        if (e.key === "ArrowDown") newRow++;
        if (e.key === "ArrowUp") newRow--;
        if (e.key === "ArrowRight") newCol++;
        if (e.key === "ArrowLeft") newCol--;

        if (newRow < 0 || newRow >= rowCount) {
          this.exitToEditor(view, newRow < 0 ? "before" : "after");
          return;
        }
        if (newCol < 0 || newCol >= colCount) return;

        headRow = newRow;
        headCol = newCol;

        if (e.shiftKey) {
          clearCellSelection(wrap);
          const a = getCellAt(wrap, anchorRow, anchorCol);
          const h = getCellAt(wrap, headRow, headCol);
          if (a && h) selectCellRange(wrap, a, h);
        } else {
          anchorRow = headRow;
          anchorCol = headCol;
          clearCellSelection(wrap);
          const cell = getCellAt(wrap, headRow, headCol);
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
          const allRows = this.getAllRows();
          for (const key of positions) {
            const [r, c] = key.split(",").map(Number);
            if (allRows[r]?.[c]) {
              allRows[r][c] = { content: "", relFrom: 0, relTo: 0 };
            }
          }
          this.replaceTable(view, this.rebuildFromAllRows(allRows, this.data.header !== null));
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

      // Any printable character: enter edit mode and type
      if (selected && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        clearCellSelection(wrap);
        selected.textContent = "";
        selected.focus();
        document.execCommand("insertText", false, e.key);
        return;
      }
    });
  }

  // ────────────────────────────────────────────────────────
  // Clipboard (copy / paste)
  // ────────────────────────────────────────────────────────

  private setupClipboard(view: EditorView, wrap: HTMLElement) {
    wrap.addEventListener("copy", (e) => {
      const selected = wrap.querySelectorAll(".cm-typst-table-cell--selected");
      if (selected.length > 0) {
        e.preventDefault();
        e.clipboardData!.setData("text/plain", getSelectedCellsText(wrap));
      }
    });

    wrap.addEventListener("paste", (e) => {
      e.preventDefault();
      const grid = parseClipboardAsGrid(e);
      if (!grid || grid.length === 0) return;
      const anchor = getSelectionAnchor(wrap);
      this.fillCellsFromGrid(view, anchor.row, anchor.col, grid);
    });
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

    this.replaceTable(view, this.rebuildFromAllRows(allRows, this.data.header !== null));
  }

  // ────────────────────────────────────────────────────────
  // Context menus
  // ────────────────────────────────────────────────────────

  private showCellMenu(view: EditorView, wrap: HTMLElement, rowIdx: number, colIdx: number, anchor: HTMLElement) {
    removeExistingMenu();
    const rect = anchor.getBoundingClientRect();
    const hasSelection = wrap.querySelectorAll(".cm-typst-table-cell--selected").length > 0;
    const selRows = getSelectedRowIndices(wrap);
    const selCols = getSelectedColIndices(wrap);
    const multiRow = selRows.length > 1;
    const multiCol = selCols.length > 1;

    const menu = buildMenuAtPos(rect.left, rect.bottom + 2, [
      {
        label: "Copy",
        icon: ICON_COPY,
        action: () => {
          if (!hasSelection) {
            clearCellSelection(wrap);
            const cell = anchor.querySelector<HTMLElement>(".cm-typst-table-cell");
            if (cell) cell.classList.add("cm-typst-table-cell--selected");
          }
          navigator.clipboard.writeText(getSelectedCellsText(wrap));
        },
      },
      {
        label: "Paste",
        icon: ICON_PASTE,
        action: () => {
          navigator.clipboard.readText().then((text) => {
            const grid = parseTsvToGrid(text);
            if (grid) {
              const startRow = hasSelection ? getSelectionAnchor(wrap).row : rowIdx;
              const startCol = hasSelection ? getSelectionAnchor(wrap).col : colIdx;
              this.fillCellsFromGrid(view, startRow, startCol, grid);
            }
          });
        },
      },
      null,
      { label: "Insert row above", icon: "⊞", action: () => this.insertRow(view, rowIdx) },
      { label: "Insert row below", icon: "⊞", action: () => this.insertRow(view, multiRow ? selRows[selRows.length - 1] + 1 : rowIdx + 1) },
      { label: "Insert column before", icon: "⊞", action: () => this.insertColumn(view, colIdx) },
      { label: "Insert column after", icon: "⊞", action: () => this.insertColumn(view, multiCol ? selCols[selCols.length - 1] + 1 : colIdx + 1) },
      null,
      {
        label: multiRow ? `Delete ${selRows.length} rows` : "Delete row",
        icon: "",
        action: () => multiRow ? this.deleteRows(view, selRows) : this.deleteRow(view, rowIdx),
        danger: true,
      },
      {
        label: multiCol ? `Delete ${selCols.length} columns` : "Delete column",
        icon: "",
        action: () => multiCol ? this.deleteColumns(view, selCols) : this.deleteColumn(view, colIdx),
        danger: true,
      },
    ]);
    document.body.appendChild(menu);
    installMenuCloseHandler(menu);
  }

  private showColumnMenu(view: EditorView, wrap: HTMLElement, colIdx: number, anchor: HTMLElement) {
    removeExistingMenu();
    const rect = anchor.getBoundingClientRect();
    const selCols = getSelectedColIndices(wrap);
    const multi = selCols.length > 1 && selCols.includes(colIdx);

    const menu = buildMenuAtPos(rect.left, rect.bottom + 2, [
      { label: "Sort by column (A to Z)", icon: "↓₂", action: () => this.sortColumn(view, colIdx, "asc") },
      { label: "Sort by column (Z to A)", icon: "↑₂", action: () => this.sortColumn(view, colIdx, "desc") },
      null,
      { label: "Add column before", icon: "⊞", action: () => this.insertColumn(view, colIdx) },
      { label: "Add column after", icon: "⊞", action: () => this.insertColumn(view, multi ? selCols[selCols.length - 1] + 1 : colIdx + 1) },
      null,
      { label: "Move column left", icon: "←", action: () => this.moveColumn(view, colIdx, colIdx - 1) },
      { label: "Move column right", icon: "→", action: () => this.moveColumn(view, colIdx, colIdx + 1) },
      null,
      { label: "Align left", icon: "≡", action: () => this.setColumnAlign(view, colIdx, "left") },
      { label: "Align centre", icon: "≡", action: () => this.setColumnAlign(view, colIdx, "center") },
      { label: "Align right", icon: "≡", action: () => this.setColumnAlign(view, colIdx, "right") },
      null,
      { label: "Duplicate column", icon: "⊟", action: () => this.duplicateColumn(view, colIdx) },
      {
        label: multi ? `Delete ${selCols.length} columns` : "Delete column",
        icon: "",
        action: () => multi ? this.deleteColumns(view, selCols) : this.deleteColumn(view, colIdx),
        danger: true,
      },
    ]);
    document.body.appendChild(menu);
    installMenuCloseHandler(menu);
  }

  private showRowMenu(view: EditorView, wrap: HTMLElement, rowIdx: number, anchor: HTMLElement) {
    removeExistingMenu();
    const rect = anchor.getBoundingClientRect();
    const isHeaderRow = this.data.header !== null && rowIdx === 0;
    const selRows = getSelectedRowIndices(wrap);
    const multi = selRows.length > 1 && selRows.includes(rowIdx);

    const menu = buildMenuAtPos(rect.right + 2, rect.top, [
      { label: "Add row above", icon: "⊞", action: () => this.insertRow(view, rowIdx) },
      { label: "Add row below", icon: "⊞", action: () => this.insertRow(view, multi ? selRows[selRows.length - 1] + 1 : rowIdx + 1) },
      null,
      { label: "Move row up", icon: "↑", action: () => this.moveRow(view, rowIdx, rowIdx - 1) },
      { label: "Move row down", icon: "↓", action: () => this.moveRow(view, rowIdx, rowIdx + 1) },
      null,
      {
        label: isHeaderRow ? "Remove header" : "Set as header",
        icon: "H",
        action: () => this.toggleHeaderRow(view, rowIdx),
      },
      { label: multi ? `Duplicate ${selRows.length} rows` : "Duplicate row", icon: "⊟", action: () => {
        if (multi) { for (let i = selRows.length - 1; i >= 0; i--) this.duplicateRow(view, selRows[i]); }
        else this.duplicateRow(view, rowIdx);
      }},
      {
        label: multi ? `Delete ${selRows.length} rows` : "Delete row",
        icon: "",
        action: () => multi ? this.deleteRows(view, selRows) : this.deleteRow(view, rowIdx),
        danger: true,
      },
    ]);
    document.body.appendChild(menu);
    installMenuCloseHandler(menu);
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
    view.dispatch({
      changes: { from: this.from, to: this.to, insert: serializeTable(newData) },
    });
  }

  private getAllRows(): TableCell[][] {
    return this.data.header
      ? [this.data.header, ...this.data.rows]
      : [...this.data.rows];
  }

  private rebuildFromAllRows(allRows: TableCell[][], headerPresent: boolean): TableData {
    return {
      ...this.data,
      header: headerPresent ? allRows[0] ?? null : null,
      rows: headerPresent ? allRows.slice(1) : allRows,
    };
  }

  private insertRow(view: EditorView, atLogical: number) {
    const newRow: TableCell[] = this.data.columns.map(() => ({ ...EMPTY_CELL }));
    const all = this.getAllRows();
    all.splice(atLogical, 0, newRow);
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null));
  }

  private addRowAtEnd(view: EditorView) {
    const newRow: TableCell[] = this.data.columns.map(() => ({ ...EMPTY_CELL }));
    this.replaceTable(view, { ...this.data, rows: [...this.data.rows, newRow] });
  }

  private deleteRow(view: EditorView, logicalRow: number) {
    const all = this.getAllRows();
    if (all.length <= 1) return;
    all.splice(logicalRow, 1);
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null && logicalRow !== 0));
  }

  private deleteRows(view: EditorView, rowIndices: number[]) {
    const all = this.getAllRows();
    if (all.length - rowIndices.length < 1) return;
    const toDelete = new Set(rowIndices);
    const remaining = all.filter((_, i) => !toDelete.has(i));
    this.replaceTable(view, this.rebuildFromAllRows(remaining, this.data.header !== null && !toDelete.has(0)));
  }

  private duplicateRow(view: EditorView, logicalRow: number) {
    const all = this.getAllRows();
    const dup = all[logicalRow].map((c) => ({ ...c, relFrom: 0, relTo: 0 }));
    all.splice(logicalRow + 1, 0, dup);
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null));
  }

  private moveRow(view: EditorView, from: number, to: number) {
    const all = this.getAllRows();
    if (to < 0 || to >= all.length) return;
    const [row] = all.splice(from, 1);
    all.splice(to, 0, row);
    this.replaceTable(view, this.rebuildFromAllRows(all, this.data.header !== null));
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

  private moveColumn(view: EditorView, from: number, to: number) {
    if (to < 0 || to >= this.data.columns.length) return;
    const swap = <T>(arr: T[]): T[] => {
      const copy = [...arr];
      [copy[from], copy[to]] = [copy[to], copy[from]];
      return copy;
    };
    this.replaceTable(view, {
      ...this.data,
      columns: swap(this.data.columns),
      align: this.data.align ? swap(this.data.align) : null,
      header: this.data.header ? swap(this.data.header) : null,
      rows: this.data.rows.map((r) => swap(r)),
    });
  }

  private setColumnAlign(view: EditorView, colIdx: number, align: string) {
    const cur = this.data.align ?? this.data.columns.map(() => "left");
    const next = [...cur];
    next[colIdx] = align;
    this.replaceTable(view, { ...this.data, align: next });
  }

  private sortColumn(view: EditorView, colIdx: number, dir: "asc" | "desc") {
    const sorted = [...this.data.rows].sort((a, b) => {
      const cmp = (a[colIdx]?.content ?? "").localeCompare(b[colIdx]?.content ?? "");
      return dir === "asc" ? cmp : -cmp;
    });
    this.replaceTable(view, { ...this.data, rows: sorted });
  }

  private toggleHeaderRow(view: EditorView, logicalRow: number) {
    if (this.data.header && logicalRow === 0) {
      this.replaceTable(view, {
        ...this.data,
        header: null,
        rows: [this.data.header, ...this.data.rows],
      });
    } else {
      const all = this.getAllRows();
      const [newHeader] = all.splice(logicalRow, 1);
      this.replaceTable(view, { ...this.data, header: newHeader, rows: all });
    }
  }
}

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

function selectAllContent(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
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

function getSelectionAnchor(wrap: HTMLElement): { row: number; col: number } {
  const selected = wrap.querySelector<HTMLElement>(".cm-typst-table-cell--selected");
  if (selected) {
    const td = selected.closest<HTMLElement>("td, th");
    if (td) {
      const table = td.closest("table")!;
      const allRows = Array.from(table.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
      const row = td.closest<HTMLElement>("tr[data-logical-row]")!;
      const rowIdx = allRows.indexOf(row);
      const dataCells = Array.from(row.querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)"));
      const colIdx = dataCells.indexOf(td);
      if (rowIdx >= 0 && colIdx >= 0) return { row: rowIdx, col: colIdx };
    }
  }
  return { row: 0, col: 0 };
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

function getSelectedCellsText(wrap: HTMLElement): string {
  const allRows = Array.from(wrap.querySelectorAll<HTMLElement>("tr[data-logical-row]"));
  const lines: string[] = [];
  for (const row of allRows) {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(".cm-typst-table-cell--selected"));
    if (cells.length > 0) {
      lines.push(cells.map((c) => c.textContent ?? "").join("\t"));
    }
  }
  return lines.join("\n");
}

function wrapSelection(el: HTMLElement, before: string, after: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;
  const text = range.toString();
  if (!text) return;
  range.deleteContents();
  range.insertNode(document.createTextNode(before + text + after));
  sel.collapseToEnd();
}

// ── Context menu helpers ──

interface MenuItem {
  label: string;
  icon: string;
  action: () => void;
  danger?: boolean;
}

function removeExistingMenu() {
  document.querySelectorAll(".cm-table-context-menu").forEach((m) => m.remove());
}

const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 0 1 1.34-1.34h2.66a1.33 1.33 0 0 1 1.34 1.34V4M13 4v9.33a1.33 1.33 0 0 1-1.33 1.34H4.33A1.33 1.33 0 0 1 3 13.33V4"/></svg>';
const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3"/></svg>';
const ICON_PASTE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h2.5A1.5 1.5 0 0 1 14 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-10A1.5 1.5 0 0 1 3.5 2H6"/><rect x="5.5" y="1" width="5" height="3" rx="1"/></svg>';

function buildMenuAtPos(x: number, y: number, items: (MenuItem | null)[]): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "cm-table-context-menu";
  menu.style.cssText = `
    position: fixed;
    z-index: 99999;
    left: ${x}px;
    top: ${y}px;
    background: var(--bg-primary, #fff);
    border: 1px solid var(--border-subtle, #ddd);
    border-radius: 6px;
    padding: 4px 0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    min-width: 200px;
    font-size: 0.85em;
    font-family: inherit;
    color: var(--fg-primary, #222);
  `;

  for (const item of items) {
    if (!item) {
      const sep = document.createElement("div");
      sep.style.cssText = "height:1px;background:var(--border-subtle,#ddd);margin:4px 0;";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 5px 12px;
      border: none;
      background: transparent;
      color: ${item.danger ? "var(--danger, #e53e3e)" : "inherit"};
      cursor: pointer;
      text-align: left;
      font-size: inherit;
      font-family: inherit;
    `;
    const iconHtml = item.danger
      ? `<span style="width:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${ICON_TRASH}</span>`
      : `<span style="width:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${item.icon}</span>`;
    btn.innerHTML = `${iconHtml} ${item.label}`;
    btn.addEventListener("mouseenter", () => { btn.style.background = "var(--bg-hover, #f0f0f0)"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; });
    btn.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.remove();
      item.action();
    });
    menu.appendChild(btn);
  }

  // Clamp to viewport after layout
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    const pad = 8;
    let cx = x, cy = y;
    if (r.right > window.innerWidth - pad) cx = window.innerWidth - pad - r.width;
    if (r.bottom > window.innerHeight - pad) cy = window.innerHeight - pad - r.height;
    if (cx < pad) cx = pad;
    if (cy < pad) cy = pad;
    menu.style.left = `${cx}px`;
    menu.style.top = `${cy}px`;
  });

  return menu;
}

function installMenuCloseHandler(menu: HTMLElement) {
  const cleanup = () => {
    menu.remove();
    document.removeEventListener("pointerdown", ptrHandler, true);
    document.removeEventListener("keydown", keyHandler, true);
  };
  const ptrHandler = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) cleanup();
  };
  const keyHandler = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") cleanup();
  };
  // Use two rAFs to ensure we're past all events from the triggering interaction
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.addEventListener("pointerdown", ptrHandler, true);
      document.addEventListener("keydown", keyHandler, true);
    });
  });
}
