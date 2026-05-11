import { Compartment, EditorState, Prec, StateField, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap, lintGutter } from "@codemirror/lint";
import { TypstParser, typstHighlight } from "codemirror-lang-typst";
import { syntaxHighlighting, HighlightStyle, defineLanguageFacet, language, Language, LanguageSupport } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const typstLanguageFacet = defineLanguageFacet({ commentTokens: { block: { open: "/*", close: "*/" } } });

// Replacement for codemirror-lang-typst's built-in updateListener. The stock
// implementation calls `parser.parser.edit(...)` per change and then either
// nulls `last_tree` (full_update) or mutates it in-place via `applyTreeEdit`.
// On undo/redo of a slash-command insertion (e.g. `/strikethrough` ⇄
// `#strike[]`), the WASM parser returns incremental edits whose result mutates
// `last_tree` into a shape that doesn't match the post-history document — so
// `syntaxTree(state)` returns nodes with stale offsets, and the visual
// decorator falls back to raw source until a mode toggle forces a fresh parse.
//
// The same staleness shows up for any transaction that bundles multiple
// disjoint changes — alt-up/down line move (delete one line, insert another),
// find-replace-all, multi-cursor edits, and the inverse undo of any of those.
// In the visual editor, the symptom is bullets / list markers / pills appearing
// at wrong source positions after the operation.
//
// This version keeps WASM in sync (still calls `parser.parser.edit(...)` for
// every change, in order — that contract is non-negotiable) but discards the
// incremental tree edits and clears the cached tree whenever the transaction
// is an undo/redo OR contains more than one disjoint change region. The next
// `parser.tree()` call then re-fetches from the WASM parser, which has tracked
// the doc correctly via the edit() calls.
//
// Pairs with the `Prec.high` wrapper below: this state field must run before
// `@codemirror/language`'s `Language.state` so that, when LanguageState.apply
// asks for `parser.tree()`, the cache is already cleared.
function typstUpdateListenerForcingFreshParseOnHistory(parser: TypstParser): Extension {
  const wasm = parser as unknown as {
    parser: { edit(from: number, to: number, text: string): { full_update?: boolean; edits?: unknown[] } } | null;
    clearTree(): void;
    clearParser(): void;
    applyTreeEdit(edit: unknown): void;
  };
  return StateField.define<null>({
    create() { return null; },
    update(_, tr) {
      if (tr.startState.facet(language) !== tr.state.facet(language)) {
        wasm.clearParser();
        return null;
      }
      if (!tr.docChanged) return null;

      const isHistory = tr.isUserEvent("undo") || tr.isUserEvent("redo");
      let needsFullClear = isHistory;
      const collected: unknown[] = [];
      let changeCount = 0;
      let crossesLine = false;

      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changeCount++;
        const removed = tr.startState.doc.sliceString(fromA, toA);
        const insertedStr = inserted.toString();
        // Any change that spans / produces a newline reshuffles line
        // structure — the incremental parser's edits aren't reliable for
        // line-granular nodes (ListMarker, Heading, etc.). Clear instead.
        if (removed.includes("\n") || insertedStr.includes("\n")) {
          crossesLine = true;
        }
        const result = wasm.parser?.edit(fromA, toA, insertedStr);
        if (!result) return;
        if (result.full_update) {
          needsFullClear = true;
        } else if (!needsFullClear && result.edits) {
          for (const e of result.edits) collected.push(e);
        }
      });

      // Multi-region transactions (alt-up/down move, find-replace-all,
      // multi-cursor) and any line-spanning edit leave the incremental
      // tree mismatched against the post-doc — see header comment.
      if (changeCount > 1 || crossesLine) needsFullClear = true;

      if (needsFullClear) {
        // clearTree() alone is insufficient for multi-region edits:
        // iterChanges reports each fromA/toA in start-state positions,
        // but the WASM parser's edit() tracks state sequentially. After
        // one edit() shifts internal offsets, the next call's start-
        // state position is wrong from WASM's perspective and corrupts
        // its internal tracking. clearParser() drops the parser's
        // internal state entirely so the next tree() call re-parses
        // from the live doc — slower but always correct.
        wasm.clearParser();
      } else {
        for (const e of collected) wasm.applyTreeEdit(e);
      }
      return null;
    },
  });
}

