import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { toggleWrap } from "./wrap-format";

// `toggleWrap` is the single source of truth for the inline-format toggle rule
// shared by the keyboard shortcuts and the selection toolbar. The load-bearing
// invariant: invoking a format a SECOND time removes it rather than nesting
// another wrapper. The subtle case (Bug repro) is the visual editor, where the
// markup is decorated away so the user's selection covers only the inner text
// and the delimiters live just OUTSIDE the selection.
//
// Pure state transform — runs without the WASM Typst parser.
function apply(doc: string, anchor: number, head: number, before: string, after: string) {
  const state = EditorState.create({ doc, selection: { anchor, head } });
  const spec = toggleWrap(state, before, after);
  const next = state.update(spec);
  return {
    doc: next.state.doc.toString(),
    from: next.state.selection.main.from,
    to: next.state.selection.main.to,
  };
}

describe("toggleWrap", () => {
  it("wraps an unformatted selection", () => {
    // Select "bar" in "foo bar baz".
    const r = apply("foo bar baz", 4, 7, "*", "*");
    expect(r.doc).toBe("foo *bar* baz");
    expect([r.from, r.to]).toEqual([5, 8]); // selection now spans inner text
  });

  it("strips delimiters captured inside the selection (source-mode)", () => {
    // Select the whole "*bar*" including the asterisks.
    const r = apply("foo *bar* baz", 4, 9, "*", "*");
    expect(r.doc).toBe("foo bar baz");
    expect([r.from, r.to]).toEqual([4, 7]);
  });

  it("strips delimiters sitting just outside the selection (visual-mode, the bug)", () => {
    // Select only "bar" — the asterisks are decorated away in visual mode, so
    // they fall just outside the selection. Toggling must still remove them.
    const r = apply("foo *bar* baz", 5, 8, "*", "*");
    expect(r.doc).toBe("foo bar baz");
    expect([r.from, r.to]).toEqual([4, 7]);
  });

  it("toggles off a function-call wrapper from outside the selection", () => {
    // "#strike[bar]" with only "bar" selected.
    const doc = "foo #strike[bar] baz";
    const from = doc.indexOf("bar");
    const r = apply(doc, from, from + 3, "#strike[", "]");
    expect(r.doc).toBe("foo bar baz");
  });

  it("inserts an empty pair and places the caret inside for an empty selection", () => {
    const r = apply("foo  baz", 4, 4, "#strike[", "]");
    expect(r.doc).toBe("foo #strike[] baz");
    // Caret lands between the brackets, after "#strike[".
    expect([r.from, r.to]).toEqual([4 + "#strike[".length, 4 + "#strike[".length]);
  });

  it("does not toggle off when only one delimiter is present", () => {
    // Leading "*" but no trailing one → treated as unformatted, wraps.
    const r = apply("foo *bar baz", 5, 8, "*", "*");
    expect(r.doc).toBe("foo **bar* baz");
  });
});
