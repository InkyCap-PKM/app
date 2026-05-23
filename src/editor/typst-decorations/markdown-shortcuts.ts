// Markdown-style typing shortcuts that expand into Typst function calls.
// These are typing conveniences only — the underlying source is always Typst.
//
//   "> "           at line start  →  #quote(block: true)[<cursor>]
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
  // Markdown's `>` is semantically a blockquote — map to the form that
  // actually renders attribution and gets block styling. The pill's
  // Inline option lets the user demote to `#quote[…]` after the fact.
  const insert = "#quote(block: true)[]";
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

// CriticMarkup typing shortcuts → InkyCap primitives, completed by the final
// `}`. Suggestions map to `#suggestion(...)`; CriticMarkup's comment + highlight
// map to the existing `#annotation` / `#highlight` (their natural Typst homes), so
// the whole CriticMarkup input vocabulary expands to native calls. `{` is not
// auto-paired, so the user types the full delimiter run.
//
//   {++ins++}        → #suggestion(kind: "insert")[ins]
//   {--del--}        → #suggestion(kind: "delete")[del]
//   {~~old~>new~~}   → #suggestion(kind: "replace", old: [old])[new]
//   {>>comment<<}    → #annotation[comment]
//   {==highlight==}  → #highlight[highlight]
const CRITIC_PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => string }[] = [
  { re: /\{~~([\s\S]*?)~>([\s\S]*?)~~\}$/, build: (m) => `#suggestion(kind: "replace", old: [${m[1]}])[${m[2]}]` },
  { re: /\{\+\+([\s\S]*?)\+\+\}$/, build: (m) => `#suggestion(kind: "insert")[${m[1]}]` },
  { re: /\{--([\s\S]*?)--\}$/, build: (m) => `#suggestion(kind: "delete")[${m[1]}]` },
  { re: /\{>>([\s\S]*?)<<\}$/, build: (m) => `#annotation[${m[1]}]` },
  { re: /\{==([\s\S]*?)==\}$/, build: (m) => `#highlight[${m[1]}]` },
];

function handleBrace(view: EditorView, from: number): boolean {
  const line = view.state.doc.lineAt(from);
  const beforeCursor = view.state.doc.sliceString(line.from, from);
  for (const { re, build } of CRITIC_PATTERNS) {
    const m = beforeCursor.match(re);
    if (!m) continue;
    const start = line.from + (beforeCursor.length - m[0].length);
    const insert = build(m);
    view.dispatch({
      changes: { from: start, to: from, insert } as ChangeSpec,
      // Cursor after the call so the mark renders and typing continues.
      selection: { anchor: start + insert.length },
    });
    return true;
  }
  return false;
}

export const markdownShortcuts: Extension = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (from !== to) return false;
    if (text === " ") return handleSpace(view, from);
    if (text === "+") return handlePlus(view, from);
    if (text === "}") return handleBrace(view, from);
    return false;
  },
);
