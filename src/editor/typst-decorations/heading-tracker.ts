// CM6 heading tracker — publishes the active document's heading list
// to a Solid signal consumed by OutlinePanel.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { createSignal } from "solid-js";

export interface Heading {
  level: number;
  text: string;
  /** Byte offset in the CM6 document (for scrollIntoView). */
  pos: number;
}

const [headings, setHeadings] = createSignal<Heading[]>([]);
export { headings };

const HEADING_RE = /^(={1,6})\s+(.+)$/;

function collectHeadings(doc: { toString(): string }): Heading[] {
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

export const headingTracker = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      setHeadings(collectHeadings(view.state.doc));
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        setHeadings(collectHeadings(update.state.doc));
      }
    }
    destroy() {
      setHeadings([]);
    }
  },
);
