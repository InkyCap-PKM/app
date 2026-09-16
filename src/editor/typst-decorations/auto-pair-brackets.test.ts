// The "Auto-pair brackets" setting has to actually switch bracket pairing off.
//
// Both halves of the behaviour follow the setting: typing an opening bracket
// adds its partner, and Backspace between an empty pair removes both. The
// second half is why CodeMirror's own `closeBracketsKeymap` isn't used — it
// reads the characters around the caret, so it would keep deleting pairs long
// after pairing was switched off.

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { autoPairBracketsExtension, autoPairBracketsKeymap } from "./keymaps";

function mk(enabled: boolean, doc = "", anchor = doc.length) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        autoPairBracketsExtension(enabled),
        keymap.of([...autoPairBracketsKeymap, ...defaultKeymap]),
      ],
    }),
    parent: document.body,
  });
}

/** Type one character the way the editor does: input handlers first. */
function typeChar(view: EditorView, ch: string) {
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update({ changes: { from, to, insert: ch } });
  for (const handler of view.state.facet(EditorView.inputHandler)) {
    if (handler(view, from, to, ch, insert)) return;
  }
  view.dispatch(view.state.replaceSelection(ch));
}

function pressKey(view: EditorView, key: string) {
  runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
}

describe("auto-pair brackets: on", () => {
  it("adds the closing bracket and puts the caret between the pair", () => {
    const v = mk(true);
    typeChar(v, "(");
    expect(v.state.doc.toString()).toBe("()");
    expect(v.state.selection.main.head).toBe(1);
    v.destroy();
  });

  it("Backspace between an empty pair removes both halves", () => {
    const v = mk(true, "()", 1);
    pressKey(v, "Backspace");
    expect(v.state.doc.toString()).toBe("");
    v.destroy();
  });
});

describe("auto-pair brackets: off", () => {
  it("inserts only the bracket that was typed", () => {
    const v = mk(false);
    typeChar(v, "(");
    expect(v.state.doc.toString()).toBe("(");
    expect(v.state.selection.main.head).toBe(1);
    v.destroy();
  });

  it("leaves quotes alone too", () => {
    const v = mk(false);
    typeChar(v, '"');
    expect(v.state.doc.toString()).toBe('"');
    v.destroy();
  });

  it("Backspace deletes one character, not a pair the user typed themselves", () => {
    const v = mk(false, "()", 1);
    pressKey(v, "Backspace");
    expect(v.state.doc.toString()).toBe(")");
    v.destroy();
  });
});
