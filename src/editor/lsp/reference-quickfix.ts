// Quick fixes for Typst errors when an `@reference` points at something `#ref`
// can't show.
//
// "cannot reference heading without numbering" (or equation) means the kind can
// be numbered but this document doesn't, so turning on numbering fixes it.
// "cannot reference text" means the label tags something with no number,
// usually prose.
//
// Both can use `#link(<label>)[text]`, which links to any label and shows words
// instead of a number. See
// [reference-form.ts](../typst-decorations/reference-form.ts) for the rules;
// Typst's own hint covers numbering, so this adds the one-click actions.

import type { Action } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { t } from "../../lib/i18n";
import { scanDocumentLabels } from "../typst-decorations/document-labels";
import { linkReference, setRuleForElement } from "../typst-decorations/reference-form";
import { noteBodyStart } from "../typst-decorations/note-header";

// The element kind can be numbered; this document doesn't. Not anchored, so
// small wording changes in Typst still match.
const NUMBERING_REF_RE = /cannot reference (\w+) without numbering/i;

// "cannot reference text" — the label tags something unnumberable.
const UNREFERENCEABLE_RE = /cannot reference (\w+)/i;

/**
 * Quick fixes for a failed-reference error, or `undefined` if the message isn't
 * one. The error covers the `@reference`, so each `apply` gets that span as
 * `(from, to)`.
 */
export function referenceActions(message: string): Action[] | undefined {
  const numbering = NUMBERING_REF_RE.exec(message);
  if (numbering) {
    const element = numbering[1].toLowerCase();
    const actions: Action[] = [enableNumberingAction(element)];
    // A heading can be linked by its text without numbering. Other numbered
    // kinds (equations, and figures or tables once Typst reports them the same
    // way) read as numbers in prose, so their label name wouldn't help.
    if (element === "heading") actions.push(textLinkAction());
    return actions;
  }

  // No numbering clause: the target can't be numbered at all, so a text link is
  // the only fix.
  if (UNREFERENCEABLE_RE.test(message)) return [textLinkAction()];

  return undefined;
}

/** Insert the `#set` rule that numbers `element` where the note's body starts. */
function enableNumberingAction(element: string): Action {
  const name =
    element === "heading"
      ? t("diagnostic.refNumbering.enableHeading")
      : element === "equation"
        ? t("diagnostic.refNumbering.enableEquation")
        : t("diagnostic.refNumbering.enableGeneric");

  return {
    name,
    apply(view: EditorView) {
      const at = noteBodyStart(view.state);
      view.dispatch({
        changes: { from: at, insert: `${setRuleForElement(element)}\n` },
      });
      view.focus();
    },
  };
}

/**
 * Rewrite `@name` as `#link(<name>)[text]` with the text selected, so the user
 * can type their own wording. The default text is a heading's own words where
 * known, otherwise the label name.
 */
function textLinkAction(): Action {
  return {
    name: t("diagnostic.refNumbering.useTextLink"),
    apply(view: EditorView, from: number, to: number) {
      const key = referencedLabel(view.state.doc, from, to);
      if (!key) return;
      const label = scanDocumentLabels(view.state).find((l) => l.name === key);
      const display = label?.display?.trim() || key;
      const link = linkReference(key, display);
      view.dispatch({
        changes: { from, to, insert: link.text },
        selection: { anchor: from + link.displayFrom, head: from + link.displayTo },
      });
      view.focus();
    },
  };
}

/** The label name of an `@target` reference occupying `[from, to)`, or null. */
function referencedLabel(doc: Text, from: number, to: number): string | null {
  const text = doc.sliceString(from, Math.min(to, doc.length));
  if (!text.startsWith("@")) return null;
  const name = text.slice(1).trim();
  return name || null;
}
