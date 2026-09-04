import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { toggleEmphasis, toggleWrap } from "./wrap-format";

// `toggleWrap` is the single source of truth for the inline-format toggle rule
// shared by the keyboard shortcuts and the selection toolbar. The load-bearing
// invariant: invoking a format a SECOND time removes it rather than nesting
// another wrapper. The subtle case (Bug repro) is the visual editor, where the
// markup is decorated away so the user's selection covers only the inner text
// and the delimiters live just OUTSIDE the selection.
//
// Pure state transform — runs without the WASM Typst parser.
function apply(
  doc: string,
  anchor: number,
  head: number,
  before: string,
  after: string,
  caretInWrapper?: number,
) {
  const state = EditorState.create({ doc, selection: { anchor, head } });
  const spec = toggleWrap(state, before, after, caretInWrapper);
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

  // The link wrapper has an inner slot (the URL quotes) distinct from the
  // wrapped label, so `caretInWrapper` drops the caret there instead of
  // leaving the label selected. Mirrors the toolbar/Mod-k link action.
  const LINK_BEFORE = '#link("")[';
  const LINK_SLOT = '#link("'.length; // caret position between the quotes

  it("drops the caret in the URL slot when wrapping a selection as a link", () => {
    // Select "bar" in "foo bar baz".
    const r = apply("foo bar baz", 4, 7, LINK_BEFORE, "]", LINK_SLOT);
    expect(r.doc).toBe('foo #link("")[bar] baz');
    // Collapsed caret sits between the quotes, not on the "bar" label.
    expect([r.from, r.to]).toEqual([4 + LINK_SLOT, 4 + LINK_SLOT]);
    expect(r.doc.slice(r.from - 1, r.from + 1)).toBe('""');
  });

  it("drops the caret in the URL slot for an empty selection", () => {
    const r = apply("foo  baz", 4, 4, LINK_BEFORE, "]", LINK_SLOT);
    expect(r.doc).toBe('foo #link("")[] baz');
    expect([r.from, r.to]).toEqual([4 + LINK_SLOT, 4 + LINK_SLOT]);
  });

  it("still toggles a link off from outside the selection", () => {
    // Label "bar" selected, link markup decorated away around it.
    const doc = 'foo #link("https://x.test")[bar] baz';
    const from = doc.indexOf("bar");
    const r = apply(doc, from, from + 3, '#link("https://x.test")[', "]", LINK_SLOT);
    expect(r.doc).toBe("foo bar baz");
  });
});

// Typst reads `*` / `_` as bold/italic delimiters only when they are not
// wedged between two letters or digits, so `l'*a*ppropriation` does NOT bold
// the "a" — the run opened by the first `*` stays open past the second one.
// `toggleEmphasis` detects that position and writes `#strong[…]` / `#emph[…]`
// instead, which Typst reads the same way anywhere.
function emphasize(doc: string, anchor: number, head: number, marker: string, func: string) {
  const state = EditorState.create({ doc, selection: { anchor, head } });
  const next = state.update(toggleEmphasis(state, marker, func));
  return {
    doc: next.state.doc.toString(),
    from: next.state.selection.main.from,
    to: next.state.selection.main.to,
  };
}

describe("toggleEmphasis", () => {
  it("uses the shorthand when the markers land at word boundaries", () => {
    const r = emphasize("foo bar baz", 4, 7, "*", "strong");
    expect(r.doc).toBe("foo *bar* baz");
  });

  it("uses the shorthand when the neighbouring characters are not letters", () => {
    // The apostrophe before and the end of the line after both let a marker
    // read as a delimiter, even though the selection starts mid-"word".
    const doc = "l'appropriation";
    const from = doc.indexOf("appropriation");
    const r = emphasize(doc, from, doc.length, "*", "strong");
    expect(r.doc).toBe("l'*appropriation*");
  });

  it("uses the function form when only the closing marker lands inside a word", () => {
    // "appropri" selected: the opening marker follows an apostrophe and would
    // be fine, but the closing one would sit between "i" and "a".
    const doc = "l'appropriation";
    const from = doc.indexOf("appropriation");
    const r = emphasize(doc, from, from + "appropri".length, "*", "strong");
    expect(r.doc).toBe("l'#strong[appropri]ation");
  });

  it("uses #strong[…] for a single letter inside a word", () => {
    const doc = "l'appropriation collective";
    const from = doc.indexOf("appropriation");
    const r = emphasize(doc, from, from + 1, "*", "strong");
    expect(r.doc).toBe("l'#strong[a]ppropriation collective");
  });

  it("uses #emph[…] for a single letter inside a word", () => {
    const doc = "l'appropriation collective";
    const from = doc.indexOf("appropriation");
    const r = emphasize(doc, from, from + 1, "_", "emph");
    expect(r.doc).toBe("l'#emph[a]ppropriation collective");
  });

  it("uses the function form for an empty caret inside a word", () => {
    const doc = "appropriation";
    const r = emphasize(doc, 1, 1, "*", "strong");
    expect(r.doc).toBe("a#strong[]ppropriation");
    // Caret sits between the brackets, ready for typing.
    expect([r.from, r.to]).toEqual(["a#strong[".length, "a#strong[".length]);
  });

  it("keeps the shorthand for an empty caret at a word boundary", () => {
    const r = emphasize("foo  baz", 4, 4, "*", "strong");
    expect(r.doc).toBe("foo ** baz");
    expect([r.from, r.to]).toEqual([5, 5]);
  });

  it("keeps the shorthand between characters of a spaceless script", () => {
    // Typst's own rule exempts Han/Kana/Hangul, where a marker between two
    // characters is still a delimiter.
    const doc = "自由文化";
    const r = emphasize(doc, 1, 2, "*", "strong");
    expect(r.doc).toBe("自*由*文化");
  });

  it("toggles the shorthand back off", () => {
    // Inner text selected, markers decorated away outside it (visual mode).
    const r = emphasize("foo *bar* baz", 5, 8, "*", "strong");
    expect(r.doc).toBe("foo bar baz");
  });

  it("toggles the function form back off", () => {
    const doc = "l'#strong[a]ppropriation";
    const from = doc.indexOf("a]") ;
    const r = emphasize(doc, from, from + 1, "*", "strong");
    expect(r.doc).toBe("l'appropriation");
  });

  it("toggles off a hand-written function form captured in the selection", () => {
    const doc = "l'#emph[a]ppropriation";
    const from = doc.indexOf("#emph[");
    const r = emphasize(doc, from, from + "#emph[a]".length, "_", "emph");
    expect(r.doc).toBe("l'appropriation");
  });
});
