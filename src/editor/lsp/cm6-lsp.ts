import { type Extension, EditorState, Facet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate, hoverTooltip, type Tooltip } from "@codemirror/view";
import { type CompletionContext, type CompletionResult, type Completion, startCompletion, snippet } from "@codemirror/autocomplete";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { LspClient, filePathToUri, type LspDiagnostic, type LspPosition, type LspCompletionItem } from "./client";

export const lspClientFacet = Facet.define<LspClient, LspClient | null>({
  combine: (values) => values[0] ?? null,
});

export const documentUriFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

/**
 * True when the editor is in visual mode. The visual editor is a WYSIWYM
 * authoring surface, not a code editor, so the Tinymist code-completion popup
 * (function names, package symbols, the notebox internals) is noise there —
 * the user asked to keep it in source mode only. The visual compartment
 * provides `visualModeFacet.of(true)`; the LSP completion source and its
 * trigger short-circuit when it's set. InkyCap's own `[[wikilink]]` and `@`
 * citation suggesters are separate sources and stay active.
 */
export const visualModeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some((v) => v),
});

const lspDiagnosticsEffect = StateEffect.define<Diagnostic[]>();

const lspDiagnosticsField = StateField.define<Diagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(lspDiagnosticsEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

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

  // The typing-time sync is debounced per view; push the current doc now so
  // the server completes against the latest text instead of waiting out the
  // debounce (which would complete against stale text or miss the trigger).
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

function convertDiagnostics(doc: EditorView["state"]["doc"], diagnostics: LspDiagnostic[]): Diagnostic[] {
  return diagnostics.map((d) => {
    const from = lspPositionToOffset(doc, d.range.start);
    const to = lspPositionToOffset(doc, d.range.end);
    const severity = d.severity === 1 ? "error"
      : d.severity === 2 ? "warning"
      : "info";
    return {
      from: Math.min(from, doc.length),
      to: Math.min(to, doc.length),
      severity: severity as "error" | "warning" | "info",
      message: d.message,
      source: d.source,
    };
  });
}

export function createLspDiagnosticsUpdater(view: EditorView) {
  const uri = view.state.facet(documentUriFacet);
  const client = view.state.facet(lspClientFacet);
  if (!client || !uri) return () => {};

  const normalizeUri = (u: string) => decodeURIComponent(u);
  const normalizedUri = normalizeUri(uri);

  const handler = (diagUri: string, diagnostics: LspDiagnostic[]) => {
    if (normalizeUri(diagUri) !== normalizedUri) return;
    const converted = convertDiagnostics(view.state.doc, diagnostics);
    view.dispatch(setDiagnostics(view.state, converted));
  };

  client.setDiagnosticsHandler(handler);
  return () => client.setDiagnosticsHandler(() => {});
}

// Debounced document sync, scoped *per view*. A module-global timer would be
// shared across split panes editing different documents, so the second pane's
// pending sync would overwrite the first's and one document's change would
// never reach the language server. Holding the timer in the plugin instance
// (and clearing it in `destroy`) keeps each editor's sync independent and
// leak-free.
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
    backgroundColor: "var(--bg-hover, rgba(128,128,128,0.15))",
    padding: "1px 4px",
    borderRadius: "3px",
    fontSize: "var(--text-base)",
  },
  ".cm-lsp-hover pre.cm-lsp-code": {
    backgroundColor: "var(--bg-secondary, rgba(0,0,0,0.1))",
    padding: "8px",
    borderRadius: "4px",
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
    lspCompletionProvider,
    lspTriggerExtension,
    hoverTooltip(lspHoverSource, { hideOnChange: true }),
    lspSyncExtension,
    lspTheme,
  ];
}
