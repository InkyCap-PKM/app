import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";
import { wikilinkSuggest } from "./wikilink-suggest";

// Regression guard for the `[[` wikilink shortcut. `closeBrackets()` lives in
// the editor's baseExtensions, ahead of the visual-mode wikilinkSuggest, so
// its inputHandler outranks the wikilink one unless the latter is raised to a
// higher precedence. When it loses, typing `[[` yields `[[]]` (a stray
// auto-paired `]]`) instead of the clean `[[` the picker expects — which is
// what broke the shortcut. This locks in that the wikilink handler wins.
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
  view.dispatch(view.state.replaceSelection(ch));
}

describe("[[ wikilink bracket input", () => {
  it("typing [[ yields a clean [[ (no auto-paired ]])", () => {
    const v = mk();
    typeChar(v, "[");
    typeChar(v, "[");
    expect(v.state.doc.toString()).toBe("[[");
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
