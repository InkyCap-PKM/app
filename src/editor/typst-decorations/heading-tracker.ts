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
      out.push({ level: m[1].length, text: m[2].trimEnd(), pos });
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
