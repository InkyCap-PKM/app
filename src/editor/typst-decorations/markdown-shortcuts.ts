// Markdown-style typing shortcuts that expand into Typst calls; the source is
// always Typst.
//
//   "> "           at line start  →  #quote(block: true)[<cursor>]
//   "+++"          alone on a line →  #line(length: 100%)
//   "++<text>++"   inline          →  #footnote[<text>]
//   "- [ ] " / "- [x] " at line start → - #task("<cursor>") (done: true when x)
//
// Like `[[wikilink]]`, these map to calls that have no Typst markup. Typst's
// own markup (*, _, =, -, +, $) isn't aliased. Each fires only on the keystroke
// completing its pattern.

import { EditorView } from "@codemirror/view";
import type { ChangeSpec, Extension } from "@codemirror/state";
import { expandFunc } from "./effects";
import { dispatchVisible } from "./dispatch-visible";

const HR_INSERT = "#line(length: 100%)";

function handleSpace(view: EditorView, from: number): boolean {
  const line = view.state.doc.lineAt(from);
  const beforeCursor = view.state.doc.sliceString(line.from, from);

  // A Markdown task box becomes a task in a list item: the typed space starts
  // the body, so the line is the bare `- [ ]` / `- [x]` (indent and marker
  // kept), `x` means `done: true`, and the caret goes inside the string. Keeping
  // the marker (`- #task("")`) lets tasks nest and fold with the list (issue
  // #24).
  const task = beforeCursor.match(/^(\s*)([-+]) \[([ xX]?)\]$/);
  if (task) {
    const indent = task[1];
    const marker = task[2];
    const done = /[xX]/.test(task[3]);
    const call = done ? '#task("", done: true)' : '#task("")';
    // `- ` (marker + separator space) stays; the `[ ]` becomes the task call.
    const markerPrefix = `${marker} `;
    const insert = indent + markerPrefix + call;
    // The `#` of the inserted call sits just after the indentation and marker.
    const funcFrom = line.from + indent.length + markerPrefix.length;
    // Keep the new call expanded on the cursor line, as for `>`. Otherwise the
    // visual plugin turns `#task(…)` into its checkbox immediately and the text
    // typed next lands after the widget (`#task("")Task text`). Moving away
    // collapses it; the pill menu still offers done, due and label (issue #23).
    dispatchVisible(view, {
      changes: { from: line.from, to: from, insert } as ChangeSpec,
      selection: { anchor: funcFrom + '#task("'.length },
      effects: expandFunc.of(funcFrom),
    });
    return true;
  }

  if (beforeCursor !== ">") return false;

  // Text already after the `>` becomes the quote body.
  const rest = view.state.doc.sliceString(from, line.to);
  const prefix = "#quote(block: true)[";
  const insert = `${prefix}${rest}]`;

  // The caret goes at the start of the body. expandFunc keeps the call expanded
  // while the cursor is on the line; otherwise the quote collapses into a pill
  // and typing comes out reversed. `>` is a block quote in Markdown, so the
  // block form is used; the pill can switch it to inline.
  dispatchVisible(view, {
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
    dispatchVisible(view, {
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
  dispatchVisible(view, {
    changes: { from: start, to: from, insert } as ChangeSpec,
    selection: { anchor: start + insert.length },
  });
  return true;
}

// Lists form as in Markdown editors: the writer types the marker (`-`, `+`,
// `N.`) and a space, Typst parses it as a list item, and the visual layer draws
// the bullet. Enter then continues the list (see `continueList` in keymaps.ts).

export const markdownShortcuts: Extension = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (from !== to) return false;
    if (text === " ") return handleSpace(view, from);
    if (text === "+" && handlePlus(view, from)) return true;
    return false;
  },
);
