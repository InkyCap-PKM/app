// Markdown-style typing shortcuts that expand into Typst function calls.
// These are typing conveniences only — the underlying source is always Typst.
//
//   "> "           at line start  →  #quote[<cursor>]
//   "+++"          alone on a line →  #line(length: 100%)
//   "++<text>++"   inline          →  #footnote[<text>]
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
  if (beforeCursor !== ">") return false;

  // The cursor lands inside #quote[] to let the user keep typing the body.
  // Without expandFunc, the visual plugin collapses #quote[…] into a pill that
  // replaces the whole call — the cursor then snaps to the pill's left edge
  // and subsequent keystrokes appear in reverse order. expandFunc keeps the
  // call expanded as long as the cursor is on this line.
  const insert = "#quote[]";
  view.dispatch({
    changes: { from: line.from, to: from, insert } as ChangeSpec,
    selection: { anchor: line.from + insert.length - 1 },
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

export const markdownShortcuts: Extension = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (from !== to) return false;
    if (text === " ") return handleSpace(view, from);
    if (text === "+") return handlePlus(view, from);
    return false;
  },
);
