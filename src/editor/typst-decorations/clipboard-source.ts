// Copying from the visual editor, and pasting the copy back.
//
// The visual editor hides the backslash of a Typst escape, so
// `athena\@inkycap.org` reads as `athena@inkycap.org`. Text copied there goes
// on the clipboard as it reads, without those backslashes, so other
// applications get the plain address. The exact Typst source goes alongside it
// under a private clipboard type that other applications ignore, and a paste
// into InkyCap (any window, either mode) uses that, so the escapes survive.
//
// CodeMirror's own copy and cut run unchanged (whole-line copy with nothing
// selected, several cursors, cut); this rewrites what they put on the
// clipboard afterwards. CodeMirror's `clipboardOutputFilter` isn't used for
// it, because CodeMirror applies that filter to drags too, and dragging text
// within a note would then drop it without its escapes.
//
// Every paste handler reads the pasted text through `pastedText`, so a paste
// from InkyCap reaches each of them as Typst source.

import { EditorView, ViewPlugin } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** The private clipboard type holding the Typst source of a copy. */
export const TYPST_SOURCE_TYPE = "application/x-inkycap-typst";

/**
 * The text a paste inserts as Typst source: the private source when the copy
 * came from InkyCap, otherwise the plain text. Paste handlers use this rather
 * than reading `text/plain` themselves.
 */
export function pastedText(event: ClipboardEvent): string {
  const data = event.clipboardData;
  return data?.getData(TYPST_SOURCE_TYPE) || data?.getData("text/plain") || "";
}

/** The character a markup escape (`\@`, `\#`, `\u{e9}`) stands for. */
function escapedChar(escape: string): string {
  if (escape.startsWith("\\u{")) {
    const code = parseInt(escape.slice(3, -1), 16);
    return Number.isNaN(code) || code > 0x10ffff ? escape : String.fromCodePoint(code);
  }
  return escape.slice(1);
}

/** `from..to` as the visual editor shows it: each markup escape replaced by
 *  the character it stands for. Escapes inside strings are left alone. */
export function displayText(state: EditorState, from: number, to: number): string {
  let out = "";
  let pos = from;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name !== "Escape") return;
      if (node.from >= from && node.to <= to) {
        out += state.sliceDoc(pos, node.from) + escapedChar(state.sliceDoc(node.from, node.to));
        pos = node.to;
      }
      return false;
    },
  });
  return out + state.sliceDoc(pos, to);
}

/** The ranges CodeMirror copies: the non-empty selections, or with none, the
 *  line of each cursor. */
function copiedRanges(state: EditorState): { from: number; to: number }[] {
  const selected = state.selection.ranges.filter((r) => !r.empty);
  if (selected.length > 0) return selected;
  const lines: { from: number; to: number }[] = [];
  let upto = -1;
  for (const { from } of state.selection.ranges) {
    const line = state.doc.lineAt(from);
    if (line.number > upto) lines.push({ from: line.from, to: line.to });
    upto = line.number;
  }
  return lines;
}

interface PendingCopy {
  source: string;
  plain: string;
}

/**
 * Copy and cut in the visual editor: the clipboard's plain text loses the
 * escapes' backslashes, and the source goes under TYPST_SOURCE_TYPE.
 *
 * What to write is worked out before CodeMirror's handler runs, since a cut
 * deletes the text first, and written after it, since that handler clears the
 * clipboard. Nothing is rewritten unless CodeMirror copied exactly the source
 * expected, so a copy it declined or handled differently is left alone.
 */
export const visualCopy: Extension = ViewPlugin.fromClass(
  class {
    pending: PendingCopy | null = null;

    constructor(readonly view: EditorView) {
      view.dom.addEventListener("copy", this.write);
      view.dom.addEventListener("cut", this.write);
    }

    destroy() {
      this.view.dom.removeEventListener("copy", this.write);
      this.view.dom.removeEventListener("cut", this.write);
    }

    note(state: EditorState) {
      const ranges = copiedRanges(state);
      const source = ranges.map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
      const plain = ranges.map((r) => displayText(state, r.from, r.to)).join(state.lineBreak);
      this.pending = source === plain ? null : { source, plain };
    }

    write = (event: Event) => {
      const pending = this.pending;
      this.pending = null;
      const data = (event as ClipboardEvent).clipboardData;
      if (!pending || !data) return;
      // A nested editor (a table cell) inside this one has already written it.
      if (data.types.includes(TYPST_SOURCE_TYPE)) return;
      if (data.getData("text/plain") !== pending.source) return;
      data.setData(TYPST_SOURCE_TYPE, pending.source);
      data.setData("text/plain", pending.plain);
    };
  },
  {
    eventObservers: {
      copy(_event, view) { this.note(view.state); },
      cut(_event, view) { this.note(view.state); },
    },
  },
);

// The source of the paste being handled, for CodeMirror's own paste, which
// reads only `text/plain`. Cleared once the paste event has been handled.
let pendingPaste: PendingCopy | null = null;

/**
 * Pasting a copy made in InkyCap: CodeMirror's default paste inserts its
 * Typst source rather than the plain text. InkyCap's own paste handlers get
 * the same through `pastedText`.
 */
export const typstSourcePaste: Extension = [
  EditorView.domEventObservers({
    paste(event) {
      const source = event.clipboardData?.getData(TYPST_SOURCE_TYPE);
      if (!source) return;
      pendingPaste = { source, plain: event.clipboardData?.getData("text/plain") ?? "" };
      queueMicrotask(() => { pendingPaste = null; });
    },
  }),
  EditorView.clipboardInputFilter.of((text) =>
    pendingPaste && text === pendingPaste.plain ? pendingPaste.source : text,
  ),
];
