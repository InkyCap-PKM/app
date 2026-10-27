import { type Extension, EditorState, Facet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate, hoverTooltip, type Tooltip } from "@codemirror/view";
import { type CompletionContext, type CompletionResult, type Completion, startCompletion, snippet } from "@codemirror/autocomplete";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { renderDiagnosticMessage } from "../diagnostic-style";
import { referenceActions } from "./reference-quickfix";
import { isEmailLikeAt } from "../typst-decorations/reference-form";
import { LspClient, filePathToUri, type LspDiagnostic, type LspPosition, type LspCompletionItem } from "./client";
import * as ipc from "../../lib/ipc";
import { t } from "../../lib/i18n";

export const lspClientFacet = Facet.define<LspClient, LspClient | null>({
  combine: (values) => values[0] ?? null,
});

export const documentUriFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

/**
 * True in visual mode, where Tinymist's code completion (function names,
 * package symbols, notebox internals) is noise, so it only runs in source mode.
 * The visual compartment provides `visualModeFacet.of(true)`, and the LSP
 * completion source checks it. InkyCap's own wikilink and `@` suggestions are
 * separate and stay on.
 */
export const visualModeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some((v) => v),
});

/** Carries the latest diagnostics the server reported for this note. */
const lspDiagnosticsEffect = StateEffect.define<Diagnostic[]>();

/**
 * The latest diagnostics from the server, shown or not, so switching back from
 * visual mode can show them without waiting. Positions follow edits until the
 * next report.
 */
const lspDiagnosticsField = StateField.define<Diagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(lspDiagnosticsEffect)) {
        return effect.value;
      }
    }
    if (!tr.docChanged) return value;
    return value.map((d) => ({
      ...d,
      from: tr.changes.mapPos(d.from),
      to: tr.changes.mapPos(d.to, 1),
    }));
  },
});

/** The diagnostics to show: none in the visual editor, which is a writing
 *  surface rather than a code editor; all of them in source mode. */
function shownDiagnostics(state: EditorState): Diagnostic[] {
  if (state.facet(visualModeFacet)) return [];
  return state.field(lspDiagnosticsField, false) ?? [];
}

function diagnosticsKey(diagnostics: Diagnostic[]): string {
  return diagnostics.map((d) => `${d.from}:${d.to}:${d.severity}:${d.message}`).join("\n");
}

/**
 * Passes the stored diagnostics to the lint layer when a report differs from
 * what is shown, or when the mode changes. The server resends the same report
 * on every hover, and an unchanged update would close the message the mouse
 * just opened.
 */
const diagnosticsDisplay = ViewPlugin.fromClass(
  class {
    private shownKey: string;
    private destroyed = false;

    constructor(view: EditorView) {
      this.shownKey = diagnosticsKey(shownDiagnostics(view.state));
    }

    update(update: ViewUpdate) {
      const reported = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(lspDiagnosticsEffect)),
      );
      const modeChanged =
        update.startState.facet(visualModeFacet) !== update.state.facet(visualModeFacet);
      if (!reported && !modeChanged) return;
      const next = shownDiagnostics(update.state);
      const key = diagnosticsKey(next);
      if (key === this.shownKey) return;
      this.shownKey = key;
      // An editor can't be updated from inside its own update, so hand the
      // set over just after this one finishes.
      const view = update.view;
      queueMicrotask(() => {
        if (this.destroyed) return;
        view.dispatch(setDiagnostics(view.state, shownDiagnostics(view.state)));
      });
    }

    destroy() {
      this.destroyed = true;
    }
  },
);

function offsetToLspPosition(doc: { lineAt(pos: number): { number: number; from: number } }, offset: number): LspPosition {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

function lspPositionToOffset(doc: { line(n: number): { from: number } ; lines: number }, pos: LspPosition): number {
  if (pos.line >= doc.lines) return doc.line(doc.lines).from;
  const line = doc.line(pos.line + 1);
  return line.from + pos.character;
}

function lspCompletionKindToType(kind?: number): string | undefined {
  const kinds: Record<number, string> = {
    1: "text", 2: "method", 3: "function", 4: "constructor",
    5: "field", 6: "variable", 7: "class", 8: "interface",
    9: "module", 10: "property", 11: "unit", 12: "value",
    13: "enum", 14: "keyword", 15: "snippet", 16: "color",
    17: "file", 18: "reference", 19: "folder", 20: "enum",
    21: "constant", 22: "struct", 23: "event", 24: "operator",
    25: "type",
  };
  return kind ? kinds[kind] : undefined;
}

function extractDocString(doc: LspCompletionItem["documentation"]): string | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return doc;
  return doc.value;
}

function lspCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  // Suppressed in visual mode — code completion belongs to the source editor.
  if (ctx.state.facet(visualModeFacet)) return Promise.resolve(null);
  const client = ctx.state.facet(lspClientFacet);
  const uri = ctx.state.facet(documentUriFacet);
  if (!client || !uri || !client.isRunning()) return Promise.resolve(null);

  const trigger = ctx.matchBefore(/#[\w\-.]*/);
  const word = ctx.matchBefore(/[\w\-.]+/);
  if (!ctx.explicit && !trigger && !word) return Promise.resolve(null);

  // Sync is debounced; send the current text now so completion uses it.
  client.changeDocument(uri, ctx.state.doc.toString());

  const pos = offsetToLspPosition(ctx.state.doc, ctx.pos);

  return client.completion(uri, pos).then((items) => {
    if (!items.length) return null;

    const isSnippet = (item: LspCompletionItem) => item.insertTextFormat === 2;

    const completions: Completion[] = items.map((item: LspCompletionItem) => ({
      label: item.label,
      type: lspCompletionKindToType(item.kind),
      detail: item.detail,
      info: extractDocString(item.documentation),
      apply: item.textEdit
        ? (view: EditorView, _completion: Completion, from: number, to: number) => {
            const newText = item.textEdit!.newText;
            const editFrom = lspPositionToOffset(view.state.doc, item.textEdit!.range.start);
            const editTo = lspPositionToOffset(view.state.doc, item.textEdit!.range.end);
            if (isSnippet(item)) {
              view.dispatch({ changes: { from: editFrom, to: editTo, insert: "" } });
              snippet(newText)(view, _completion, editFrom, editFrom);
            } else {
              view.dispatch({ changes: { from: editFrom, to: editTo, insert: newText } });
            }
          }
        : isSnippet(item) && item.insertText
          ? snippet(item.insertText)
          : item.insertText ?? item.label,
      boost: item.sortText ? -item.sortText.charCodeAt(0) : undefined,
    }));

    const from = trigger ? trigger.from + 1 : word?.from ?? ctx.pos;
    return {
      from,
      options: completions,
    };
  });
}

const LSP_TRIGGER_CHARS = new Set(["#", "(", ".", ","]);

const lspTriggerExtension = EditorView.inputHandler.of(
  (view, _from, _to, text) => {
    if (LSP_TRIGGER_CHARS.has(text) && !view.state.facet(visualModeFacet)) {
      const client = view.state.facet(lspClientFacet);
      if (client?.isRunning()) {
        setTimeout(() => startCompletion(view), 0);
      }
    }
    return false;
  },
);

function lspHoverSource(view: EditorView, pos: number, _side: number): Promise<Tooltip | null> {
  // Suppressed in visual mode — Tinymist signature/definition hovers are
  // source-editor noise when the markup they describe is decorated away.
  if (view.state.facet(visualModeFacet)) return Promise.resolve(null);
  const client = view.state.facet(lspClientFacet);
  const uri = view.state.facet(documentUriFacet);
  if (!client || !uri || !client.isRunning()) return Promise.resolve(null);

  const lspPos = offsetToLspPosition(view.state.doc, pos);

  return client.hover(uri, lspPos).then((result) => {
    if (!result) return null;

    let text: string;
    if (typeof result.contents === "string") {
      text = result.contents;
    } else if (Array.isArray(result.contents)) {
      text = result.contents
        .map((c) => (typeof c === "string" ? c : c.value))
        .join("\n\n");
    } else {
      text = result.contents.value;
    }

    if (!text.trim()) return null;

    const start = result.range
      ? lspPositionToOffset(view.state.doc, result.range.start)
      : pos;

    return {
      pos: start,
      end: result.range ? lspPositionToOffset(view.state.doc, result.range.end) : undefined,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-lsp-hover";
        renderMarkdownSimple(dom, text);
        return { dom };
      },
    };
  });
}

