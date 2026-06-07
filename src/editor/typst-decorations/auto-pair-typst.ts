// Wrap-on-selection for Typst formatting delimiters: *, _, `, $
// When the user types one of these characters:
//   - With a selection: wraps the selection (e.g. "word" → "*word*"),
//     matching the selection toolbar and Mod-b / Mod-i shortcuts which
//     "close around" the selected text.
//   - Without a selection: inserts a single character (NO auto-close).
//
// We deliberately do NOT auto-close these markup delimiters on a bare
// keystroke. Zettlr and Obsidian behave this way, and it is far more
// predictable: auto-closing on every keystroke made fixing existing
// markup surprising — e.g. with the cursor after the "d" in "*bol*d",
// typing "*" to add a closing star produced "*bol*d**". The real bracket
// and quote pairs ( [ { ' " still auto-close via CodeMirror's
// closeBrackets() extension, which is a separate code path.
//
// Triple backtick still expands to a code-block template (a deliberate
// 3-char gesture, also what Zettlr/Obsidian do).
// Respects the auto_pair_typst setting.

import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { settings } from "../../stores/settings";

const PAIR_CHARS = new Set(["*", "_", "`", "$"]);

export const autoPairTypstInput = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (!settings.editor.auto_pair_typst) return false;
    if (text.length !== 1 || !PAIR_CHARS.has(text)) return false;

    const { state } = view;
    const sel = state.selection.main;

    // Wrap a selection — the same "close around selected text" gesture the
    // toolbar and Mod-b/Mod-i shortcuts use.
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
    // insert the third backtick plus a code block template.
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

    // No selection: insert a single delimiter (no auto-close). Returning
    // false lets CodeMirror perform the normal single-character insert.
    return false;
  },
);
