import { describe, it, expect, beforeAll } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import { history, undo } from "@codemirror/commands";
import { TableWidget, tableWidgetAt, activeCellEditors } from "./table-widget";
import { buildDecorations, typstVisualMode } from "./visual-plugin";
import { cellEditorConfig } from "./table-cell-editor";

// The visual layer maps the table's decoration through edits made elsewhere
// in the note, but the widget instance keeps the offsets it was built with.
// Every write back to the source has to resolve the live range, or a row
// insert after typing a paragraph above the table lands on the wrong text.

const TABLE = "#table(\n  columns: (auto, auto, auto),\n  [a], [b], [c],\n  [d], [e], [f],\n)";

beforeAll(() => {
  // jsdom has no ResizeObserver; the widget uses one to keep its resize
  // handles aligned, which is irrelevant here.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

/** The smallest cell-editor setup: the language plus the inline visual layer. */
const cellConfig = cellEditorConfig.of({
  extensions: () => [typst(), typstVisualMode({ inlineOnly: true })],
  inlineDecorations: (state, from, to) => buildDecorations(state, [{ from, to }], { inlineOnly: true }),
});

function mount(doc: string, withCellEditor = false): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [typst(), typstVisualMode(), withCellEditor ? cellConfig : []],
    }),
    parent,
  });
}

