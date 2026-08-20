import { describe, it, expect } from "vitest";
import { EditorState, type Range } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { handleFuncCall } from "./visual-plugin";
import { FuncChipWidget, FuncPillWidget } from "./visual-widgets";

// Collapse rules for a generic `#func(...)` call in the visual editor.
//
// The motivating regression (issue #20): typing `#test_function(` in visual
// mode made the call vanish. `closeBrackets()` auto-inserts the `)` as soon as
// the `(` is typed, so a half-written call is already a *syntactically
// complete* FuncCall with the caret parked between the parens — and the
// arguments-only branch used to replace that range with a chip unconditionally,
// swallowing the caret before any argument had been typed.
//
// `handleFuncCall` reads the sliced source text rather than the syntax tree, so
// these run against a plain `EditorState` with no language configured — no
// syntax tree, and none needed.

/** Run the decorator over the whole of `doc`, with carets at `cursors`. */
function decorate(doc: string, cursors: number[]) {
  const state = EditorState.create({ doc });
  const decos: Range<Decoration>[] = [];
  const onCursor = true; // single-line docs here: the caret is always on the line
  const traverse = handleFuncCall(
    state,
    0,
    doc.length,
    decos,
    onCursor,
    new Set(cursors),
    /* autoExpand */ false,
    /* expandedPos */ null,
  );
  return { decos, traverse };
}

const widgetsIn = (decos: Range<Decoration>[]) =>
  decos.map((d) => d.value.spec.widget).filter(Boolean);

describe("arguments-only #func(...) collapse", () => {
  const CALL = "#test_function()";

  it("stays raw source while the caret sits between the parens", () => {
    // The exact mid-typing state autopair produces from `#test_function(`.
    const caret = CALL.indexOf("(") + 1;
    const { decos, traverse } = decorate(CALL, [caret]);
    expect(decos).toHaveLength(0);
    expect(traverse).toBe(false);
  });

  it("stays raw source while the caret is anywhere inside the call", () => {
    for (const caret of [0, 1, 5, CALL.length - 1, CALL.length]) {
      const { decos } = decorate(CALL, [caret]);
      expect(decos, `caret at ${caret}`).toHaveLength(0);
    }
  });

  it("still collapses to a chip once the caret leaves the call", () => {
    const doc = `${CALL} trailing prose`;
    const state = EditorState.create({ doc });
    const decos: Range<Decoration>[] = [];
    handleFuncCall(state, 0, CALL.length, decos, false, new Set([doc.length]), false, null);

    const widgets = widgetsIn(decos);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toBeInstanceOf(FuncChipWidget);
    expect((widgets[0] as FuncChipWidget).funcName).toBe("test_function");
    expect(decos[0].from).toBe(0);
    expect(decos[0].to).toBe(CALL.length);
  });

  it("keeps arguments typed after the auto-inserted paren visible", () => {
    // Partway through `#test_function(width: 3cm` — the caret has moved past
    // the `(` but is still inside the call, so nothing may collapse.
    const doc = "#test_function(width: 3cm)";
    const { decos } = decorate(doc, [doc.length - 1]);
    expect(decos).toHaveLength(0);
  });
});

describe("named calls that replace their whole range obey the same caret rule", () => {
  // `figure`, `line` and `bibliography` each have their own branch that
  // replaces the call's full source range with a chip or block widget. Each
  // reached that replace without consulting the caret, so hand-typing any of
  // them hit the identical mid-typing collapse the generic branch did — the
  // `/` palette's insertion path (which dispatches expandFunc) was the only
  // one that stayed open. Pinned per-name because each lives in its own case.
  const CALLS = ["#figure()", "#line()", "#bibliography()"];

  it("stays raw source while the caret is between the parens", () => {
    for (const call of CALLS) {
      const caret = call.indexOf("(") + 1;
      const { decos } = decorate(call, [caret]);
      expect(decos, call).toHaveLength(0);
    }
  });

  it("stays raw source while arguments are being typed", () => {
    const cases = [
      '#bibliography("refs.bib")',
      "#line(length: 100%)",
      '#figure(image("/a.png"))',
    ];
    for (const doc of cases) {
      const { decos } = decorate(doc, [doc.length - 1]);
      expect(decos, doc).toHaveLength(0);
    }
  });

  it("still collapses once the caret leaves", () => {
    for (const call of CALLS) {
      const doc = `${call}\n\nprose`;
      const state = EditorState.create({ doc });
      const decos: Range<Decoration>[] = [];
      handleFuncCall(state, 0, call.length, decos, false, new Set([doc.length]), false, null);
      // Each replaces the call range with its own widget — the chip for
      // figure/line, the block widget for bibliography.
      expect(decos.length, call).toBeGreaterThan(0);
      expect(decos[0].value.spec.widget, call).toBeTruthy();
      expect(decos[0].from, call).toBe(0);
    }
  });
});

describe("content-bracket #func[...] collapse is unchanged", () => {
  // A call with a `[…]` body keeps its established behaviour: pill + visible
  // body on the caret's line, markup hidden when away. Pinned here so the
  // arguments-only fix above can't be generalized into this branch by mistake.
  const CALL = "#unknownfunc[body text]";

  it("shows a pill and leaves the body live while on the caret line", () => {
    const { decos, traverse } = decorate(CALL, [CALL.indexOf("body")]);
    expect(traverse).toBe(true);
    const widgets = widgetsIn(decos);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toBeInstanceOf(FuncPillWidget);
  });

  it("hides the markup entirely when the caret is away", () => {
    const state = EditorState.create({ doc: CALL });
    const decos: Range<Decoration>[] = [];
    const traverse = handleFuncCall(state, 0, CALL.length, decos, false, new Set([]), false, null);
    expect(traverse).toBe(true);
    expect(widgetsIn(decos)).toHaveLength(0);
    // Opening markup and closing `]` hidden; the body between them survives.
    expect(decos).toHaveLength(2);
    expect(decos[0].from).toBe(0);
    expect(decos[0].to).toBe(CALL.indexOf("[") + 1);
    expect(decos[1].from).toBe(CALL.length - 1);
    expect(decos[1].to).toBe(CALL.length);
  });
});
