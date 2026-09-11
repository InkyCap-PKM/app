import { describe, it, expect, beforeAll } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import { TableWidget, tableWidgetAt } from "./table-widget";
import { typstVisualMode } from "./visual-plugin";

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

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: 0 }, extensions: [typst(), typstVisualMode()] }),
    parent,
  });
}

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
});
