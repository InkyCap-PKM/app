import { EditorView } from "@codemirror/view";
import type { Diagnostic } from "@codemirror/lint";
import { t } from "../lib/i18n";

/**
 * Line style that marks each kind of problem in the text. Each kind has its
 * own shape as well as its own colour, so the difference still reads for
 * someone who can't tell the colours apart:
 *
 * - spelling mistakes: wavy (drawn by spellcheck.ts)
 * - errors: double
 * - warnings: dashed
 * - info and hints: dotted
 *
 * A single solid line is left to links, so no problem marker looks like one.
 */
export const ERROR_UNDERLINE_STYLE = "double";

/**
 * Replaces the look CodeMirror's lint package gives to diagnostics. The
 * package draws every severity with the same wavy background image and tells
 * them apart only by colour; this swaps the image for a text underline whose
 * style depends on the severity, and takes the colours from the theme.
 */
export const diagnosticTheme = EditorView.theme({
  ".cm-lintRange": {
    backgroundImage: "none",
    paddingBottom: "0",
    textDecorationLine: "underline",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-error": {
    textDecorationStyle: ERROR_UNDERLINE_STYLE,
    textDecorationColor: "var(--accent-danger)",
  },
  ".cm-lintRange-warning": {
    textDecorationStyle: "dashed",
    textDecorationColor: "var(--accent-warn)",
  },
  ".cm-lintRange-info, .cm-lintRange-hint": {
    textDecorationStyle: "dotted",
    textDecorationColor: "var(--fg-muted)",
  },
  ".cm-diagnostic-error": { borderLeftColor: "var(--accent-danger)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--accent-warn)" },
  ".cm-diagnostic-info, .cm-diagnostic-hint": { borderLeftColor: "var(--fg-muted)" },
  ".cm-diagnostic-severity": {
    fontWeight: "600",
    marginRight: "0.4em",
  },
});

/**
 * Builds the pop-up content for a diagnostic: the severity as a word
 * ("Error", "Warning", "Info") followed by the message, so the kind of
 * problem is named rather than shown only by the colour of the border.
 */
export function renderDiagnosticMessage(
  severity: Diagnostic["severity"],
  message: string,
): () => Node {
  return () => {
    const wrap = document.createElement("span");
    const label = document.createElement("span");
    label.className = "cm-diagnostic-severity";
    label.textContent = t("diagnostic.severityLabel", {
      severity: diagnosticSeverityName(severity),
    });
    wrap.append(label, document.createTextNode(message));
    return wrap;
  };
}

/**
 * The localized name of a diagnostic severity ("Error", "Warning", ...).
 * Components pass their reactive translator from `useI18n()` so the name
 * follows a language switch; editor code uses the default.
 */
export function diagnosticSeverityName(
  severity: string,
  translate: (key: string) => string = t,
): string {
  switch (severity) {
    case "error":
      return translate("diagnostic.severity.error");
    case "warning":
      return translate("diagnostic.severity.warning");
    case "hint":
      return translate("diagnostic.severity.hint");
    default:
      return translate("diagnostic.severity.info");
  }
}
