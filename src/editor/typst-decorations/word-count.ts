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
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      setWordCountStats(compute(view.state.doc));
    }
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      // Debounced: the status bar's word count doesn't need per-keystroke
      // precision, and recomputing it means a full-document `toString()` +
      // whitespace split on every key — expensive on a long note. Snapshot
      // the immutable doc and recompute once typing settles.
      if (this.timer) clearTimeout(this.timer);
      const doc = update.state.doc;
      this.timer = setTimeout(() => {
        this.timer = null;
        setWordCountStats(compute(doc));
      }, 300);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      setWordCountStats(EMPTY);
    }
  },
);
