import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import { buildDecorations, typstVisualMode } from "./visual-plugin";
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

describe("a `$` typed above other equations pairs with the next one", () => {
  // Typst pairs the new `$` with the next `$` anywhere below it, so the
  // parser reports a closed equation that spans lines of ordinary prose
  // until the writer types the real closing `$`. That transient state is
  // unavoidable; what matters is that it can only recolour text. Nothing may
  // be hidden or replaced across those lines, and the theme rule for the
  // marks must stay layout-neutral (checked below).
  const doc = `intro $ al\nmore text $ y $ end\nlast $z$ tail`;
  const caret = "intro $ al".length;

  it("emits only colour marks, never hides or replaces text", () => {
    const decos = decorations(doc, caret);
    expect(decos.length).toBeGreaterThan(0);
    for (const d of decos) expect(d).toMatch(/^cm-typst-math-(inline|display)\[/);
  });

  it("styles math marks without any layout-affecting property", () => {
    const theme = readFileSync("src/editor/typst-decorations/visual-theme.ts", "utf8");
    for (const cls of ["cm-typst-math-inline", "cm-typst-math-display"]) {
      const rule = theme.match(new RegExp(`"\\.${cls}": \\{([^}]*)\\}`))?.[1];
      expect(rule, `${cls} rule present`).toBeDefined();
      expect(rule).not.toMatch(/\b(display|padding|margin|minHeight|height|lineHeight|fontSize)\b/);
    }
  });
});

describe("an equation under the caret is plain source", () => {
  it("shows a display equation without its tint while the caret is inside", () => {
    const doc = `a $ x $ b${TAIL}`;
    expect(decorations(doc, 4)).toEqual([]);
  });
});

// Typing a lone `$` above a code block pairs it with the next `$` in the
// note, so for a moment the block parses as math. The writer must not see
// that: the lines below the caret keep their styling throughout, and the new
// equation is tinted only once the caret has left it.
describe("a `$` typed above other content leaves that content alone", () => {
  const RAW = "```html\ncode\n```";
  const DOC = `\n\n${RAW}\n\n$ x $`;

  function visible(state: EditorState): string[] {
    const out: string[] = [];
    for (const set of state.facet(EditorView.decorations)) {
      if (typeof set === "function") continue;
      const iter = set.iter();
      while (iter.value) {
        const spec = iter.value.spec ?? {};
        out.push(`${spec.class ?? (spec.widget ? "widget" : "hide")}[${iter.from},${iter.to}]`);
        iter.next();
      }
    }
    return out;
  }
  const codeBlock = (state: EditorState) => {
    const from = state.doc.toString().indexOf(RAW);
    return `widget[${from},${from + RAW.length}]`;
  };
  const type = (state: EditorState, text: string) => {
    const at = state.selection.main.head;
    return state.update({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length) }).state;
  };
  const moveTo = (state: EditorState, pos: number) =>
    state.update({ selection: EditorSelection.cursor(pos) }).state;

  it("keeps the code block and tints nothing below while the equation is open", () => {
    const start = EditorState.create({ doc: DOC, selection: EditorSelection.cursor(0), extensions: [typst(), typstVisualMode()] });
    expect(visible(start)).toContain(codeBlock(start));

    let state = type(start, "$");
    for (const ch of " a + b = ") state = type(state, ch);
    const firstLineEnd = state.doc.line(1).to;
    expect(visible(state)).toContain(codeBlock(state));
    // Nothing painted on the caret's line may reach past it; the tint the
    // lower equation already had simply moves with the text.
    const spills = visible(state).some((d) => {
      const [, from, to] = d.match(/\[(\d+),(\d+)\]$/)!.map(Number);
      return d.startsWith("cm-typst-math") && from <= firstLineEnd && to > firstLineEnd;
    });
    expect(spills).toBe(false);

    state = type(state, "$");
    expect(visible(state)).toContain(codeBlock(state));

    state = moveTo(state, state.doc.length);
    expect(visible(state)).toContain(codeBlock(state));
    expect(visible(state)).toContain("cm-typst-math-display[0,11]");
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
