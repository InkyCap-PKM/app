import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";
import { autoPairTypstInput } from "./auto-pair-typst";

// These tests rely on the default `settings.editor.auto_pair_typst === true`
// (see stores/settings.ts DEFAULTS); the store isn't mutated elsewhere in the
// test process.
//
// The handler under test no longer auto-closes the Typst markup delimiters
// (* _ ` $) on a bare keystroke — only the real bracket/quote pairs do, via
// CodeMirror's closeBrackets(). Typing a delimiter with a selection still wraps
// it. This mirrors Zettlr/Obsidian and keeps editing existing markup
// predictable (typing `*` after a word adds one star, not two).

function mk(doc = "", anchor?: number, head?: number) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: anchor !== undefined
        ? { anchor, head: head ?? anchor }
        : undefined,
      // Mirror real precedence: closeBrackets first (as in baseExtensions),
      // autoPairTypstInput after.
      extensions: [closeBrackets(), autoPairTypstInput],
    }),
    parent: document.body,
  });
}

// CM6 runs the inputHandler facet highest-precedence first, stopping at the
// first handler that returns true — mirror that, falling back to a plain insert.
function typeChar(view: EditorView, ch: string) {
  const handlers = view.state.facet(EditorView.inputHandler);
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update({ changes: { from, to, insert: ch } });
  for (const h of handlers) {
    if (h(view, from, to, ch, insert)) return;
  }
  view.dispatch(view.state.replaceSelection(ch));
}

describe("auto-pair-typst: no bare-keystroke auto-close", () => {
  for (const ch of ["*", "_", "`", "$"]) {
    it(`typing "${ch}" with no selection inserts a single character`, () => {
      const v = mk();
      typeChar(v, ch);
      expect(v.state.doc.toString()).toBe(ch);
      expect(v.state.selection.main.head).toBe(1);
      v.destroy();
    });
  }

  it("the *bol*d fix: typing * after the d adds one star, not two", () => {
    const v = mk("*bol*d", 6, 6); // caret at end, just after "d"
    typeChar(v, "*");
    expect(v.state.doc.toString()).toBe("*bol*d*");
    expect(v.state.selection.main.head).toBe(7);
    v.destroy();
  });
});

describe("auto-pair-typst: selection wrapping is preserved", () => {
  it("typing * with a selection wraps it as *word* (inner text still selected)", () => {
    const v = mk("word", 0, 4);
    typeChar(v, "*");
    expect(v.state.doc.toString()).toBe("*word*");
    const sel = v.state.selection.main;
    expect(sel.from).toBe(1);
    expect(sel.to).toBe(5);
    v.destroy();
  });

  it("typing $ with a selection wraps it as $expr$", () => {
    const v = mk("x", 0, 1);
    typeChar(v, "$");
    expect(v.state.doc.toString()).toBe("$x$");
    v.destroy();
  });
});

describe("auto-pair-typst: triple backtick still expands a code block", () => {
  it("a third backtick after `` expands to a code-block template", () => {
    const v = mk();
    typeChar(v, "`"); // `
    typeChar(v, "`"); // ``
    typeChar(v, "`"); // expands
    expect(v.state.doc.toString()).toBe("```\n\n```");
    v.destroy();
  });

  it("leaves the caret on the fence so the language can be typed", () => {
    // Regression: the caret used to land on the body line (offset 4), so
    // naming the language meant backspacing back up to the fence — defeating
    // the point of opening a fenced block. It now sits just past the third
    // backtick.
    const v = mk();
    typeChar(v, "`");
    typeChar(v, "`");
    typeChar(v, "`");
    expect(v.state.selection.main.head).toBe(3);

    // And typing from there names the block, rather than filling its body.
    for (const ch of "typ") typeChar(v, ch);
    expect(v.state.doc.toString()).toBe("```typ\n\n```");
    v.destroy();
  });
});

describe("auto-pair-typst: real brackets still auto-close (closeBrackets)", () => {
  it('typing "(" still yields "()"', () => {
    const v = mk();
    typeChar(v, "(");
    expect(v.state.doc.toString()).toBe("()");
    expect(v.state.selection.main.head).toBe(1);
    v.destroy();
  });
});