function renderMarkdownSimple(container: HTMLElement, md: string): void {
  const fencedRe = /```(\w*)\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  const appendInlineText = (raw: string) => {
    const parts = raw.split(/\n\n/);
    parts.forEach((part, i) => {
      if (i > 0) {
        container.appendChild(document.createElement("br"));
        container.appendChild(document.createElement("br"));
      }
      const lines = part.split("\n");
      lines.forEach((line, j) => {
        if (j > 0) container.appendChild(document.createElement("br"));
        const inlineRe = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
        let inlineIdx = 0;
        let inlineMatch: RegExpExecArray | null;
        while ((inlineMatch = inlineRe.exec(line)) !== null) {
          if (inlineMatch.index > inlineIdx) {
            container.appendChild(document.createTextNode(line.slice(inlineIdx, inlineMatch.index)));
          }
          if (inlineMatch[1] !== undefined) {
            const strong = document.createElement("strong");
            strong.textContent = inlineMatch[1];
            container.appendChild(strong);
          } else if (inlineMatch[2] !== undefined) {
            const em = document.createElement("em");
            em.textContent = inlineMatch[2];
            container.appendChild(em);
          } else if (inlineMatch[3] !== undefined) {
            const code = document.createElement("code");
            code.textContent = inlineMatch[3];
            container.appendChild(code);
          }
          inlineIdx = inlineMatch.index + inlineMatch[0].length;
        }
        if (inlineIdx < line.length) {
          container.appendChild(document.createTextNode(line.slice(inlineIdx)));
        }
      });
    });
  };

  while ((match = fencedRe.exec(md)) !== null) {
    if (match.index > lastIdx) {
      appendInlineText(md.slice(lastIdx, match.index));
    }
    const pre = document.createElement("pre");
    pre.className = "cm-lsp-code";
    const code = document.createElement("code");
    code.textContent = match[2];
    pre.appendChild(code);
    container.appendChild(pre);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < md.length) {
    appendInlineText(md.slice(lastIdx));
  }
}

// Tinymist's unresolved-reference error. A bibliography entry is just another
// label to `@`, so an `@cite` with no `#bibliography(...)` in scope gives the
// same "label `<key>` does not exist" as a broken `@fig:foo`. The group is the
// label name.
const UNRESOLVED_LABEL_RE = /^label `<([^>]+)>` does not exist in the document/;

// Delimiters whose closing marker must be at a word boundary (not followed by a
// letter or digit), used to add a hint to "unclosed delimiter" errors for `*` and
// `_`.
const EMPHASIS_DELIMITERS = new Set(["*", "_"]);

// Typst's "unknown variable: <name>" error. Suppressed on scaffold fragment
// files — see `isScaffoldFragmentUri`.
const UNKNOWN_VARIABLE_RE = /^unknown variable\b/i;

// Scaffolds (`.inkycap/scaffolds/*.typ`) are fragments: they use notebox
// functions (`#note`, `#tag`, `#wikilink`, …) without the `#import`, which the
// note they are merged into has. Tinymist compiles them alone and reports
// "unknown variable" for each, so those are dropped for scaffolds while syntax
// and other errors stay. `.inkycap/templates/` holds complete packages and
// isn't included.
function isScaffoldFragmentUri(uri: string): boolean {
  return decodeURIComponent(uri).includes("/.inkycap/scaffolds/");
}

// Bibliography keys, cached so the synchronous conversion can tell whether an
// unresolved label is a citation. Uses the same test as the backend's
// `maybe_inject_preview_bibliography`, so a match means the preview resolves it
// and the hint is accurate.
const BIB_KEY_TTL = 5000;
let cachedBibKeys = new Set<string>();
let bibKeyCacheTime = 0;

async function refreshBibKeys(): Promise<Set<string>> {
  if (Date.now() - bibKeyCacheTime < BIB_KEY_TTL) return cachedBibKeys;
  try {
    const entries = await ipc.getBibliographyEntries();
    cachedBibKeys = new Set(entries.map((e) => e.key));
    bibKeyCacheTime = Date.now();
  } catch {
    // Keep the (possibly stale) cache; a failed fetch shouldn't suppress
    // diagnostics or strip an already-known key.
  }
  return cachedBibKeys;
}

/**
 * Whether `d` is the unresolved-label error for the `@domain` of an email
 * address like `athena@inkycap.org`. InkyCap treats that as an address (see
 * `isEmailLikeAt`) and escapes it when compiling, so the error doesn't apply.
 */
export function isEmailAddressDiagnostic(
  doc: EditorView["state"]["doc"],
  d: LspDiagnostic,
): boolean {
  if (!UNRESOLVED_LABEL_RE.test(d.message)) return false;
  const at = lspPositionToOffset(doc, d.range.start);
  if (at < 1 || at >= doc.length || doc.sliceString(at, at + 1) !== "@") return false;
  return isEmailLikeAt(doc.sliceString(at - 1, at));
}

function convertDiagnostics(
  doc: EditorView["state"]["doc"],
  diagnostics: LspDiagnostic[],
  bibKeys: Set<string>,
  suppressUnknownVars: boolean,
): Diagnostic[] {
  const relevant = diagnostics.filter(
    (d) =>
      !(suppressUnknownVars && UNKNOWN_VARIABLE_RE.test(d.message)) &&
      !isEmailAddressDiagnostic(doc, d),
  );
  return relevant.map((d) => {
    const from = lspPositionToOffset(doc, d.range.start);
    const to = lspPositionToOffset(doc, d.range.end);
    const severity: Diagnostic["severity"] = d.severity === 1 ? "error"
      : d.severity === 2 ? "warning"
      : "info";

    // A known bibliography key: source mode just lacks the bibliography the
    // preview adds, so say so.
    let message = d.message;
    const labelMatch = UNRESOLVED_LABEL_RE.exec(d.message);
    if (labelMatch && bibKeys.has(labelMatch[1])) {
      message = `${d.message} — ${t("diagnostic.citationResolvesInPreview")}`;
    } else if (
      /unclosed delimiter/i.test(d.message) &&
      EMPHASIS_DELIMITERS.has(doc.sliceString(from, Math.min(from + 1, doc.length)))
    ) {
      // `*` and `_` only close at a word boundary, so `*testi*ng` leaves the
      // emphasis open (unlike Markdown). Explain the rule. The range starts on
      // the opening marker, so the character at `from` is `*` or `_`.
      message = `${d.message} — ${t("diagnostic.unclosedEmphasis")}`;
    }

    // Quick fixes for a failed `@reference`: turn on numbering where that is
    // missing, or switch to a `#link(<label>)`, the only option when the target
    // can't be numbered.
    const actions = referenceActions(d.message);

    return {
      from: Math.min(from, doc.length),
      to: Math.min(to, doc.length),
      severity,
      message,
      renderMessage: renderDiagnosticMessage(severity, message),
      source: d.source,
      ...(actions ? { actions } : {}),
    };
  });
}

export function createLspDiagnosticsUpdater(view: EditorView) {
  const uri = view.state.facet(documentUriFacet);
  const client = view.state.facet(lspClientFacet);
  if (!client || !uri) return () => {};

  const suppressUnknownVars = isScaffoldFragmentUri(uri);

  let disposed = false;
  const unsubscribe = client.subscribeDiagnostics(uri, (diagnostics) => {
    // Get the (cached) bibliography keys first; on a cache miss the diagnostics
    // arrive a few ms later.
    void refreshBibKeys().then((bibKeys) => {
      if (disposed) return;
      const converted = convertDiagnostics(view.state.doc, diagnostics, bibKeys, suppressUnknownVars);
      view.dispatch({ effects: lspDiagnosticsEffect.of(converted) });
    });
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}

// Debounced sync, per view: a shared timer would let one split pane's pending
// sync replace another's, losing a change. The timer lives in the plugin
// instance and is cleared in `destroy`.
const lspSyncExtension = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      const client = update.state.facet(lspClientFacet);
      const uri = update.state.facet(documentUriFacet);
      if (!client || !uri || !client.isRunning()) return;

      if (this.timer) clearTimeout(this.timer);
      const doc = update.state.doc.toString();
      this.timer = setTimeout(() => {
        this.timer = null;
        client.changeDocument(uri, doc);
      }, 200);
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
  },
);

const lspTheme = EditorView.baseTheme({
  ".cm-lsp-hover": {
    padding: "6px 10px",
    maxWidth: "500px",
    maxHeight: "300px",
    overflow: "auto",
    fontSize: "var(--text-md)",
    lineHeight: "1.4",
    fontFamily: "var(--editor-font-mono, monospace)",
  },
  ".cm-lsp-hover code": {
    backgroundColor: "var(--bg-hover)",
    padding: "1px 4px",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-base)",
  },
  ".cm-lsp-hover pre.cm-lsp-code": {
    backgroundColor: "var(--bg-secondary)",
    padding: "8px",
    borderRadius: "var(--radius-sm)",
    overflow: "auto",
    margin: "4px 0",
  },
  ".cm-lsp-hover strong": {
    fontWeight: "bold",
  },
  ".cm-lsp-hover em": {
    fontStyle: "italic",
  },
});

const lspCompletionProvider = EditorState.languageData.of(
  () => [{ autocomplete: lspCompletionSource }],
);

export function lspExtension(client: LspClient, documentUri: string): Extension {
  return [
    lspClientFacet.of(client),
    documentUriFacet.of(documentUri),
    lspDiagnosticsField,
    diagnosticsDisplay,
    lspCompletionProvider,
    lspTriggerExtension,
    hoverTooltip(lspHoverSource, { hideOnChange: true }),
    lspSyncExtension,
    lspTheme,
  ];
}
