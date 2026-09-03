// Quick-fixes for the Typst diagnostics raised when an `@reference` points at
// something `#ref` cannot render.
//
// There are two shapes. "cannot reference heading without numbering" (and the
// equivalent for equations) means the target *kind* can be numbered but this
// document doesn't number it — so enabling numbering fixes it. Plain "cannot
// reference text" means the label tags something that has no number at all,
// usually prose, and no `#set` rule will ever help.
//
// Both are answered by the same alternative: `#link(<label>)[text]`, which
// points at any label and shows words instead of a number. See
// [reference-form.ts](../typst-decorations/reference-form.ts) for the shared
// rules; Typst's own hint already covers the numbering side, so InkyCap's job
// here is the one-click actions.

import type { Action } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { t } from "../../lib/i18n";
import { scanDocumentLabels } from "../typst-decorations/document-labels";
import {
  findPreambleEnd,
  linkReference,
  setRuleForElement,
} from "../typst-decorations/reference-form";

// "cannot reference heading without numbering" — the element kind can be
// numbered, this document just doesn't. Tolerant of surrounding text so a
// future Typst wording tweak still hits.
const NUMBERING_REF_RE = /cannot reference (\w+) without numbering/i;

// "cannot reference text" — the label tags something unnumberable.
const UNREFERENCEABLE_RE = /cannot reference (\w+)/i;

/**
 * Quick-fix actions for a failed-reference diagnostic, or `undefined` if the
 * message isn't one. The diagnostic is attached to the `@reference` span, so
 * each action's `apply` receives that span as `(from, to)`.
 */
export function referenceActions(message: string): Action[] | undefined {
  const numbering = NUMBERING_REF_RE.exec(message);
  if (numbering) {
    const element = numbering[1].toLowerCase();
    const actions: Action[] = [enableNumberingAction(element)];
    // Heading references have a graceful alternative that needs no numbering:
    // link to the heading by its text. Other numbered kinds (equations, and
    // figures/tables when Typst gains the same message) read as a number in
    // prose, so swapping in their label name would not be an improvement.
    if (element === "heading") actions.push(textLinkAction());
    return actions;
  }

  // No numbering clause: the target can't be numbered at all, so a text link is
  // the only fix.
  if (UNREFERENCEABLE_RE.test(message)) return [textLinkAction()];

  return undefined;
}

/** Insert the `#set` rule that numbers `element`, at the end of the preamble. */
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
      const at = findPreambleEnd(view.state.doc.toString());
      view.dispatch({
        changes: { from: at, insert: `${setRuleForElement(element)}\n` },
      });
      view.focus();
    },
  };
}

/**
 * Rewrite the failing `@name` into `#link(<name>)[text]`, leaving the display
 * text selected so the writer can type their own wording straight away. The
 * default wording is the label's display text — a heading's own words where we
 * have them, otherwise the label name as a placeholder.
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
