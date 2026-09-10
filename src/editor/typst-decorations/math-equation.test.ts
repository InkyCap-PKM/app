import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";
import { buildDecorations } from "./visual-plugin";
import { computeProtectedRanges } from "./visual-protected";

// Typst's parser is error-tolerant: a lone `$` (or `/*`) already opens a node
// that runs to the end of the document. Decorating one of those half-typed
// nodes restyles every line below it — the reported symptom was the text and
// caret jumping down a line while typing `$ al$` and snapping back once the
// equation closed. These pin that a delimiter only takes effect once its
// partner exists, and that display vs inline follows Typst's own rule.

const TAIL = "\ntrailing text";

/** Every decoration in the visual build, as `class[from,to]` strings. */
function decorations(doc: string, caret: number): string[] {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [typst()],
  });
  const out: string[] = [];
  const iter = buildDecorations(state).iter();
  while (iter.value) {
    const cls = iter.value.spec?.class ?? "hide";
    out.push(`${cls}[${iter.from},${iter.to}]`);
    iter.next();
  }
  return out;
}

/** True when any decoration reaches past `limit` — i.e. spills onto later lines. */
function spillsPast(doc: string, caret: number, limit: number): boolean {
  return decorations(doc, caret).some((d) => Number(d.match(/,(\d+)\]$/)![1]) > limit);
}

describe("half-typed equations stay undecorated", () => {
  for (const head of ["$", "$ ", "$ a", "$ al"]) {
    it(`leaves the document alone after typing ${JSON.stringify(head)}`, () => {
      expect(decorations(head + TAIL, head.length)).toEqual([]);
    });
  }

  it("does not reach past an unclosed `$` when the caret is elsewhere", () => {
    const doc = `text $ x more${TAIL}`;
    expect(spillsPast(doc, 0, 5)).toBe(false);
    expect(decorations(doc, 0)).toEqual([]);
  });

  it("does not hide the last character of the document for an unclosed `$`", () => {
    // The old code hid `node.to - 1 … node.to`, which for a document-spanning
    // equation node was the final character of the note.
    const doc = `text $x more${TAIL}`;
    expect(decorations(doc, 0)).toEqual([]);
  });
});

describe("display vs inline follows Typst's spacing rule", () => {
  it("sets an equation as a block when both delimiters are padded", () => {
    const doc = `a $ x $ b${TAIL}`;
    expect(decorations(doc, doc.length)).toContain("cm-typst-math-display[2,7]");
  });

  it("treats a multi-line equation as a block", () => {
    const doc = `$\n x \n$${TAIL}`;
    expect(decorations(doc, doc.length)).toContain("cm-typst-math-display[0,7]");
  });

  it("keeps `$ x$` inline — Typst needs a space inside both delimiters", () => {
    const doc = `a $ x$ b${TAIL}`;
    const decos = decorations(doc, doc.length);
    expect(decos.some((d) => d.startsWith("cm-typst-math-display"))).toBe(false);
    expect(decos).toContain("cm-typst-math-inline[3,5]");
  });

  it("keeps `$x$` inline", () => {
    const doc = `a $x$ b${TAIL}`;
    expect(decorations(doc, doc.length)).toContain("cm-typst-math-inline[3,4]");
  });
});

describe("half-typed block comments stay visible", () => {
  it("does not hide or lock the rest of the note after `/*`", () => {
    const doc = `/* oops${TAIL}`;
    const state = EditorState.create({ doc, extensions: [typst()] });
    expect(decorations(doc, 7)).toEqual([]);
    expect(computeProtectedRanges(state, null)).toEqual([]);
  });

  it("still hides and locks a closed block comment", () => {
    const doc = `/* ok */${TAIL}`;
    const state = EditorState.create({ doc, extensions: [typst()] });
    expect(decorations(doc, doc.length)).toEqual(["hide[0,9]"]);
    expect(computeProtectedRanges(state, null)).toEqual([{ from: 0, to: 9 }]);
  });

  it("still hides a line comment", () => {
    const doc = `// ok${TAIL}`;
    expect(decorations(doc, doc.length)).toEqual(["hide[0,6]"]);
  });

  it("does not hide or lock after `/*` typed above a note that ends in a closed comment", () => {
    // Block comments nest, so the new opener swallows the old comment and its
    // closer, leaving one unclosed comment that happens to end with `*/`.
    const doc = `/*${TAIL}\n/* old */`;
    const state = EditorState.create({ doc, extensions: [typst()] });
    expect(decorations(doc, doc.length)).toEqual([]);
    expect(computeProtectedRanges(state, null)).toEqual([]);
  });

  it("still hides a closed comment with another nested inside it", () => {
    const doc = `/* a /* b */ c */${TAIL}`;
    const state = EditorState.create({ doc, extensions: [typst()] });
    expect(decorations(doc, doc.length)).toEqual(["hide[0,18]"]);
    expect(computeProtectedRanges(state, null)).toEqual([{ from: 0, to: 18 }]);
  });
});