function typstLanguage(): Extension {
  // The TypstParser constructor accepts a NodePropSource at runtime but
  // the package's type declarations omit the parameter.
  const parser = new (TypstParser as unknown as new (h: typeof typstHighlight) => TypstParser)(typstHighlight);
  const support = new LanguageSupport(
    new Language(typstLanguageFacet, parser, [], "typst"),
  );
  return [Prec.high(typstUpdateListenerForcingFreshParseOnHistory(parser)), support];
}
import { typstVisualMode, autoExpandFacet, protectedRangesField, rebuildVisualDecorations, externalReload } from "./typst-decorations/visual-plugin";
import { sourceRawHighlight } from "./typst-decorations/source-raw-highlight";
import { focusModeExtension, type FocusMode } from "./typst-decorations/focus-mode";
import { typstKeymap, smartIndentListsFacet } from "./typst-decorations/keymaps";
import { wikilinkSuggest } from "./typst-decorations/wikilink-suggest";
import { citationSuggest } from "./typst-decorations/citation-suggest";
import { dragDropHandler } from "./typst-decorations/drag-drop";
import { autoPairTypstInput, autoPairTypstBackspace } from "./typst-decorations/auto-pair-typst";
import { markdownShortcuts } from "./typst-decorations/markdown-shortcuts";
import { headingTracker } from "./typst-decorations/heading-tracker";
import { wordCountTracker } from "./typst-decorations/word-count";
import { lspExtension } from "./lsp";
import type { LspClient } from "./lsp";

export interface TypstEditorHandle {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  setVisualMode(enabled: boolean): void;
  setAutoExpand(enabled: boolean): void;
  setFocusMode(mode: FocusMode, dim: boolean): void;
  setSmartIndentLists(enabled: boolean): void;
  ensureParsed(timeout?: number): void;
  /** Force the visual decoration field to rebuild from a fully-parsed tree.
   *  Call after setText() during external reloads (sidebar property edits)
   *  to avoid stale Replace ranges blanking the editor. */
  rebuildVisual(): void;
  setLsp(client: LspClient | null, documentUri: string): void;
  focus(): void;
  focusAtContent(): void;
  setCursor(offset: number): void;
  /** Serialize doc + selection + undo history. Pair with `restoreState`. */
  serializeState(): unknown;
  destroy(): void;
}

export interface TypstEditorOptions {
  parent: HTMLElement;
  doc?: string;
  readOnly?: boolean;
  visualMode?: boolean;
  smartIndentLists?: boolean;
  lspClient?: LspClient | null;
  documentUri?: string;
  onUpdate?: (text: string) => void;
  extensions?: Extension[];
  /**
   * Snapshot from a previous `serializeState()` call. When provided, the
   * editor restores the doc, selection, and undo history from the snapshot
   * instead of starting fresh from `doc`. Used to preserve Ctrl-Z across
   * tab switches that unmount/remount the editor component.
   */
  restoreState?: unknown;
}

const inkycapTheme = EditorView.theme({
  "&": {
    height: "100%",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--bg-selection) !important",
  },
  "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--bg-selection) !important",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--md-body-font, var(--editor-font-body, sans-serif))",
    fontSize: "var(--md-body-size, 17px)",
  },
  ".cm-content": {
    // max-width + margin auto handles the wide-screen centering, just as
    // before. The inline padding adds an outer gap that floors the
    // distance between the content and the panel/gutter edge on narrow
    // viewports. content-box keeps the padding outside max-width so the
    // user's intended column count is preserved, and the padding lives on
    // .cm-content (not .cm-scroller) so the gutter stays flush to the
    // panel edge in source mode.
    maxWidth: "var(--md-max-width, none)",
    margin: "0 auto",
    paddingBlock: "1em",
    paddingInline: "var(--md-side-padding-min, 0px)",
    boxSizing: "content-box",
    caretColor: "var(--fg-primary)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-secondary)",
    borderRight: "1px solid var(--border-subtle)",
    color: "var(--fg-gutter)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--bg-active)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--bg-hover) 60%, transparent)",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--fg-primary)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--bg-search-match)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--bg-matching-bracket)",
    outline: "1px solid var(--border-subtle)",
  },
  ".cm-foldGutter .cm-gutterElement": {
    color: "var(--fg-dim)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-primary)",
    border: "1px solid var(--border-primary)",
    color: "var(--fg-primary)",
  },
  ".cm-tooltip-autocomplete": {
    maxHeight: "min(300px, 40vh)",
  },
  ".cm-tooltip-autocomplete > ul": {
    maxHeight: "min(300px, 40vh)",
    overflowY: "auto",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--bg-active)",
    color: "var(--fg-primary)",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-secondary)",
    color: "var(--fg-primary)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--border-subtle)",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    color: "var(--fg-primary)",
  },
});

const inkycapHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syntax-heading)", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold", color: "var(--syntax-strong)" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--syntax-strike)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: [tags.integer, tags.float, tags.number], color: "var(--syntax-number)" },
  { tag: tags.bool, color: "var(--syntax-number)" },
  { tag: tags.literal, color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: [tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.operatorKeyword], color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: tags.variableName, color: "var(--syntax-variable)" },
  { tag: [tags.name, tags.labelName], color: "var(--syntax-type)" },
  { tag: tags.link, color: "var(--syntax-link)", textDecoration: "underline" },
  { tag: tags.monospace, fontFamily: "var(--editor-font-mono, monospace)" },
  { tag: [tags.brace, tags.bracket, tags.paren, tags.separator, tags.punctuation], color: "var(--fg-dim)" },
  { tag: [tags.arithmeticOperator, tags.compareOperator, tags.updateOperator, tags.controlOperator], color: "var(--syntax-keyword)" },
  { tag: tags.special(tags.string), color: "var(--syntax-string)" },
  { tag: tags.special(tags.variableName), color: "var(--syntax-variable)" },
  { tag: tags.special(tags.contentSeparator), color: "var(--syntax-keyword)" },
  { tag: tags.invalid, color: "var(--accent-danger)", textDecoration: "underline wavy" },
]);

function baseExtensions(options: TypstEditorOptions): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightSpecialChars(),
    foldGutter(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    tooltips({ position: "fixed" }),
    autoPairTypstInput,
    markdownShortcuts,
    keymap.of([
      autoPairTypstBackspace,
      ...typstKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    typstLanguage(),
    drawSelection(),
    syntaxHighlighting(inkycapHighlight),
    sourceRawHighlight(),
    inkycapTheme,
    wikilinkSuggest,
    citationSuggest,
    dragDropHandler,
    headingTracker,
    wordCountTracker,
    lintGutter(),
    EditorView.lineWrapping,
  ];

  if (options.readOnly) {
    exts.push(EditorState.readOnly.of(true));
  }

  if (options.onUpdate) {
    const callback = options.onUpdate;
    exts.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          callback(update.state.doc.toString());
        }
      }),
    );
  }

  if (options.extensions) {
    exts.push(...options.extensions);
  }

  return exts;
}

