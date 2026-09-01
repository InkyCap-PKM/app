import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownShortcuts } from "./markdown-shortcuts";
import { expandFunc } from "./effects";

// The task-checkbox shortcut (`- [ ] ` / `- [x] `) expands into a bulleted
// `#task(...)` call: the list marker is preserved so the result is
// `- #task("")`, a task that is itself a list item (issue #24 outliner
// workflow). The regression these tests also guard (issue #23): the newly
// inserted call must stay *expanded* (raw source visible) so the description the
// user keeps typing flows into the string argument — `#task("Task text")` —
// rather than landing after a collapsed widget as `#task("")Task text`. That
// relies on the dispatch carrying an `expandFunc` effect targeting the call's
// start (past the marker), and on the caret landing between the quotes.

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

/** Fire the shortcut input handler for a single character, capturing the
 *  transaction spec it dispatches (so we can inspect effects, not just the
 *  resulting doc). Falls back to a plain insert when no handler claims it. */
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
