// CM6 word count tracker — publishes word/char counts to a Solid
// signal consumed by StatusBar.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { createSignal } from "solid-js";

export interface WordCountStats {
  words: number;
  chars: number;
  readingTime: number;
}

const EMPTY: WordCountStats = { words: 0, chars: 0, readingTime: 0 };

const [wordCountStats, setWordCountStats] = createSignal<WordCountStats>(EMPTY);
export { wordCountStats };

function compute(doc: { toString(): string; length: number }): WordCountStats {
  const text = doc.toString();
  const trimmed = text.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  return {
    words,
    chars: doc.length,
    readingTime: Math.max(1, Math.ceil(words / 200)),
  };
}

export const wordCountTracker = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      setWordCountStats(compute(view.state.doc));
    }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        setWordCountStats(compute(update.state.doc));
      }
    }
    destroy() {
      setWordCountStats(EMPTY);
    }
  },
);
