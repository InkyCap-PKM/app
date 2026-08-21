// CM6 heading tracker — publishes the active document's heading list
// to a Solid signal consumed by OutlinePanel.
//
// Which lines *are* headings is decided by Typst's own parser, through the
// shared scan in heading-scan.ts. What stays here is the presentation half:
// turning a heading's markup into the text a reader expects to see in the
// outline, and keeping the signal fresh without re-scanning on every
// keystroke.
//
// Why the display text is a local lexical pass and not a `typst query`
// round-trip: the outline updates alongside the editor as the user types.
// Routing each keystroke through the Tauri IPC boundary, the Typst compiler,
// and the introspector would add ~20ms of latency to every edit. CLAUDE.md's
// Typst-first principle allows custom code where the native path can't be
// reached; a synchronous surface can't wait on a compile, and the editor's
// in-process syntax tree already answers the structural half of the question.

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
 * Reduce a heading's inline Typst markup to the readable text a reader expects
 * in the outline — never the raw markup. A heading that is itself a wikilink
 * (`=== #wikilink("Getting Started")`) must read as "Getting Started", and the
 * common emphasis / content-call wrappers shouldn't leak their syntax either.
 *
 * This mirrors what the visual editor renders for the same constructs (a
 * wikilink shows its `display:` alias or its target; a content call shows its
 * body), kept as a small lexical pass because the outline is a synchronous,
 * per-keystroke surface — see the module header for why this file scans source
 * rather than routing through `typst query`. It is a presentation cleanup, not
 * a parser: unmatched or exotic markup is left as-is rather than guessed at.
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
  // `#strike[…]`, `#text(..)[…]`, unknown helpers) renders as its body. The
  // body pattern excludes nested brackets so the match is the innermost call;
  // looping until stable then unwraps nested markup (`#strong[#highlight[x]]`)
  // from the inside out.
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

/** Recompute the heading list for a given editor immediately. Called by the
 *  outline pane when it opens or the active editor changes — the live `update`
 *  hook below is gated to pane-open + debounced, so it doesn't cover those. */
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
      // Only while the outline pane is open (a closed pane costs nothing per
      // keystroke), and debounced so a multi-thousand-line note isn't fully
      // re-scanned on every key. Snapshot the immutable state for the timer.
      //
      // A reparse with no document change still moves headings: closing a code
      // fence turns everything below it back into markup, and the tree is what
      // tells us so.
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