export function createTypstEditor(options: TypstEditorOptions): TypstEditorHandle {
  const visualCompartment = new Compartment();
  const autoExpandCompartment = new Compartment();
  const lspCompartment = new Compartment();
  const focusModeCompartment = new Compartment();
  const activeLineCompartment = new Compartment();
  const smartIndentCompartment = new Compartment();
  // history() lives in a compartment so setText() can reset the undo stack
  // when loading new file content — otherwise prior edits' offsets persist
  // against a freshly-replaced doc and Ctrl-Z eventually empties the file.
  const historyCompartment = new Compartment();
  const visualExts = options.visualMode ? typstVisualMode() : [];
  const activeLineExts = options.visualMode ? [] : [highlightActiveLine(), highlightActiveLineGutter()];
  const lspExts = options.lspClient && options.documentUri
    ? lspExtension(options.lspClient, options.documentUri)
    : [];

  let isVisual = !!options.visualMode;

  const stateConfig = {
    doc: options.doc ?? "",
    extensions: [
      ...baseExtensions(options),
      visualCompartment.of(visualExts),
      autoExpandCompartment.of(autoExpandFacet.of(false)),
      lspCompartment.of(lspExts),
      focusModeCompartment.of([]),
      activeLineCompartment.of(activeLineExts),
      smartIndentCompartment.of(smartIndentListsFacet.of(!!options.smartIndentLists)),
      historyCompartment.of(history()),
    ],
  };

  const state = options.restoreState
    ? EditorState.fromJSON(
        options.restoreState as Parameters<typeof EditorState.fromJSON>[0],
        stateConfig,
        { history: historyField },
      )
    : EditorState.create(stateConfig);

  const view = new EditorView({
    state,
    parent: options.parent,
  });

  return {
    view,
    getText() {
      return view.state.doc.toString();
    },
    setText(text: string) {
      const current = view.state.doc.toString();
      if (current === text) return;
      // Programmatic loads (initial file open, sidebar property reload) must
      // never appear in the undo stack — Ctrl-Z should only revert edits the
      // user made themselves. Drop the history field, apply the replacement
      // outside of history, then re-add a fresh history field.
      view.dispatch({
        changes: { from: 0, to: current.length, insert: text },
        effects: historyCompartment.reconfigure([]),
        annotations: [
          Transaction.addToHistory.of(false),
          // Tells protectedChangeFilter to skip — otherwise the filter would
          // preserve the OLD #note(...) source against this full-doc replace,
          // shredding body content and leaving the editor visually broken
          // until the user switches tabs and back (which destroys + remounts).
          externalReload.of(true),
        ],
      });
      view.dispatch({
        effects: historyCompartment.reconfigure(history()),
      });
    },
    ensureParsed(timeout = 500) {
      ensureSyntaxTree(view.state, view.state.doc.length, timeout);
    },
    rebuildVisual() {
      // The naive path — ensureParsed + dispatch — is fragile: ensureSyntaxTree
      // may return early on large docs (timeout hits before parse completes),
      // and rebuildVisualDecorations then runs against a partial tree. Tree
      // iteration finds nothing, but pre-existing Replace decorations from the
      // prior doc may still anchor across the new content via mapping, leaving
      // the editor visually blank.
      //
      // Strategy: try a generous synchronous parse; if the tree still doesn't
      // span the doc, retry on rAF until it does (cap retries to avoid an
      // infinite loop on degenerate input). Always dispatch at least once so
      // visualField doesn't stay anchored to the old doc.
      const dispatch = () => {
        view.dispatch({ effects: rebuildVisualDecorations.of(null) });
      };
      const docLen = view.state.doc.length;
      ensureSyntaxTree(view.state, docLen, 2000);
      let tree = syntaxTree(view.state);
      if (tree.length >= docLen) {
        dispatch();
        return;
      }
      let attempts = 0;
      const tick = () => {
        attempts += 1;
        ensureSyntaxTree(view.state, view.state.doc.length, 1000);
        tree = syntaxTree(view.state);
        if (tree.length >= view.state.doc.length || attempts >= 10) {
          dispatch();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    setVisualMode(enabled: boolean) {
      isVisual = enabled;
      if (enabled) {
        ensureSyntaxTree(view.state, view.state.doc.length, 500);
      }
      view.dispatch({
        effects: [
          visualCompartment.reconfigure(enabled ? typstVisualMode() : []),
          activeLineCompartment.reconfigure(enabled ? [] : [highlightActiveLine(), highlightActiveLineGutter()]),
        ],
      });
    },
    setAutoExpand(enabled: boolean) {
      view.dispatch({
        effects: autoExpandCompartment.reconfigure(autoExpandFacet.of(enabled)),
      });
    },
    setFocusMode(mode: FocusMode, dim: boolean) {
      const ext = isVisual && mode !== "none"
        ? focusModeExtension(mode, dim)
        : [];
      view.dispatch({
        effects: focusModeCompartment.reconfigure(ext),
      });
    },
    setSmartIndentLists(enabled: boolean) {
      view.dispatch({
        effects: smartIndentCompartment.reconfigure(smartIndentListsFacet.of(enabled)),
      });
    },
    setLsp(client: LspClient | null, documentUri: string) {
      const exts = client && documentUri ? lspExtension(client, documentUri) : [];
      view.dispatch({
        effects: lspCompartment.reconfigure(exts),
      });
    },
    focus() {
      view.focus();
    },
    focusAtContent() {
      const ranges = view.state.field(protectedRangesField, false);
      let pos = 0;
      if (ranges && ranges.length > 0) {
        pos = Math.max(...ranges.map((r) => r.to));
      }
      pos = Math.min(pos, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    },
    setCursor(offset: number) {
      const pos = Math.min(offset, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    },
    serializeState() {
      return view.state.toJSON({ history: historyField });
    },
    destroy() {
      view.destroy();
    },
  };
}
