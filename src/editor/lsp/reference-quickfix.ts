// Quick-fixes for the Typst diagnostic raised when a `@reference` points at an
// element that has no number to display — "cannot reference heading without
// numbering" (and the equivalent for equations).
//
// In Typst, `@target` renders the target's *number* ("Section 1", "(2)"), which
// only exists if that element kind is numbered. Headings and block equations are
// unnumbered by default, so a reference to one is a hard compile error. Typst's
// own hint already explains how to enable numbering; InkyCap adds the one-click
// actions — and, for headings, the alternative Typst doesn't suggest: render the
// heading's *text* via `#link` instead, which needs no numbering. See the
// references-design notes; this matches the agreed decision #2.

import type { Action } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { t } from "../../lib/i18n";
import { scanDocumentLabels } from "../typst-decorations/document-labels";

// Matches "cannot reference heading without numbering", capturing the element
// kind. Tolerant of surrounding text so a future Typst wording tweak still hits.
const NUMBERING_REF_RE = /cannot reference (\w+) without numbering/i;

/**
 * The `#set` rule that enables numbering for a given element kind. Equations
 * live under `math.equation` and conventionally number as "(1)"; everything else
 * (headings) numbers as "1.".
 */
export function setRuleForElement(element: string): string {
  if (element === "equation") return '#set math.equation(numbering: "(1)")';
  return `#set ${element}(numbering: "1.")`;
}

/**
 * Offset where the document body begins — just past the leading run of blank
 * lines, comments, imports/includes, and a `#note(...)` / `#set-notebox(...)`
 * preamble block. New `#set` rules are inserted here so they sit with the
 * document's other top-matter rather than above the notebox import.
 */
export function findPreambleEnd(docText: string): number {
  const len = docText.length;
  let i = 0;
  while (i < len) {
    const lineEnd = docText.indexOf("\n", i);
    const stop = lineEnd < 0 ? len : lineEnd;
    const trimmed = docText.slice(i, stop).trim();

    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#import") ||
      trimmed.startsWith("#include")
    ) {
      i = stop + 1;
      continue;
    }

    if (trimmed.startsWith("#note(") || trimmed.startsWith("#set-notebox(")) {
      // Consume the (possibly multi-line) call by balancing parentheses.
      let depth = 0;
      let started = false;
      let j = i;
      for (; j < len; j++) {
        const c = docText[j];
        if (c === "(") {
          depth++;
          started = true;
        } else if (c === ")") {
          depth--;
          if (started && depth === 0) {
            j++;
            break;
          }
        }
      }
      const nl = docText.indexOf("\n", j);
      i = nl < 0 ? len : nl + 1;
      continue;
    }

    break;
  }
  return Math.min(i, len);
}

/** Escape `[` / `]` so heading text can sit inside a `#link[...]` content block. */
function escapeContent(text: string): string {
  return text.replace(/([[\]])/g, "\\$1");
}

/**
 * Quick-fix actions for a numbering reference error, or `undefined` if the
 * message isn't one. The diagnostic is attached to the `@reference` span, so
 * each action's `apply` receives that span as `(from, to)`.
 */
export function referenceNumberingActions(message: string): Action[] | undefined {
  const m = NUMBERING_REF_RE.exec(message);
  if (!m) return undefined;
  const element = m[1].toLowerCase();

  const enableLabel =
    element === "heading"
      ? t("diagnostic.refNumbering.enableHeading")
      : element === "equation"
        ? t("diagnostic.refNumbering.enableEquation")
        : t("diagnostic.refNumbering.enableGeneric");

  const actions: Action[] = [
    {
      name: enableLabel,
      apply(view: EditorView) {
        const at = findPreambleEnd(view.state.doc.toString());
        view.dispatch({
          changes: { from: at, insert: `${setRuleForElement(element)}\n` },
        });
        view.focus();
      },
    },
  ];

  // Heading references have a graceful alternative that needs no numbering:
  // link to the heading by its text. Only offered for headings.
  if (element === "heading") {
    actions.push({
      name: t("diagnostic.refNumbering.useTextLink"),
      apply(view: EditorView, from: number, to: number) {
        const key = referencedLabel(view.state.doc, from, to);
        if (!key) return;
        const label = scanDocumentLabels(view.state).find((l) => l.name === key);
        const display = label?.display?.trim() || key;
        const replacement = `#link(<${key}>)[${escapeContent(display)}]`;
        view.dispatch({
          changes: { from, to, insert: replacement },
          selection: { anchor: from + replacement.length },
        });
        view.focus();
      },
    });
  }

  return actions;
}

/** The label name of an `@target` reference occupying `[from, to)`, or null. */
function referencedLabel(doc: Text, from: number, to: number): string | null {
  const text = doc.sliceString(from, Math.min(to, doc.length));
  if (!text.startsWith("@")) return null;
  const name = text.slice(1).trim();
  return name || null;
}
