// Heading tracker: publishes the active document's headings to a Solid signal
// for OutlinePanel.
//
// Which lines are headings is decided by Typst's parser, through
// heading-scan.ts. This file turns a heading's markup into readable outline
// text and keeps the signal current without rescanning on every keystroke.
//
// Per CLAUDE.md's Typst-first principle: the display text is computed here
// rather than with `typst query`, because the outline updates as the user types
// and a compile per keystroke would add about 20ms; the editor's syntax tree
// already gives the structure.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { createSignal } from "solid-js";
import { rightPanelTab, rightCollapsed } from "../../stores/layout";
import { scanHeadings } from "./heading-scan";

export interface Heading {
  level: number;
  text: string;
  /** Byte offset in the CM6 document (for scrollIntoView). */
  pos: number;
}

const [headings, setHeadings] = createSignal<Heading[]>([]);
export { headings };

/**
 * Reduce a heading's inline markup to readable outline text. A heading that is
 * a wikilink (`=== #wikilink("Getting Started")`) reads "Getting Started", and
 * emphasis and content calls lose their syntax.
 *
 * Matches what the visual editor shows (a wikilink's `display:` or target; a
 * content call's body). Unmatched or unusual markup is left as is rather than
 * guessed at.
 */
export function headingDisplayText(raw: string): string {
  let s = raw;
  // Wikilinks → the `display:` alias when present, else the target name.
  s = s.replace(/#wikilink\(\s*"([^"]*)"([^)]*)\)/g, (_m, target, rest) => {
    const display = /display\s*:\s*"([^"]*)"/.exec(rest);
    return display ? display[1] : target;
  });
  // Links: a content bracket renders as its text; a bare link as its URL.
  s = s.replace(/#link\(\s*"[^"]*"\s*\)\s*\[([^\]]*)\]/g, (_m, text) => text);
  s = s.replace(/#link\(\s*"([^"]*)"\s*\)/g, (_m, url) => url);
  // Any other content-bracket call (`#strong[…]`, `#emph[…]`, `#highlight[…]`,
  // `#text(..)[…]`, unknown functions) becomes its body. The pattern excludes
  // nested brackets, so it matches the innermost call; repeating until nothing
  // changes unwraps nesting (`#strong[#highlight[x]]`).
  let prev: string;
  do {
    prev = s;
    s = s.replace(/#[a-zA-Z][\w-]*(?:\([^()]*\))?\s*\[([^[\]]*)\]/g, (_m, body) => body);
  } while (s !== prev);
  // Direct-formatting and raw markers carry no meaning in a plain outline.
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

/** Outline lives in the right panel under the "outline" tab. Reading these
 *  signals outside a reactive context just samples their current value. */
function outlinePaneOpen(): boolean {
  return rightPanelTab() === "outline" && !rightCollapsed();
}

function collectHeadings(state: EditorState): Heading[] {
  const out: Heading[] = [];
  for (const h of scanHeadings(state)) {
    const text = headingDisplayText(h.text);
    // A heading with no content yet — the `=` the writer just typed — would
    // otherwise flash an empty row into the outline as they type.
    if (!text) continue;
    out.push({ level: h.level, text, pos: h.from });
  }
  return out;
}

/**
 * Recompute an editor's headings now. Called by the outline pane when it opens
 * or the active editor changes, which the debounced `update` below doesn't
 * cover.
 */
export function rescanHeadings(view: EditorView | undefined): void {
  setHeadings(view ? collectHeadings(view.state) : []);
}

export const headingTracker = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      // Populate once on mount so the outline is correct the moment it opens.
      setHeadings(collectHeadings(view.state));
    }
    update(update: ViewUpdate) {
      // Only while the outline pane is open, and debounced so a long note isn't
      // rescanned on every key. The state is captured for the timer.
      //
      // A reparse without a document change can still move headings (closing a
      // code fence turns the text below back into markup), which the tree
      // reflects.
      const reparsed = syntaxTree(update.state) !== syntaxTree(update.startState);
      if ((!update.docChanged && !reparsed) || !outlinePaneOpen()) return;
      if (this.timer) clearTimeout(this.timer);
      const state = update.state;
      this.timer = setTimeout(() => {
        this.timer = null;
        setHeadings(collectHeadings(state));
      }, 150);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      setHeadings([]);
    }
  },
);
