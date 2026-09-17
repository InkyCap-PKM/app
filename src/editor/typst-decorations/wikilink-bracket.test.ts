import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";
import { wikilinkSuggest } from "./wikilink-suggest";
import { inlineOnlyFacet, scopeRangeConfig, scopeRangeField } from "./cell-scope";
import { typst } from "codemirror-lang-typst";
import { buildDecorations } from "./visual-plugin";

// Regression guard for the `[[` wikilink shortcut. `closeBrackets()` lives in
// the editor's baseExtensions, ahead of the visual-mode wikilinkSuggest, so
// its inputHandler outranks the wikilink one unless the latter is raised to a
// higher precedence. When it loses, closeBrackets pairs the second `[` itself
// and the shortcut never records the `]]` as its own, so finishing the link
// leaves them behind. This locks in that the wikilink handler wins.
function mk() {
  return new EditorView({
    state: EditorState.create({
      doc: "",
      // Mirror real precedence: closeBrackets first (as in baseExtensions),
      // wikilinkSuggest after (as in visualExts).
      extensions: [closeBrackets(), wikilinkSuggest],
    }),
    parent: document.body,
  });
}

// CM6 runs the inputHandler facet highest-precedence first, stopping at the
// first handler that returns true — mirror that here.
function typeChar(view: EditorView, ch: string) {
  const handlers = view.state.facet(EditorView.inputHandler);
  const { from, to } = view.state.selection.main;
  // CM's inputHandler also receives an `insert` thunk (the transaction it
  // would otherwise apply); the handlers under test ignore it.
  const insert = () => view.state.update({ changes: { from, to, insert: ch } });
  for (const h of handlers) {
    if (h(view, from, to, ch, insert)) return;
  }
  // Tagged the way CodeMirror tags a real keystroke it applies itself, so the
  // `[[` shorthand can tell a bracket the user just typed from one already in
  // the note (see `typedOpenBracket` in wikilink-suggest.ts).
  view.dispatch(view.state.replaceSelection(ch), { userEvent: "input.type" });
}

describe("[[ wikilink bracket input", () => {
  it("typing [[ keeps the closing pair, with the caret in the middle", () => {
    // Balanced at every keystroke: an open `[[` with no closers would make the
    // parser pair the surrounding block's own `]` with the shorthand, and a
    // block quote or callout would lose its frame while the name is typed.
    const v = mk();
    typeChar(v, "[");
    typeChar(v, "[");
    expect(v.state.doc.toString()).toBe("[[]]");
    expect(v.state.selection.main.head).toBe(2);
    v.destroy();
  });

  it("wraps a selection as [[sel]] with the caret after sel", () => {
    const v = new EditorView({
      state: EditorState.create({
        doc: "cirfa",
        selection: { anchor: 0, head: 5 },
        extensions: [closeBrackets(), wikilinkSuggest],
      }),
      parent: document.body,
    });
    typeChar(v, "["); // closeBrackets wraps the selection → "[cirfa]"
    typeChar(v, "["); // forms the second bracket → "[[cirfa]]"
    expect(v.state.doc.toString()).toBe("[[cirfa]]");
    // Caret sits just after "cirfa", before the "]]", so the picker queries it.
    expect(v.state.selection.main.head).toBe(7);
    v.destroy();
  });
});

// A user who hand-types the closing `]]` (instead of picking from the popup)
// should still get a `#wikilink(...)` call — including for brand-new pages that
// aren't in the suggestion list yet.
describe("[[ wikilink manual close (]])", () => {
  function typeAll(v: EditorView, s: string) {
    for (const ch of s) typeChar(v, ch);
  }

  it("sealing [[Name]] with a typed ]] yields #wikilink(\"Name\")", () => {
    const v = mk();
    typeAll(v, "[[Name]]");
    expect(v.state.doc.toString()).toBe('#wikilink("Name")');
    // Caret lands just after the call so typing continues outside the link.
    expect(v.state.selection.main.head).toBe('#wikilink("Name")'.length);
    v.destroy();
  });

  it("does not fire on the first ] (only the closing pair completes the link)", () => {
    const v = mk();
    typeAll(v, "[[Name]");
    // The first `]` steps over one of the parked closers; the text is still
    // the plain brackets, not a call.
    expect(v.state.doc.toString()).toBe("[[Name]]");
    expect(v.state.selection.main.head).toBe(7);
    v.destroy();
  });

  it("keeps a block quote's frame intact while the name is typed", () => {
    const v = new EditorView({
      state: EditorState.create({
        doc: "#quote(block: true)[Hello ]",
        selection: { anchor: "#quote(block: true)[Hello ".length },
        extensions: [closeBrackets(), wikilinkSuggest],
      }),
      parent: document.body,
    });
    typeAll(v, "[[Na");
    // The quote's own closing bracket is still the last one, so the block
    // parses as a whole and the visual layer keeps drawing it.
    expect(v.state.doc.toString()).toBe("#quote(block: true)[Hello [[Na]]]");
    const drawn = EditorState.create({ doc: v.state.doc, selection: v.state.selection, extensions: [typst()] });
    const classes: string[] = [];
    const iter = buildDecorations(drawn).iter();
    while (iter.value) { classes.push(iter.value.spec?.class ?? ""); iter.next(); }
    expect(classes.join(" ")).toContain("cm-typst-blockquote-line");
    typeAll(v, "]]");
    expect(v.state.doc.toString()).toBe('#quote(block: true)[Hello #wikilink("Na")]');
    v.destroy();
  });

  it("leaves an empty [[]] as literal text", () => {
    const v = mk();
    typeAll(v, "[[]]");
    expect(v.state.doc.toString()).toBe("[[]]");
    v.destroy();
  });
});

