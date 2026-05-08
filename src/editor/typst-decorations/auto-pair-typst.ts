// Auto-pair Typst formatting delimiters: *, _, `, $
// When the user types one of these characters:
//   - With a selection: wraps the selection (e.g. "word" → "*word*")
//   - Without a selection: inserts pair and places cursor between
// When the cursor is immediately before the closing delimiter, typing
// the same character skips over it instead of inserting a duplicate.
// Backspace between an empty pair deletes both delimiters.
// Respects the auto_pair_typst setting.

import { EditorView, type KeyBinding } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { settings } from "../../stores/settings";

const PAIR_CHARS = new Set(["*", "_", "`", "$"]);

export const autoPairTypstInput = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (!settings.editor.auto_pair_typst) return false;
    if (text.length !== 1 || !PAIR_CHARS.has(text)) return false;

    const { state } = view;
    const sel = state.selection.main;

    if (sel.from !== sel.to) {
      const selected = state.doc.sliceString(sel.from, sel.to);
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text + selected + text },
        selection: EditorSelection.range(
          sel.from + 1,
          sel.to + 1,
        ),
      });
      return true;
    }

    // Triple backtick: when two backticks already precede the cursor,
    // insert the third backtick plus a code block template instead of
    // auto-pairing a fourth backtick.
    if (text === "`") {
      const before = state.doc.sliceString(Math.max(0, from - 2), from);
      if (before === "``") {
        view.dispatch({
          changes: { from, to, insert: "`\n\n```" },
          selection: EditorSelection.cursor(from + 2),
        });
        return true;
      }
    }

    const after = state.doc.sliceString(from, from + 1);
    if (after === text) {
      view.dispatch({
        selection: EditorSelection.cursor(from + 1),
      });
      return true;
    }

    view.dispatch({
      changes: { from, to, insert: text + text },
      selection: EditorSelection.cursor(from + 1),
    });
    return true;
  },
);

export const autoPairTypstBackspace: KeyBinding = {
  key: "Backspace",
  run(view) {
    if (!settings.editor.auto_pair_typst) return false;
    const { state } = view;
    const sel = state.selection.main;
    if (sel.from !== sel.to || sel.from === 0) return false;

    const before = state.doc.sliceString(sel.from - 1, sel.from);
    const after = state.doc.sliceString(sel.from, sel.from + 1);

    if (PAIR_CHARS.has(before) && before === after) {
      view.dispatch({
        changes: { from: sel.from - 1, to: sel.from + 1 },
        selection: EditorSelection.cursor(sel.from - 1),
      });
      return true;
    }
    return false;
  },
};
