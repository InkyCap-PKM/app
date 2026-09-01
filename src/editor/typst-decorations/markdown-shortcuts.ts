// Markdown-style typing shortcuts that expand into Typst function calls.
// These are typing conveniences only — the underlying source is always Typst.
//
//   "> "           at line start  →  #quote(block: true)[<cursor>]
//   "+++"          alone on a line →  #line(length: 100%)
//   "++<text>++"   inline          →  #footnote[<text>]
//   "- [ ] " / "- [x] " at line start → #task("<cursor>") (done: true when x)
//
// The pattern follows the same philosophy as the [[wikilink]] shortcut:
// trigger sequences map to function calls that have no native Typst markup.
// Direct-formatting markup (*, _, =, -, +, $) is NOT aliased — those round-
// trip through the visual editor as Typst-native syntax.
//
// Triggers fire only on the exact keystroke that completes the pattern, so
// partially-typed prefixes never cause surprise expansions.

import { EditorView } from "@codemirror/view";
import type { ChangeSpec, Extension } from "@codemirror/state";
import { expandFunc } from "./effects";

const HR_INSERT = "#line(length: 100%)";

function handleSpace(view: EditorView, from: number): boolean {
  const line = view.state.doc.lineAt(from);
  const beforeCursor = view.state.doc.sliceString(line.from, from);

  // Markdown task checkbox → #task(...). The just-typed space starts the body,
  // so the line so far is the bare `- [ ]` / `- [x]` marker (indentation kept).
  // `x`/`X` inside the box maps to `done: true`; the caret lands inside the
  // body string so the user types the task text next.
  const task = beforeCursor.match(/^(\s*)[-+] \[([ xX]?)\]$/);
  if (task) {
    const indent = task[1];
    const done = /[xX]/.test(task[2]);
    const insert = done ? '#task("", done: true)' : '#task("")';
    // The `#` of the inserted call sits just after any indentation.
    const funcFrom = line.from + indent.length;
    // Keep the fresh call expanded on the cursor line, exactly like the `>`
    // quote branch below. Without this, the visual plugin collapses `#task(…)`
    // into its checkbox widget the instant the call is complete — the caret
    // placed between the quotes then has no live text to sit in, so the task
    // description the user keeps typing lands *after* the widget
    // (`#task("")Task text` instead of `#task("Task text")`). expandFunc reveals
    // the raw source while the cursor stays on the line, so typing flows into
    // the string; moving away collapses it back to the widget. The pill menu
    // (right-click / click) remains available for done/due/label. See issue #23.
    view.dispatch({
      changes: { from: line.from, to: from, insert: indent + insert } as ChangeSpec,
      selection: { anchor: funcFrom + '#task("'.length },
      effects: expandFunc.of(funcFrom),
    });
    return true;
  }

  if (beforeCursor !== ">") return false;

  // Any text already on the line (to the right of the `>`) is the intended
  // quote body — wrap it inside the brackets rather than stranding an empty
  // `[]` before it. On a blank line `rest` is empty and this collapses to the
  // old `#quote(block: true)[]` with the caret between the brackets.
  const rest = view.state.doc.sliceString(from, line.to);
  const prefix = "#quote(block: true)[";
  const insert = `${prefix}${rest}]`;

  // The cursor lands at the start of the body (just after `[`) so the user can
  // keep typing before any wrapped text.
  // Without expandFunc, the visual plugin collapses #quote[…] into a pill that
  // replaces the whole call — the cursor then snaps to the pill's left edge
  // and subsequent keystrokes appear in reverse order. expandFunc keeps the
  // call expanded as long as the cursor is on this line.
  // Markdown's `>` is semantically a blockquote — map to the form that
  // actually renders attribution and gets block styling. The pill's
  // Inline option lets the user demote to `#quote[…]` after the fact.
  view.dispatch({
    changes: { from: line.from, to: line.to, insert } as ChangeSpec,
    selection: { anchor: line.from + prefix.length },
    effects: expandFunc.of(line.from),
  });
  return true;
}

function handlePlus(view: EditorView, from: number): boolean {
  const line = view.state.doc.lineAt(from);
  const beforeCursor = view.state.doc.sliceString(line.from, from);

  // +++ on a line by itself → horizontal rule
  if (beforeCursor === "++") {
    view.dispatch({
      changes: { from: line.from, to: from, insert: HR_INSERT } as ChangeSpec,
      selection: { anchor: line.from + HR_INSERT.length },
    });
    return true;
  }

  // ++text++ → footnote. The just-typed "+" closes a "++…+" run.
  if (!beforeCursor.endsWith("+")) return false;
  const inText = beforeCursor.slice(0, -1);

  // Find the rightmost "++" with at least one char of content after it.
  let openIdx = -1;
  for (let i = inText.length - 3; i >= 0; i--) {
    if (inText[i] === "+" && inText[i + 1] === "+") {
      openIdx = i;
      break;
    }
  }
  if (openIdx < 0) return false;

  const content = inText.slice(openIdx + 2);
  // A "++" inside the content means the user is mid-stride on a different
  // pair; bail out rather than carve a footnote across the wrong boundary.
  if (content.includes("++")) return false;

  const start = line.from + openIdx;
  const insert = `#footnote[${content}]`;
  view.dispatch({
    changes: { from: start, to: from, insert } as ChangeSpec,
    selection: { anchor: start + insert.length },
  });
  return true;
}

// The CriticMarkup typing shortcuts were all removed. The highlight run
// (`{==…==}` → #highlight) could never fire — `{` is auto-paired by
// closeBrackets, so the closing `}` is typed over rather than inserted and the
// input handler never saw it. The suggestion/annotation runs ({++…++}, {--…--},
// {~~…~~}, {>>…<<}) were dropped earlier for being unfriendly to author by
// hand. All of these primitives (`#highlight`, `#annotation`, `#suggestion`)
// remain available via the `/` slash menu, the command palette, and the
// Annotations pane — only the delimiter-run typing shortcuts are gone.

// Lists form the same way as in markdown editors: the writer types the marker
// (`-`, `+`, or `N.`) followed by a space themselves. Typst's parser then
// recognizes `- `/`+ `/`N. ` as a list item and the visual layer renders the
// bullet or number — no marker character is treated specially on its own. Once
// a list has started, pressing Enter continues it with a fresh marker (see
// `continueList` in keymaps.ts), matching the Obsidian-style flow.

export const markdownShortcuts: Extension = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (from !== to) return false;
    if (text === " ") return handleSpace(view, from);
    if (text === "+" && handlePlus(view, from)) return true;
    return false;
  },
);
