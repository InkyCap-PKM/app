// Annotation tracker: publishes the active document's `#annotation[…]` comments
// and `#suggestion(…)[…]` tracked changes to a Solid signal for the Annotations
// pane.
//
// Like `heading-tracker`, it scans in the editor (no `typst query`), since the
// pane needs the list immediately. It only runs while the Annotations pane is
// open, so editing costs nothing otherwise. The pane asks for a scan on open
// and tab switch (`rescanAnnotations`); this plugin keeps it current while
// open. It walks the same FuncCall nodes as the visual editor (with its field
// readers) but builds no DOM.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { createSignal } from "solid-js";
import { rightPanelTab, rightCollapsed } from "../../stores/layout";
import {
  extractNamedStringArg,
  extractBracketContent,
  extractBodyBracket,
  extractNamedBracket,
} from "./visual-plugin";

/** A `#suggestion` kind, or `"annotation"` for a `#review`-style comment. */
export type AnnotationKind = "annotation" | "insert" | "delete" | "replace";

export interface AnnotationEntry {
  /** Source start offset — used as the stable list key and the jump target. */
  from: number;
  /** Source end offset (the full call range). */
  to: number;
  kind: AnnotationKind;
  /** Author handle, if attributed (`by:`). */
  by: string;
  /** Date, if attributed (`on:`). */
  on: string;
  /** The annotation comment, or the suggestion's inserted/new text. */
  body: string;
  /** For a `replace` suggestion, the struck-out old text; "" otherwise. */
  oldText: string;
  /** A `#suggestion`'s reviewer comment (`note:`); "" for annotations. */
  note: string;
}

const [noteAnnotations, setNoteAnnotations] = createSignal<AnnotationEntry[]>([]);
export { noteAnnotations };

/** Whether the Annotations pane is currently visible (so a scan is worth it).
 *  Reading these signals outside a reactive context just samples their value. */
function paneOpen(): boolean {
  return rightPanelTab() === "annotations" && !rightCollapsed();
}

/**
 * Recompute an editor's list now. Called by the pane when it opens or the
 * active editor changes, which the `update` below (document edits only) doesn't
 * cover.
 */
export function rescanAnnotations(view: EditorView | undefined): void {
  setNoteAnnotations(view ? collectAnnotations(view.state) : []);
}

/** Walk the parsed document for `#annotation` / `#suggestion` calls. */
function collectAnnotations(state: EditorState): AnnotationEntry[] {
  const out: AnnotationEntry[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FuncCall") return;
      const text = state.doc.sliceString(node.from, node.to);
      const hashOffset = text.startsWith("#") ? 1 : 0;
      const nameEnd = text.indexOf("(", hashOffset);
      const bracketStart = text.indexOf("[", hashOffset);
      const delimIdx =
        nameEnd >= 0 && bracketStart >= 0
          ? Math.min(nameEnd, bracketStart)
          : nameEnd >= 0
            ? nameEnd
            : bracketStart;
      if (delimIdx < 0) return;
      const funcName = text.substring(hashOffset, delimIdx).trim();

      // The FuncCall node may start after the `#` (markup vs code context).
      // Include it in `from`, so removing the whole call doesn't leave a stray
      // `#` (invalid Typst).
      let from = node.from;
      if (hashOffset === 0 && from > 0 && state.doc.sliceString(from - 1, from) === "#") {
        from -= 1;
      }

      if (funcName === "annotation") {
        const body = extractBracketContent(text);
        if (body === null) return;
        out.push({
          from,
          to: node.to,
          kind: "annotation",
          by: extractNamedStringArg(text, "by") ?? "",
          on: extractNamedStringArg(text, "on") ?? "",
          body,
          oldText: "",
          note: "",
        });
      } else if (funcName === "suggestion") {
        const kind = (extractNamedStringArg(text, "kind") ?? "insert") as AnnotationKind;
        out.push({
          from,
          to: node.to,
          kind,
          by: extractNamedStringArg(text, "by") ?? "",
          on: extractNamedStringArg(text, "on") ?? "",
          body: extractBodyBracket(text) ?? "",
          oldText: kind === "replace" ? (extractNamedBracket(text, "old") ?? "") : "",
          note: extractNamedStringArg(text, "note") ?? "",
        });
      }
    },
  });
  return out;
}

export const annotationTracker = ViewPlugin.fromClass(
  class {
    // Keep the list current during edits, only while the pane is open. The pane
    // handles the first scan.
    update(update: ViewUpdate) {
      if (update.docChanged && paneOpen()) {
        setNoteAnnotations(collectAnnotations(update.state));
      }
    }
    destroy() {
      setNoteAnnotations([]);
    }
  },
);
