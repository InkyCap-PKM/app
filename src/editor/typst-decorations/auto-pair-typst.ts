// Typing behaviour for the Typst delimiters *, _, ` and $.
//
// - With text selected, any of them wraps the selection ("word" → "*word*"),
//   like the toolbar and Mod-b / Mod-i.
// - *, _ and $ don't auto-close: closing them made fixing markup surprising
//   (after "d" in "*bol*d", typing "*" gave "*bol*d**"). Zettlr and Obsidian
//   behave the same.
// - ` auto-closes like CodeMirror's closeBrackets does for ( and [: "`" gives
//   "`|`", typing "`" before the inserted close steps over it, and Backspace in
//   an empty pair deletes both. An unclosed backtick swallows the rest of the
//   line as raw, so pairing is the safer default. It isn't handled by
//   closeBrackets, which treats it as a quote and closes it only after some
//   characters.
// - Three backticks expand to a code block template: "`" → "`|`", "`" → "``|"
//   (stepping over), "`" → the block.
//
// All of this follows the auto_pair_typst setting.

import { EditorView, keymap } from "@codemirror/view";
import { EditorSelection, type Extension } from "@codemirror/state";
import { settings } from "../../stores/settings";
import { dispatchVisible } from "./dispatch-visible";

const PAIR_CHARS = new Set(["*", "_", "`", "$"]);

// Characters before which a backtick still auto-closes: closeBrackets' `before`
// set plus common prose punctuation. Before a word character a single backtick
// is inserted, so a word isn't split.
const CLOSE_BEFORE = ")]}>:;,.!?\"'";

const autoPairInput = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (!settings.editor.auto_pair_typst) return false;
    if (text.length !== 1 || !PAIR_CHARS.has(text)) return false;

    const { state } = view;
    const sel = state.selection.main;

    // Wrap a selection — the same "close around selected text" gesture the
    // toolbar and Mod-b/Mod-i shortcuts use.
    if (sel.from !== sel.to) {
      const selected = state.doc.sliceString(sel.from, sel.to);
      dispatchVisible(view, {
        changes: { from: sel.from, to: sel.to, insert: text + selected + text },
        selection: EditorSelection.range(sel.from + 1, sel.to + 1),
      });
      return true;
    }

    // *, _, $ never auto-close on a bare keystroke — insert a single delimiter.
    if (text !== "`") return false;

    // Third backtick after two: insert it and a code block template. The caret
    // goes right after the opening fence, where the language goes (` ```typ `);
    // Enter there then steps into the body (see typstKeymap's Enter), so the
    // gesture is ``` → language → Enter → code.
    const before = state.doc.sliceString(Math.max(0, from - 2), from);
    if (before === "``") {
      dispatchVisible(view, {
        changes: { from, to, insert: "`\n\n```" },
        selection: EditorSelection.cursor(from + 1),
      });
      return true;
    }

    const next = state.doc.sliceString(from, from + 1);

    // Type-over: typing the closing backtick of a pair we (or the user) already
    // placed steps past it rather than inserting a second one.
    if (next === "`") {
      dispatchVisible(view, { selection: EditorSelection.cursor(from + 1) });
      return true;
    }

    // Auto-close at a boundary (line end, before whitespace or closing
    // punctuation), as closeBrackets does; mid-word, insert a single backtick.
    if (next === "" || /\s/.test(next) || CLOSE_BEFORE.includes(next)) {
      dispatchVisible(view, {
        changes: { from, to, insert: "``" },
        selection: EditorSelection.cursor(from + 1),
      });
      return true;
    }

    // No boundary and no selection: insert a single backtick.
    return false;
  },
);

// Backspace in an empty backtick pair deletes both, as closeBrackets does for
// its own brackets.
const deleteBacktickPair = keymap.of([
  {
    key: "Backspace",
    run: (view) => {
      if (!settings.editor.auto_pair_typst) return false;
      const { state } = view;
      const sel = state.selection.main;
      if (!sel.empty) return false;
      const before = state.doc.sliceString(sel.from - 1, sel.from);
      const after = state.doc.sliceString(sel.from, sel.from + 1);
      if (before !== "`" || after !== "`") return false;
      dispatchVisible(view, {
        changes: { from: sel.from - 1, to: sel.from + 1 },
        selection: EditorSelection.cursor(sel.from - 1),
        userEvent: "delete.backward",
      });
      return true;
    },
  },
]);

export const autoPairTypstInput: Extension = [autoPairInput, deleteBacktickPair];
