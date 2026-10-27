import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers, keymap } from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap } from "@codemirror/commands";
import { autoPairTypstInput } from "./auto-pair-typst";

// These rely on the default `settings.editor.auto_pair_typst === true` (see
// DEFAULTS in stores/settings.ts); nothing else in the test run changes it.
//
// The delimiters * _ $ don't auto-close: typing one after a word adds a single
// delimiter. The backtick does, like a bracket (with type-over and
// delete-both), because an unclosed backtick turns the rest of the line into
// raw text. Typing any delimiter with a selection wraps it.

function mk(doc = "", anchor?: number, head?: number) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: anchor !== undefined
        ? { anchor, head: head ?? anchor }
        : undefined,
      // Same order as the real editor: closeBrackets first (as in
      // baseExtensions), then autoPairTypstInput (input handler and its own
      // Backspace), then the shared keymaps.
      extensions: [
        closeBrackets(),
        autoPairTypstInput,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap]),
      ],
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

// Runs the registered keymaps for a key, the way the real editor does on a
// keypress — used to exercise the Backspace delete-both binding.
function pressKey(view: EditorView, key: string) {
  runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
}

describe("auto-pair-typst: no bare-keystroke auto-close for * _ $", () => {
  for (const ch of ["*", "_", "$"]) {
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

describe("auto-pair-typst: backtick auto-closes like a bracket", () => {
  it("typing ` on an empty line inserts a pair with the caret between", () => {
    const v = mk();
    typeChar(v, "`");
    expect(v.state.doc.toString()).toBe("``");
    expect(v.state.selection.main.head).toBe(1);
    v.destroy();
  });

  it("typing ` before whitespace closes the pair", () => {
    const v = mk("a  b", 2, 2); // caret between the two spaces
    typeChar(v, "`");
    expect(v.state.doc.toString()).toBe("a `` b");
    expect(v.state.selection.main.head).toBe(3);
    v.destroy();
  });

  it("typing the closing ` steps over the auto-inserted one", () => {
    const v = mk();
    typeChar(v, "`"); // `|`
    for (const ch of "code") typeChar(v, ch); // `code|`
    typeChar(v, "`"); // steps past the close rather than adding one
    expect(v.state.doc.toString()).toBe("`code`");
    expect(v.state.selection.main.head).toBe(6);
    v.destroy();
  });

  it("mid-word (before a letter) inserts a single backtick", () => {
    const v = mk("word", 2, 2); // caret inside the word
    typeChar(v, "`");
    expect(v.state.doc.toString()).toBe("wo`rd");
    expect(v.state.selection.main.head).toBe(3);
    v.destroy();
  });

  it("Backspace between an empty pair deletes both backticks", () => {
    const v = mk();
    typeChar(v, "`"); // `|`
    pressKey(v, "Backspace");
    expect(v.state.doc.toString()).toBe("");
    expect(v.state.selection.main.head).toBe(0);
    v.destroy();
  });

  it("typing ` around a selection wraps it as `code`", () => {
    const v = mk("code", 0, 4);
    typeChar(v, "`");
    expect(v.state.doc.toString()).toBe("`code`");
    const sel = v.state.selection.main;
    expect(sel.from).toBe(1);
    expect(sel.to).toBe(5);
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
    // The caret goes just after the third backtick, where the language is
    // typed, not onto the body line (offset 4).
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
