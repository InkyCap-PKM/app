// Typing behaviour for the Typst formatting delimiters *, _, `, $.
//
// Selection wrap (all four): typing a delimiter with text selected wraps the
// selection (e.g. "word" → "*word*"), matching the selection toolbar and
// Mod-b / Mod-i shortcuts which "close around" the selected text.
//
// *, _, $ — no auto-close on a bare keystroke. We deliberately do NOT close
// these on every keystroke: auto-closing made fixing existing markup
// surprising — e.g. with the cursor after the "d" in "*bol*d", typing "*" to
// add a closing star produced "*bol*d**". Zettlr and Obsidian behave this way
// and it is far more predictable.
//
// ` (backtick) — auto-closes into a pair, exactly like CodeMirror's
// closeBrackets does for ( and [. Typing "`" inserts "`|`" with the caret
// between the pair; typing "`" again immediately before the auto-inserted
// closing backtick steps over it instead of adding a stray one; Backspace
// between an empty pair deletes both. Backtick is worth closing because, unlike
// the other delimiters, an unclosed one parses as a raw span that swallows the
// rest of the line, so pairing it is the less surprising default. Backtick does
// NOT go through closeBrackets: that treats it as a quote and only closes it
// after certain characters, which reads as inconsistent next to ( and [.
//
// Triple backtick still expands to a code-block template (a deliberate 3-char
// gesture, also what Zettlr/Obsidian do). It composes with the pairing above:
// "`" → "`|`", "`" → "``|" (steps over the close), "`" → the block template.
//
// All of this respects the auto_pair_typst setting.

import { EditorView, keymap } from "@codemirror/view";
import { EditorSelection, type Extension } from "@codemirror/state";
import { settings } from "../../stores/settings";

const PAIR_CHARS = new Set(["*", "_", "`", "$"]);

// Characters the caret may sit before and still have a backtick auto-close.
// Mirrors closeBrackets' `before` set (closing brackets, punctuation) plus the
// prose punctuation a writer commonly types inline code ahead of. When the next
// character is a word character instead, we insert a single backtick so we
// don't split a word the user is typing through.
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
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text + selected + text },
        selection: EditorSelection.range(sel.from + 1, sel.to + 1),
      });
      return true;
    }

    // *, _, $ never auto-close on a bare keystroke — insert a single delimiter.
    if (text !== "`") return false;

    // Triple backtick: when two backticks already precede the cursor, insert
    // the third plus a code-block template.
    //
    // The caret lands immediately *after* the opening fence, not on the body
    // line — the language tag is the next thing a writer types, and it belongs
    // on the fence (` ```typ `). Dropping into the body first forced a
    // backspace-and-retype to name the language, which is the whole point of
    // fencing a block. Enter on the fence line then steps down into the body
    // rather than adding another blank line (see typstKeymap's Enter binding),
    // so the full gesture is: ``` → language → Enter → code.
    const before = state.doc.sliceString(Math.max(0, from - 2), from);
    if (before === "``") {
      view.dispatch({
        changes: { from, to, insert: "`\n\n```" },
        selection: EditorSelection.cursor(from + 1),
      });
      return true;
    }

    const next = state.doc.sliceString(from, from + 1);

    // Type-over: typing the closing backtick of a pair we (or the user) already
    // placed steps past it rather than inserting a second one.
    if (next === "`") {
      view.dispatch({ selection: EditorSelection.cursor(from + 1) });
      return true;
    }

    // Auto-close into a pair when the caret sits at a natural boundary — end of
    // line, before whitespace, or before closing punctuation — the same rule
    // closeBrackets applies to ( and [. Mid-word, fall through to a single
    // backtick so we don't split what the user is writing.
    if (next === "" || /\s/.test(next) || CLOSE_BEFORE.includes(next)) {
      view.dispatch({
        changes: { from, to, insert: "``" },
        selection: EditorSelection.cursor(from + 1),
      });
      return true;
    }

    // No boundary and no selection: insert a single backtick.
    return false;
  },
);

// Backspace between an empty backtick pair deletes both, matching how
// closeBrackets' deleteBracketPair handles ( ) and [ ]. closeBrackets only
// tracks its own bracket set, so we handle the backtick pair here.
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
      view.dispatch({
        changes: { from: sel.from - 1, to: sel.from + 1 },
        selection: EditorSelection.cursor(sel.from - 1),
        userEvent: "delete.backward",
      });
      return true;
    },
  },
]);

export const autoPairTypstInput: Extension = [autoPairInput, deleteBacktickPair];