// A block quote, callout or any other `#func[…]` call puts a `[` right behind
// the caret and a `]` right ahead of it — the same shape as a half-typed `[[`.
// The shorthand used to adopt that opening bracket, and finishing the link then
// ate the block's closing one, leaving `#quote(block: true)[#wikilink("Name")`
// with nothing to close it.
describe("[[ wikilink inside a block's own brackets", () => {
  /** `marked` is the note with `|` standing in for the caret. */
  function typeInside(marked: string, typed: string): string {
    const anchor = marked.indexOf("|");
    const v = new EditorView({
      state: EditorState.create({
        doc: marked.replace("|", ""),
        selection: { anchor },
        extensions: [closeBrackets(), wikilinkSuggest],
      }),
      parent: document.body,
    });
    for (const ch of typed) typeChar(v, ch);
    const out = v.state.doc.toString();
    v.destroy();
    return out;
  }

  it("leaves a block quote's closing bracket in place", () => {
    expect(typeInside("#quote(block: true)[|]", "[[Name]]"))
      .toBe('#quote(block: true)[#wikilink("Name")]');
  });

  it("leaves a callout's closing bracket in place", () => {
    expect(typeInside('#callout("note")[|]', "[[Name]]"))
      .toBe('#callout("note")[#wikilink("Name")]');
  });

  it("does not treat the block's own `[` as the first bracket of the pair", () => {
    // One typed `[` is just a bracket: auto-pairing closes it, and the block
    // keeps its own `]`.
    expect(typeInside("#quote(block: true)[|]", "[")).toBe("#quote(block: true)[[]]");
  });

  it("still forms the link when the block is nested inside another", () => {
    expect(typeInside("#quote(block: true)[#strong[|]]", "[[Name]]"))
      .toBe('#quote(block: true)[#strong[#wikilink("Name")]]');
  });
});

// Inside a table cell editor (inline-only mode) the cell's brackets have to
// stay balanced at every keystroke, or the table around it stops parsing.
describe("[[ wikilink brackets inside a cell editor", () => {
  function mkCell() {
    return new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [closeBrackets(), wikilinkSuggest, inlineOnlyFacet.of(true)],
      }),
      parent: document.body,
    });
  }
  function typeAll(v: EditorView, s: string) {
    for (const ch of s) typeChar(v, ch);
  }

  it("typing [[ keeps the closing pair, with the caret in the middle", () => {
    const v = mkCell();
    typeAll(v, "[[");
    expect(v.state.doc.toString()).toBe("[[]]");
    expect(v.state.selection.main.head).toBe(2);
    v.destroy();
  });

  it("a hand-typed ]] seals the link and leaves no stray bracket", () => {
    const v = mkCell();
    typeAll(v, "[[Name]]");
    expect(v.state.doc.toString()).toBe('#wikilink("Name")');
    v.destroy();
  });

  it("does not mistake the cell's own opening bracket for the first [ of [[", () => {
    const v = new EditorView({
      state: EditorState.create({
        doc: "[a]",
        selection: { anchor: 1 },
        extensions: [closeBrackets(), wikilinkSuggest, inlineOnlyFacet.of(true), scopeRangeConfig.of({ from: 1, to: 2 }), scopeRangeField],
      }),
      parent: document.body,
    });
    typeChar(v, "[");
    expect(v.state.doc.toString()).toBe("[[a]");
    typeChar(v, "[");
    expect(v.state.doc.toString()).toBe("[[[]]a]");
    expect(v.state.selection.main.head).toBe(3);
    v.destroy();
  });
});
