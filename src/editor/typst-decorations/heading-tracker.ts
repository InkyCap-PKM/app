// CM6 heading tracker — publishes the active document's heading list
// to a Solid signal consumed by OutlinePanel.
//
// Why this is a CM-side regex scan and not a `typst query` round-trip:
// the outline panel updates on every keystroke and renders alongside the
// editor. Routing each keystroke through the Tauri IPC boundary, the
// Typst compiler, and the introspector would add ~20ms of latency to every
// edit for an outline that's authoritatively defined by `=` markers — a
// purely lexical signal. CLAUDE.md's Typst-first principle ends with "as a
// last resort or if necessary to accomplish something important"; this is
// the "necessary" case — the live editor needs synchronous data, and the
// answer is in the source text we already hold.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { createSignal } from "solid-js";
import { rightPanelTab, rightCollapsed } from "../../stores/layout";

export interface Heading {
  level: number;
  text: string;
  /** Byte offset in the CM6 document (for scrollIntoView). */
  pos: number;
}

const [headings, setHeadings] = createSignal<Heading[]>([]);
export { headings };

const HEADING_RE = /^(={1,6})\s+(.+)$/;

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

function collectHeadings(doc: Text): Heading[] {
  const text = doc.toString();
  const out: Heading[] = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m) {
      out.push({ level: m[1].length, text: headingDisplayText(m[2]), pos });
    }
    pos += line.length + 1;
  }
  return out;
}

/** Recompute the heading list for a given editor immediately. Called by the
 *  outline pane when it opens or the active editor changes — the live `update`
 *  hook below is gated to pane-open + debounced, so it doesn't cover those. */
export function rescanHeadings(view: EditorView | undefined): void {
  setHeadings(view ? collectHeadings(view.state.doc) : []);
}

export const headingTracker = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      // Populate once on mount so the outline is correct the moment it opens.
      setHeadings(collectHeadings(view.state.doc));
    }
    update(update: ViewUpdate) {
      // Only while the outline pane is open (a closed pane costs nothing per
      // keystroke), and debounced so a multi-thousand-line note isn't fully
      // re-scanned on every key. Snapshot the immutable doc for the timer.
      if (!update.docChanged || !outlinePaneOpen()) return;
      if (this.timer) clearTimeout(this.timer);
      const doc = update.state.doc;
      this.timer = setTimeout(() => {
        this.timer = null;
        setHeadings(collectHeadings(doc));
      }, 150);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      setHeadings([]);
    }
  },
);