function cellDiv(view: EditorView, row: number, col: number): HTMLElement {
  const rows = view.dom.querySelectorAll<HTMLElement>("tr[data-logical-row]");
  const cells = rows[row].querySelectorAll<HTMLElement>("th, td:not(.cm-table-row-handle-cell)");
  return cells[col].querySelector<HTMLElement>(".cm-typst-table-cell")!;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function findTable(view: EditorView): { from: number; to: number; widget: TableWidget } {
  let found: { from: number; to: number; widget: TableWidget } | null = null;
  for (const set of view.state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    set.between(0, view.state.doc.length, (from, to, deco) => {
      if (deco.spec?.widget instanceof TableWidget) found = { from, to, widget: deco.spec.widget };
    });
  }
  if (!found) throw new Error("no table widget in the decoration set");
  return found;
}

/** Reach a private structural operation the way a menu action would. */
type Internals = {
  liveRange(view: EditorView): { from: number; to: number };
  moveColumn(view: EditorView, from: number, to: number): void;
  insertRow(view: EditorView, at: number): void;
};

describe("TableWidget", () => {
  it("resolves its live range after an edit above the table", () => {
    const view = mount("hello\n\n" + TABLE + "\n");
    const before = findTable(view);
    view.dispatch({ changes: { from: 0, insert: "XXXX" }, selection: { anchor: 4 } });
    const after = findTable(view);
    expect(after.widget).toBe(before.widget);
    expect(after.widget.from).toBe(before.from);
    expect((after.widget as unknown as Internals).liveRange(view)).toEqual({ from: after.from, to: after.to });
    view.destroy();
  });

  it("writes a structural change to the moved table, not the old offsets", () => {
    const view = mount("hello\n\n" + TABLE + "\n");
    view.dispatch({ changes: { from: 0, insert: "XXXX" }, selection: { anchor: 4 } });
    (findTable(view).widget as unknown as Internals).insertRow(view, 1);
    expect(view.state.doc.toString()).toBe(
      "XXXXhello\n\n#table(\n  columns: (auto, auto, auto),\n  [a], [b], [c],\n  [], [], [],\n  [d], [e], [f],\n)\n",
    );
    view.destroy();
  });

  it("moves a column past its neighbours instead of swapping with the target", () => {
    const view = mount(TABLE);
    (findTable(view).widget as unknown as Internals).moveColumn(view, 0, 2);
    expect(view.state.doc.toString()).toBe(
      "#table(\n  columns: (auto, auto, auto),\n  [b], [c], [a],\n  [e], [f], [d],\n)",
    );
    view.destroy();
  });

  it("finds the widget behind a rendered wrapper, after the table has moved", () => {
    const view = mount("hello\n\n" + TABLE + "\n");
    view.dispatch({ changes: { from: 0, insert: "XXXX" }, selection: { anchor: 4 } });
    const wrap = view.dom.querySelector<HTMLElement>(".cm-typst-table-wrap");
    expect(wrap).not.toBeNull();
    expect(tableWidgetAt(view, wrap!)).toBe(findTable(view).widget);
    expect(tableWidgetAt(view, document.createElement("div"))).toBeNull();
    view.destroy();
  });

  it("paints an idle cell as it reads in the visual editor", () => {
    const view = mount("#table(\n  columns: (auto, auto),\n  [*bold* text], [plain],\n)", true);
    const cell = cellDiv(view, 0, 0);
    expect(cell.textContent).toBe("bold text");
    expect(cell.querySelector(".cm-typst-bold")?.textContent).toBe("bold");
    expect(cellDiv(view, 0, 1).textContent).toBe("plain");
    view.destroy();
  });

  it("edits a cell in place: typing reaches the note, note edits reach the cell", async () => {
    const view = mount("hello\n\n" + TABLE + "\n", true);
    cellDiv(view, 1, 0).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const [editor] = activeCellEditors(view);
    expect(editor).toBeDefined();
    expect(editor.range).toEqual({ from: view.state.doc.toString().indexOf("[d]") + 1, to: view.state.doc.toString().indexOf("[d]") + 2 });

    editor.view.dispatch({ changes: { from: editor.range!.to, insert: "X" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("[dX], [e], [f]");
    expect(editor.view.state.doc.toString()).toBe(view.state.doc.toString());
    // The widget adopted the change without rebuilding: the editor is the same one.
    expect(activeCellEditors(view)[0]).toBe(editor);

    view.dispatch({ changes: { from: 0, insert: "YY" } });
    expect(editor.view.state.doc.toString()).toBe(view.state.doc.toString());
    expect(editor.range).toEqual({ from: view.state.doc.toString().indexOf("[dX]") + 1, to: view.state.doc.toString().indexOf("[dX]") + 3 });
    view.destroy();
  });

  it("keeps edits inside the cell", () => {
    const view = mount(TABLE, true);
    cellDiv(view, 0, 0).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const [editor] = activeCellEditors(view);
    const before = view.state.doc.toString();
    // Deleting the cell's opening bracket would break the table: dropped.
    editor.view.dispatch({ changes: { from: editor.range!.from - 1, to: editor.range!.from, insert: "" } });
    expect(view.state.doc.toString()).toBe(before);
    // The caret cannot leave the cell either.
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(editor.view.state.selection.main.head).toBe(editor.range!.from);
    view.destroy();
  });

  it("appends a row when Tab runs off the end, and edits its first cell", async () => {
    const view = mount(TABLE, true);
    cellDiv(view, 1, 2).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const [editor] = activeCellEditors(view);
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(view.state.doc.toString()).toBe(
      "#table(\n  columns: (auto, auto, auto),\n  [a], [b], [c],\n  [d], [e], [f],\n  [], [], [],\n)",
    );
    await flush();
    const [next] = activeCellEditors(view);
    expect(next).toBeDefined();
    expect(next).not.toBe(editor);
    const at = view.state.doc.toString().lastIndexOf("[], [], []") + 1;
    expect(next.range).toEqual({ from: at, to: at });
    view.destroy();
  });

  it("types over a selected cell", () => {
    const view = mount(TABLE, true);
    const wrap = view.dom.querySelector<HTMLElement>(".cm-typst-table-wrap")!;
    cellDiv(view, 0, 1).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    wrap.focus();
    wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    expect(view.state.doc.toString()).toContain("[a], [x], [c]");
    expect(activeCellEditors(view)[0].range).toEqual({
      from: view.state.doc.toString().indexOf("[x]") + 1,
      to: view.state.doc.toString().indexOf("[x]") + 2,
    });
    view.destroy();
  });

  it("closes the cell editor when focus leaves the table, painting the new content", () => {
    const view = mount(TABLE, true);
    cellDiv(view, 0, 0).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const [editor] = activeCellEditors(view);
    editor.view.dispatch({ changes: { from: editor.range!.to, insert: " *b*" } });
    const wrap = view.dom.querySelector<HTMLElement>(".cm-typst-table-wrap")!;
    wrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: view.contentDOM }));
    expect(activeCellEditors(view)).toHaveLength(0);
    const cell = cellDiv(view, 0, 0);
    expect(cell.textContent).toBe("a b");
    expect(cell.querySelector(".cm-typst-bold")?.textContent).toBe("b");
    view.destroy();
  });

  it("undoes a cell edit through the note's history and mirrors it back", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: TABLE,
        extensions: [typst(), typstVisualMode(), cellConfig, history()],
      }),
      parent,
    });
    cellDiv(view, 0, 0).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const [editor] = activeCellEditors(view);
    editor.view.dispatch({ changes: { from: editor.range!.to, insert: "Z" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("[aZ]");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(TABLE);
    expect(editor.view.state.doc.toString()).toBe(TABLE);
    expect(editor.range).toEqual({ from: TABLE.indexOf("[a]") + 1, to: TABLE.indexOf("[a]") + 2 });
    view.destroy();
  });

  it("parks the note's caret at the table while a cell is edited", () => {
    const view = mount("hello\n\n" + TABLE + "\n", true);
    expect(view.state.selection.main.head).toBe(0);
    cellDiv(view, 1, 0).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const end = view.state.doc.toString().indexOf("\n)") + 2;
    expect(view.state.selection.main.head).toBe(end);
    view.destroy();
  });

  it("keeps the table and its cell editor through an unbalanced keystroke", () => {
    const view = mount(TABLE, true);
    cellDiv(view, 0, 0).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const [editor] = activeCellEditors(view);
    const wrap = view.dom.querySelector(".cm-typst-table-wrap");
    // A lone `[` before the content: the cell is `[[a]`, which no longer parses.
    editor.view.dispatch({ changes: { from: editor.range!.from, insert: "[" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("[[a], [b]");
    expect(activeCellEditors(view)[0]).toBe(editor);
    expect(view.dom.querySelector(".cm-typst-table-wrap")).toBe(wrap);
    // A stray closer on top: the tree may not even show the call now.
    editor.view.dispatch({ changes: { from: editor.range!.from + 1, insert: "]]" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("[[]]a], [b]");
    expect(activeCellEditors(view)[0]).toBe(editor);
    expect(view.dom.querySelector(".cm-typst-table-wrap")).toBe(wrap);
    editor.view.dispatch({ changes: { from: editor.range!.from + 1, to: editor.range!.from + 3, insert: "" }, userEvent: "input.type" });
    // Closing it parses again and the same editor carries on.
    editor.view.dispatch({ changes: { from: editor.range!.from + 1, insert: "]" }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toContain("[[]a], [b]");
    expect(activeCellEditors(view)[0]).toBe(editor);
    expect(view.dom.querySelector(".cm-typst-table-wrap")).toBe(wrap);
    view.destroy();
  });

  it("can drop explicit row heights so rows fit their content", () => {
    const view = mount("#table(\n  columns: (auto, auto),\n  rows: (auto, 30pt),\n  [a], [b],\n  [c], [d],\n)");
    (findTable(view).widget as unknown as { clearRowSizes(view: EditorView): void }).clearRowSizes(view);
    expect(view.state.doc.toString()).toBe("#table(\n  columns: (auto, auto),\n  [a], [b],\n  [c], [d],\n)");
    view.destroy();
  });

  it("drops a bare rows: value too, which Typst applies to every row", () => {
    const view = mount("#table(\n  columns: (auto, auto),\n  rows: 24pt,\n  [a], [b],\n)");
    (findTable(view).widget as unknown as { clearRowSizes(view: EditorView): void }).clearRowSizes(view);
    expect(view.state.doc.toString()).toBe("#table(\n  columns: (auto, auto),\n  [a], [b],\n)");
    view.destroy();
  });

  it("resets explicit column widths to auto", () => {
    const view = mount("#table(\n  columns: (30pt, 1fr),\n  [a], [b],\n)");
    (findTable(view).widget as unknown as { resetColumnWidths(view: EditorView): void }).resetColumnWidths(view);
    expect(view.state.doc.toString()).toBe("#table(\n  columns: (auto, auto),\n  [a], [b],\n)");
    view.destroy();
  });

  it("selects every cell from the corner handle", () => {
    const view = mount(TABLE);
    const corner = view.dom.querySelector<HTMLElement>(".cm-table-corner-handle")!;
    corner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.dom.querySelectorAll(".cm-typst-table-cell--selected")).toHaveLength(6);
    expect(document.activeElement).toBe(view.dom.querySelector(".cm-typst-table-wrap"));
    view.destroy();
  });

  it("deletes the table and the line break after it", () => {
    const view = mount("before\n" + TABLE + "\nafter\n");
    const wrap = view.dom.querySelector<HTMLElement>(".cm-typst-table-wrap")!;
    const st = { view, wrap } as unknown as never;
    // deleteTable resolves the range itself; only the view is read from the state object.
    (findTable(view).widget as unknown as { deleteTable(st: never): void }).deleteTable(st);
    expect(view.state.doc.toString()).toBe("before\nafter\n");
    view.destroy();
  });
});
