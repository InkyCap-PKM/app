// CM6 annotation tracker — publishes the active document's list of
// `#annotation[…]` comments and `#suggestion(…)[…]` tracked changes to a Solid
// signal consumed by the right-panel Annotations pane.
//
// Like `heading-tracker`, this is a CM-side scan (no `typst query` round-trip):
// the list is lexical and the pane needs it synchronously. To stay light, the
// scan only runs **while the Annotations pane is open** — when it's closed (the
// common case) editing costs nothing here. The pane triggers an initial scan on
// open / tab-switch via `rescanAnnotations`; this plugin keeps it live during
// edits while it's open. The walk visits the same Lezer FuncCall nodes the
// visual editor uses (and reuses its field extractors) but builds no DOM, so it
// is far cheaper than the decoration pass it piggybacks on.

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
}

const [noteAnnotations, setNoteAnnotations] = createSignal<AnnotationEntry[]>([]);
export { noteAnnotations };

/** Whether the Annotations pane is currently visible (so a scan is worth it).
 *  Reading these signals outside a reactive context just samples their value. */
function paneOpen(): boolean {
  return rightPanelTab() === "annotations" && !rightCollapsed();
}

/** Recompute the list for a given editor immediately. Called by the pane when
 *  it opens or the active editor changes — the cases the live `update` hook
 *  below doesn't cover (it only fires on document edits). */
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

      if (funcName === "annotation") {
        const body = extractBracketContent(text);
        if (body === null) return;
        out.push({
          from: node.from,
          to: node.to,
          kind: "annotation",
          by: extractNamedStringArg(text, "by") ?? "",
          on: extractNamedStringArg(text, "on") ?? "",
          body,
          oldText: "",
        });
      } else if (funcName === "suggestion") {
        const kind = (extractNamedStringArg(text, "kind") ?? "insert") as AnnotationKind;
        out.push({
          from: node.from,
          to: node.to,
          kind,
          by: extractNamedStringArg(text, "by") ?? "",
          on: extractNamedStringArg(text, "on") ?? "",
          body: extractBodyBracket(text) ?? "",
          oldText: kind === "replace" ? (extractNamedBracket(text, "old") ?? "") : "",
        });
      }
    },
  });
  return out;
}

export const annotationTracker = ViewPlugin.fromClass(
  class {
    // Keep the list live during edits — but only when the pane is open, so a
    // closed pane costs nothing per keystroke. The pane handles the initial
    // scan on open / tab-switch via `rescanAnnotations`.
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
