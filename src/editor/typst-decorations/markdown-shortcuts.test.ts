import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownShortcuts } from "./markdown-shortcuts";
import { expandFunc } from "./effects";

// The task shortcut (`- [ ] ` / `- [x] `) becomes a bulleted `#task(...)` call,
// keeping the list marker: `- #task("")`, a task that is also a list item (issue
// #24). The new call must stay expanded (issue #23), so the text typed next goes
// into the string (`#task("Task text")`) rather than after a collapsed widget
// (`#task("")Task text`). That needs an `expandFunc` effect on the call's start
// (after the marker) and the caret between the quotes.

function mk(doc = "", anchor?: number) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: anchor !== undefined ? { anchor } : undefined,
      extensions: [markdownShortcuts],
    }),
    parent: document.body,
  });
}

/**
 * Run the shortcut input handler for one character and capture the transaction
 * it dispatches (to check effects, not just the text). Inserts plainly when no
 * handler takes it.
 */
function typeChar(view: EditorView, ch: string) {
  const handlers = view.state.facet(EditorView.inputHandler);
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update({ changes: { from, to, insert: ch } });
  for (const h of handlers) {
    if (h(view, from, to, ch, insert)) return;
  }
  view.dispatch(view.state.replaceSelection(ch));
}

/** A view that records the effects of every dispatched transaction. */
function recordingView(doc = "", anchor?: number) {
  const effects: unknown[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: anchor !== undefined ? { anchor } : undefined,
      extensions: [
        markdownShortcuts,
        EditorState.transactionExtender.of((tr) => {
          for (const e of tr.effects) effects.push(e);
          return null;
        }),
      ],
    }),
    parent: document.body,
  });
  return { view, effects };
}

describe("markdown-shortcuts: task checkbox", () => {
  it("expands `- [ ] ` into a bulleted `- #task(\"\")` with the caret between the quotes", () => {
    const v = mk("- [ ]", 5);
    typeChar(v, " ");
    expect(v.state.doc.toString()).toBe('- #task("")');
    // Caret sits just after the opening quote, ready for the description.
    expect(v.state.selection.main.head).toBe('- #task("'.length);
    v.destroy();
  });

  it("typing the description flows into the string, not after the call", () => {
    const v = mk("- [ ]", 5);
    typeChar(v, " ");
    for (const ch of "Buy milk") typeChar(v, ch);
    expect(v.state.doc.toString()).toBe('- #task("Buy milk")');
    v.destroy();
  });

  it("`- [x] ` marks the task done", () => {
    const v = mk("- [x]", 5);
    typeChar(v, " ");
    expect(v.state.doc.toString()).toBe('- #task("", done: true)');
    v.destroy();
  });

  it("preserves a `+` marker for ordered-list tasks", () => {
    const v = mk("+ [ ]", 5);
    typeChar(v, " ");
    expect(v.state.doc.toString()).toBe('+ #task("")');
    v.destroy();
  });

  it("dispatches expandFunc at the call start (past the marker) so it stays live-editable", () => {
    const { view, effects } = recordingView("- [ ]", 5);
    typeChar(view, " ");
    const expand = effects.filter((e) => (e as { is: (t: unknown) => boolean }).is(expandFunc));
    expect(expand).toHaveLength(1);
    // `- ` (marker + separator) precedes the `#`, so the call begins at offset 2.
    expect((expand[0] as { value: number }).value).toBe(2);
    view.destroy();
  });

  it("indented sub-task expands at the `#`, past the indentation and marker", () => {
    const { view, effects } = recordingView("  - [ ]", 7);
    typeChar(view, " ");
    expect(view.state.doc.toString()).toBe('  - #task("")');
    const expand = effects.filter((e) => (e as { is: (t: unknown) => boolean }).is(expandFunc));
    // Two spaces of indent + `- ` marker → the `#` (and expand target) at offset 4.
    expect((expand[0] as { value: number }).value).toBe(4);
    view.destroy();
  });
});
