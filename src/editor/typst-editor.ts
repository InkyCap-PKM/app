import { Compartment, EditorState, Transaction, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, foldKeymap, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  searchKeymap,
  searchPanelOpen,
  openSearchPanel,
  closeSearchPanel,
} from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { lintKeymap, lintGutter } from "@codemirror/lint";
import { diagnosticTheme, ERROR_UNDERLINE_STYLE } from "./diagnostic-style";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { typstLanguage } from "./typst-language";

import { typstVisualMode, buildDecorations, autoExpandFacet, protectedRangesField, findStylePreamble, rebuildVisualDecorations, externalReload } from "./typst-decorations/visual-plugin";
import { cellEditorConfig } from "./typst-decorations/table-cell-editor";
import { verseFocusRouter, verseSearchHighlighter } from "./typst-decorations/widgets";
import { selectionToolbar } from "./typst-decorations/selection-toolbar";
import { commandPalette } from "./typst-decorations/command-palette";
import { sourceRawHighlight } from "./typst-decorations/source-raw-highlight";
import { importLineGuard } from "./typst-decorations/import-line-guard";
import { focusModeExtension, type FocusMode } from "./typst-decorations/focus-mode";
import { typewriterMode } from "./typst-decorations/typewriter-mode";
import { spellcheck, spellCheckerFacet } from "./typst-decorations/spellcheck";
import type { SpellChecker } from "../lib/spellchecker";
import {
  typstKeymap,
  smartIndentListsFacet,
  enterInsertsLineBreakFacet,
  autoPairBracketsFacet,
  autoPairBracketsExtension,
  autoPairBracketsKeymap,
} from "./typst-decorations/keymaps";
import { drawnCaret } from "./typst-decorations/drawn-caret";
import { domCaretResync } from "./typst-decorations/dom-caret-resync";
import { wikilinkSuggest } from "./typst-decorations/wikilink-suggest";
import { referenceSuggest } from "./typst-decorations/reference-suggest";
import { dragDropHandler } from "./typst-decorations/drag-drop";
import { listPasteHandler } from "./typst-decorations/list-paste";
import { autoPairTypstInput } from "./typst-decorations/auto-pair-typst";
import { markdownShortcuts } from "./typst-decorations/markdown-shortcuts";
import { headingTracker } from "./typst-decorations/heading-tracker";
import { annotationTracker } from "./typst-decorations/annotation-tracker";
import { typstFolding } from "./typst-decorations/folding";
import { wordCountTracker } from "./typst-decorations/word-count";
import { cursorPositionTracker } from "./typst-decorations/cursor-position";
import { lspExtension, visualModeFacet } from "./lsp";
import type { LspClient } from "./lsp";
import { inkycapSearch } from "./search-panel";
import {
  searchMatchHighlight,
  setSearchMatches,
  type SearchMatchRange,
} from "./typst-decorations/search-matches";
import { hiddenMatchPills } from "./typst-decorations/hidden-match-pills";

/**
 * Focus mode and dimming are independent; either needs the extension. Visual
 * editor only.
 */
function focusModeExtensionFor(mode: FocusMode, dim: boolean, isVisual: boolean) {
  return isVisual && (mode !== "none" || dim) ? focusModeExtension(mode, dim) : [];
}

export interface TypstEditorHandle {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  setVisualMode(enabled: boolean): void;
  setAutoExpand(enabled: boolean): void;
  setFocusMode(mode: FocusMode, dim: boolean): void;
  setTypewriterMode(enabled: boolean): void;
  /** Install (or clear with null) the spell checker that drives misspelling
   *  underlines. Built async from the active dictionaries by the caller. */
  setSpellChecker(checker: SpellChecker | null): void;
  setSmartIndentLists(enabled: boolean): void;
  setEnterInsertsLineBreak(enabled: boolean): void;
  setAutoPairBrackets(enabled: boolean): void;
  setSelectionToolbar(enabled: boolean): void;
  setCommandPalette(enabled: boolean): void;
  /**
   * Refresh editor UI holding translated strings after a language switch:
   * currently the search panel, which is rebuilt if open. Other CM6 surfaces
   * that capture strings belong here too.
   */
  relocalize(): void;
  ensureParsed(timeout?: number): void;
  /**
   * Rebuild the visual decorations from a fully parsed tree. Call after
   * `setText()` on external reloads, or stale replace ranges can blank the
   * editor.
   */
  rebuildVisual(): void;
  setLsp(client: LspClient | null, documentUri: string): void;
  focus(): void;
  focusAtContent(): void;
  setCursor(offset: number): void;
  /** Highlight every notebox-search match in the doc (pass `[]` to clear).
   *  Positions are line/char as returned by the search backend. */
  setSearchMatches(ranges: SearchMatchRange[]): void;
  /** Serialize doc + selection + undo history. Pair with `restoreState`. */
  serializeState(): unknown;
  /**
   * The scroll position as a document-anchored effect, for the `restoreScroll`
   * option.
   */
  scrollSnapshot(): StateEffect<unknown>;
  destroy(): void;
}

export interface TypstEditorOptions {
  parent: HTMLElement;
  doc?: string;
  readOnly?: boolean;
  visualMode?: boolean;
  smartIndentLists?: boolean;
  enterInsertsLineBreak?: boolean;
  /** Typing an opening bracket or quote adds the closing one. Default true. */
  autoPairBrackets?: boolean;
  typewriterMode?: boolean;
  /** Focus mode and dimming, applied at creation. Without them a fresh editor
   *  shows neither until the user next changes one of the two settings. */
  focusMode?: FocusMode;
  focusDim?: boolean;
  selectionToolbar?: boolean;
  commandPalette?: boolean;
  lspClient?: LspClient | null;
  documentUri?: string;
  onUpdate?: (text: string) => void;
  extensions?: Extension[];
  /**
   * State from `serializeState()`. When given, the doc, selection and undo
   * history are restored from it instead of starting from `doc`, so undo
   * survives tab switches.
   */
  restoreState?: unknown;
  /**
   * Effect from `scrollSnapshot()`, applied on first measure
   * (`EditorViewConfig.scrollTo`) so a reactivated tab returns to where the
   * reader was.
   */
  restoreScroll?: StateEffect<unknown>;
}

const inkycapTheme = EditorView.theme({
  "&": {
    height: "100%",
  },
  // Native browser selection, without CodeMirror's `drawSelection`, which
  // measures with `coordsAtPos` and can paint a whole row on WebKitGTK for lines
  // with large headings or pills. Tinted with `--bg-selection`, as the overrides
  // in visual-theme are. WebKitGTK only honours `background-color` inside
  // `::selection`.
  "& .cm-content ::selection": {
    backgroundColor: "var(--bg-selection)",
  },
  "& .cm-line::selection": {
    backgroundColor: "var(--bg-selection)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--md-body-font, var(--editor-font-body, sans-serif))",
    fontSize: "var(--md-body-size, 17px)",
  },
  ".cm-content": {
    // `max-width` and auto margins centre the column on wide screens. The
    // inline padding keeps a minimum gap to the panel edge on narrow ones, and
    // `max-width` adds it back so the column width is unchanged. It sits on
    // `.cm-content` so the gutter stays at the edge in source mode.
    //
    // Sizing stays border-box so the base theme's `min-height: 100%` includes
    // the scroll-past-end and typewriter padding; otherwise a short note would
    // scroll most of a screen past its end.
    maxWidth: "calc(var(--md-max-width, 100%) + 2 * var(--md-side-padding-min, 0px))",
    margin: "0 auto",
    paddingBlock: "1em",
    paddingInline: "var(--md-side-padding-min, 0px)",
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
  // The native caret is used, coloured by `caret-color` above. While searching,
  // only the current match is highlighted, so the all-match highlight isn't
  // confused with the "All" action (see search-panel.ts).
  ".cm-searchMatch": {
    backgroundColor: "transparent",
  },
  // The outline sets the current match apart from the others when "All" is
  // on, without relying on a second shade of the match colour.
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--bg-search-match)",
    outline: "1.5px solid var(--fg-muted)",
    borderRadius: "var(--radius-xs)",
  },
  // The search panel's "All" toggle adds this class to highlight every match.
  "&.cm-search-highlight-all .cm-searchMatch": {
    backgroundColor: "var(--bg-search-match)",
  },
  // The current Ctrl+F match inside a verse canvas (see verseSearchHighlighter
  // in widgets.ts), in the selected-match colour. `box-decoration-break` keeps
  // it continuous across a wrap.
  ".cm-typst-verse-canvas .cm-verse-search-hit": {
    backgroundColor: "var(--bg-search-match)",
    borderRadius: "var(--radius-xs)",
    "-webkit-box-decoration-break": "clone",
    boxDecorationBreak: "clone",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--bg-matching-bracket)",
    outline: "1px solid var(--border-subtle)",
  },
  ".cm-tooltip": {
    // Shared popup surface — see --popup-* tokens in themes.css.
    backgroundColor: "var(--popup-bg)",
    border: "1px solid var(--popup-border-color)",
    borderRadius: "var(--popup-radius)",
    boxShadow: "var(--popup-shadow)",
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
  ".cm-panels.cm-panels-bottom": {
    borderTop: "1px solid var(--border-subtle)",
    // Continue the content's lip shadow onto the panel's top edge, like the
    // editor header's (styles/layout/editor-header.css).
    position: "relative",
    zIndex: "2",
    boxShadow: "0 -4px 6px -4px var(--lip-shadow-status)",
  },
  // The Ctrl+F find/replace panel (DOM from search-panel.ts), styled with app
  // tokens and centred, with left-aligned rows.
  ".cm-panel.cm-search": {
    display: "flex",
    justifyContent: "center",
    padding: "6px 8px",
    fontSize: "var(--text-md)",
    color: "var(--fg-primary)",
  },
  // The disclosure toggle sits beside the rows-column; both rows share the
  // column's left edge, so Find and Replace line up with no manual indent.
  ".cm-search__body": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  ".cm-search__rows": {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "6px",
  },
  ".cm-search__row": {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "6px",
  },
  ".cm-search__row--replace": {
    display: "none",
  },
  ".cm-search--replace-open .cm-search__row--replace": {
    display: "flex",
  },
  // Wrapper for a text field and its clear button. A plain block, so its height
  // is the input's; Find and Replace share one width so the rows align.
  ".cm-search__field": {
    position: "relative",
    display: "block",
    width: "20em",
  },
  ".cm-panel.cm-search .cm-textfield": {
    background: "var(--bg-input)",
    color: "var(--fg-primary)",
    border: "1px solid var(--border-input)",
    borderRadius: "var(--radius-sm)",
    // Right padding leaves room for the clear button.
    padding: "5px 26px 5px 8px",
    fontSize: "var(--text-md)",
    outline: "none",
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    // Clear the margin @codemirror/search's base theme puts on every control in
    // the panel.
    margin: "0",
  },
  // Qualified with `.cm-panel.cm-search` to beat the base theme's
  // `.cm-panel.cm-search button` rule, whose top margin pushed the button off
  // centre.
  ".cm-panel.cm-search .cm-search__clear": {
    // Positioned over the input's reserved right padding, so it sits inside the
    // field and showing or hiding it never reflows the row. Centred against the
    // wrapper, as in the references-panel filter.
    margin: "0",
    position: "absolute",
    right: "6px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "16px",
    height: "16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--bg-secondary)",
    border: "none",
    borderRadius: "50%",
    color: "var(--fg-muted)",
    cursor: "pointer",
    padding: "0",
  },
  ".cm-panel.cm-search .cm-search__clear:hover": {
    background: "var(--bg-hover)",
    color: "var(--fg-primary)",
  },
  ".cm-panel.cm-search .cm-search__clear[hidden]": {
    display: "none",
  },
  // "{n} of {m}", positioned inside the field just left of the clear button, so
  // it never reflows the row. `updateCount` reserves matching padding on the
  // input. Tabular figures keep its width steady.
  ".cm-panel.cm-search .cm-search__count": {
    position: "absolute",
    right: "28px",
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: "var(--text-sm)",
    color: "var(--fg-dim)",
    pointerEvents: "none",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-panel.cm-search .cm-search__count[hidden]": {
    display: "none",
  },
  ".cm-panel.cm-search .cm-textfield:focus": {
    borderColor: "var(--accent)",
  },
  // Buttons mirror the app's toolbar buttons — a flat, bordered control
  // rather than the default CodeMirror button, which read as pre-pressed.
  ".cm-panel.cm-search .cm-button": {
    background: "none",
    backgroundImage: "none",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-sm)",
    color: "var(--fg-muted)",
    cursor: "pointer",
    padding: "4px 10px",
    fontSize: "var(--text-sm)",
  },
  ".cm-panel.cm-search .cm-button:hover": {
    borderColor: "var(--fg-dim)",
    color: "var(--fg-primary)",
    background: "none",
  },
  ".cm-panel.cm-search .cm-button:active": {
    background: "var(--bg-active)",
  },
  // Action buttons are kept close together but each stays a self-contained
  // button — its own border, fully rounded on every corner.
  ".cm-search__group": {
    display: "inline-flex",
    gap: "4px",
  },
  // The "All" button is a toggle; reflect its on-state.
  ".cm-panel.cm-search .cm-button.is-active": {
    background: "var(--bg-active)",
    borderColor: "var(--fg-dim)",
    color: "var(--fg-primary)",
  },
  ".cm-panel.cm-search .cm-button--icon": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px 8px",
  },
  ".cm-panel.cm-search .cm-button--icon svg": {
    display: "block",
  },
  ".cm-search__option": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "var(--text-sm)",
    color: "var(--fg-secondary)",
    cursor: "pointer",
  },
  ".cm-search__option input": {
    accentColor: "var(--accent)",
    cursor: "pointer",
    margin: "0",
  },
  ".cm-search__disclosure": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "1px solid transparent",
    borderRadius: "var(--radius-control)",
    color: "var(--fg-muted)",
    cursor: "pointer",
    padding: "0",
    // border-box keeps the rendered width at exactly 26px (border included)
    // so the Replace row's 32px indent lines up with the Find field.
    boxSizing: "border-box",
    width: "26px",
    height: "26px",
  },
  ".cm-search__disclosure:hover": {
    background: "var(--bg-hover)",
    color: "var(--fg-primary)",
  },
  ".cm-search__disclosure svg": {
    transition: "transform 0.12s",
  },
  ".cm-search--replace-open .cm-search__disclosure svg": {
    transform: "rotate(90deg)",
  },
  ".cm-search__close": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "1px solid transparent",
    borderRadius: "var(--radius-control)",
    color: "var(--fg-muted)",
    cursor: "pointer",
    fontSize: "18px",
    lineHeight: "1",
    padding: "0",
    width: "28px",
    height: "28px",
  },
  ".cm-search__close:hover": {
    background: "var(--bg-hover)",
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
  { tag: tags.invalid, color: "var(--accent-danger)", textDecoration: `underline ${ERROR_UNDERLINE_STYLE}` },
]);

// Scroll past the end, half as far as CodeMirror's `scrollPastEnd()`: the last
// line rises to about the middle. Works like CM's plugin (padding through
// contentAttributes), with no real lines added.
const scrollPastEndHalf = (() => {
  const plugin = ViewPlugin.fromClass(
    class {
      height = 0;
      attrs: { style: string } = { style: "padding-bottom: 0px" };
      update(update: { view: EditorView }) {
        // Use the cached editor height, as CM's own plugin does; reading
        // `clientHeight` would force a reflow.
        const view = update.view as EditorView & { viewState: { editorHeight: number } };
        const full = view.viewState.editorHeight
          - view.defaultLineHeight - view.documentPadding.top - 0.5;
        const height = Math.max(0, full * 0.5);
        if (height !== this.height) {
          this.height = height;
          this.attrs = { style: `padding-bottom: ${height}px` };
        }
      }
    },
  );
  return [
    plugin,
    EditorView.contentAttributes.of((view) => view.plugin(plugin)?.attrs ?? null),
  ];
})();

// Lines kept visible below the cursor when the editor scrolls it into view.
const CURSOR_BOTTOM_MARGIN_LINES = 2;

// Only when the editor scrolls to the cursor (typing, arrows, jumps), not for
// wheel or scrollbar. Typewriter mode centres the caret instead.
const cursorBottomMargin = EditorView.scrollMargins.of((view) => ({
  bottom: view.defaultLineHeight * CURSOR_BOTTOM_MARGIN_LINES,
}));

/**
 * A table cell editor's configuration: the note's language, theme, caret,
 * bracket and input helpers, inline-only visual decorations and the suggestion
 * popups. The note's editor owns undo history and spell-check; the cell editor
 * uses the latter and forwards the former (see table-cell-editor.ts).
 */
function tableCellEditorConfig(options: TypstEditorOptions): Extension {
  return cellEditorConfig.of({
    extensions: (main) => {
      const checker = main.state.facet(spellCheckerFacet);
      return [
        typstLanguage(),
        syntaxHighlighting(inkycapHighlight),
        inkycapTheme,
        drawnCaret,
        domCaretResync,
        // The cell editor needs its own copy of the pairing setting, read from
        // the note when the cell opens.
        autoPairBracketsExtension(main.state.facet(autoPairBracketsFacet)),
        autocompletion({ activateOnTyping: true }),
        tooltips({ position: "fixed" }),
        autoPairTypstInput,
        markdownShortcuts,
        keymap.of([...typstKeymap, ...autoPairBracketsKeymap, ...defaultKeymap, ...completionKeymap]),
        typstVisualMode({ inlineOnly: true }),
        wikilinkSuggest,
        referenceSuggest,
        options.commandPalette !== false ? commandPalette : [],
        checker ? [spellcheck, spellCheckerFacet.of(checker)] : [],
      ];
    },
    inlineDecorations: (state, from, to) => buildDecorations(state, [{ from, to }], { inlineOnly: true }),
  });
}

function baseExtensions(options: TypstEditorOptions): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightSpecialChars(),
    // Folding (headings and nested lists) is in the base config, so it works in
    // both modes and survives switching. It uses a hover chevron, so there's no
    // fold gutter. See folding.ts.
    typstFolding(),
    // No rectangular selection or Alt crosshair: they add little in a prose
    // editor, and the crosshair appeared whenever Alt was held (e.g. for
    // Alt-Shift line moves).
    indentOnInput(),
    bracketMatching(),
    autocompletion({ activateOnTyping: true }),
    tooltips({ position: "fixed" }),
    autoPairTypstInput,
    markdownShortcuts,
    keymap.of([
      ...typstKeymap,
      ...autoPairBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    typstLanguage(),
    drawnCaret,
    domCaretResync,
    inkycapSearch,
    searchMatchHighlight,
    hiddenMatchPills,
    syntaxHighlighting(inkycapHighlight),
    sourceRawHighlight(),
    importLineGuard(),
    inkycapTheme,
    listPasteHandler,
    dragDropHandler,
    headingTracker,
    annotationTracker,
    wordCountTracker,
    cursorPositionTracker,
    lintGutter(),
    diagnosticTheme,
    EditorView.lineWrapping,
    // Scroll past the end (see scrollPastEndHalf).
    scrollPastEndHalf,
    cursorBottomMargin,
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

/// Read-only Typst extensions for showing note source outside the editor (the
/// review diff's `@codemirror/merge` panes), with the same parser, highlighting
/// and theme.
export function readOnlyTypstExtensions(): Extension[] {
  return [
    typstLanguage(),
    syntaxHighlighting(inkycapHighlight),
    inkycapTheme,
    EditorView.lineWrapping,
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
  ];
}

/// Editable Typst extensions for a standalone editor that isn't a note, such as
/// the collection's "Custom Typst" dialog. Same parser, highlighting and theme,
/// without visual mode, LSP, wikilinks or note decorations: history, brackets,
/// indentation and the standard keymaps.
export function editableTypstExtensions(options: { autoPairBrackets?: boolean } = {}): Extension[] {
  return [
    lineNumbers(),
    history(),
    indentOnInput(),
    bracketMatching(),
    autoPairBracketsExtension(options.autoPairBrackets !== false),
    keymap.of([
      ...autoPairBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    typstLanguage(),
    syntaxHighlighting(inkycapHighlight),
    inkycapTheme,
    EditorView.lineWrapping,
  ];
}

export function createTypstEditor(options: TypstEditorOptions): TypstEditorHandle {
  const visualCompartment = new Compartment();
  const autoExpandCompartment = new Compartment();
  const lspCompartment = new Compartment();
  const focusModeCompartment = new Compartment();
  const typewriterCompartment = new Compartment();
  const spellcheckCompartment = new Compartment();
  const activeLineCompartment = new Compartment();
  const smartIndentCompartment = new Compartment();
  const enterLineBreakCompartment = new Compartment();
  const autoPairCompartment = new Compartment();
  // `history()` is in a compartment so `setText()` can reset undo for new
  // content; old offsets against a replaced doc could otherwise empty the file
  // on undo.
  const historyCompartment = new Compartment();
  const selectionToolbarCompartment = new Compartment();
  const commandPaletteCompartment = new Compartment();
  // The visual-mode extensions, used for both the initial config and
  // `setVisualMode()` so the two can't drift. Folding isn't here; it is in the
  // base config (see typstFolding).
  const visualModeExtensions = () => [
    typstVisualMode(), verseFocusRouter, verseSearchHighlighter,
    wikilinkSuggest, referenceSuggest, visualModeFacet.of(true),
    tableCellEditorConfig(options),
  ];
  const visualExts = options.visualMode ? visualModeExtensions() : [];
  const activeLineExts = options.visualMode ? [] : [highlightActiveLine(), highlightActiveLineGutter()];
  const lspExts = options.lspClient && options.documentUri
    ? lspExtension(options.lspClient, options.documentUri)
    : [];

  let isVisual = !!options.visualMode;
  let toolbarEnabled = options.selectionToolbar !== false;
  let paletteEnabled = options.commandPalette !== false;
  let typewriterEnabled = !!options.typewriterMode;
  let focusModeSetting: FocusMode = options.focusMode ?? "none";
  let focusDimSetting = !!options.focusDim;
  // The automatic `\` on Enter is visual-mode only: the visual editor hides it
  // as a soft break (see visual-plugin.ts), while in source mode Enter is a
  // plain newline. The facet is recomputed from the setting and the mode
  // whenever either changes (see setVisualMode / setEnterInsertsLineBreak).
  let enterLineBreakSetting = options.enterInsertsLineBreak !== false;

  const stateConfig = {
    doc: options.doc ?? "",
    extensions: [
      ...baseExtensions(options),
      visualCompartment.of(visualExts),
      autoExpandCompartment.of(autoExpandFacet.of(false)),
      lspCompartment.of(lspExts),
      focusModeCompartment.of(focusModeExtensionFor(focusModeSetting, focusDimSetting, isVisual)),
      typewriterCompartment.of(options.typewriterMode && isVisual ? typewriterMode() : []),
      // Spellcheck underlining is installed later via setSpellChecker once the
      // dictionaries have loaded (async); starts empty.
      spellcheckCompartment.of([]),
      activeLineCompartment.of(activeLineExts),
      smartIndentCompartment.of(smartIndentListsFacet.of(!!options.smartIndentLists)),
      autoPairCompartment.of(autoPairBracketsExtension(options.autoPairBrackets !== false)),
      enterLineBreakCompartment.of(enterInsertsLineBreakFacet.of(enterLineBreakSetting && isVisual)),
      selectionToolbarCompartment.of(options.selectionToolbar !== false && options.visualMode ? selectionToolbar : []),
      commandPaletteCompartment.of(options.commandPalette !== false && options.visualMode ? commandPalette : []),
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
    scrollTo: options.restoreScroll,
  });

  return {
    view,
    getText() {
      return view.state.doc.toString();
    },
    setText(text: string) {
      const current = view.state.doc.toString();
      if (current === text) return;
      // Programmatic loads stay out of the undo stack: remove the history
      // field, replace the text, then add a fresh one.
      view.dispatch({
        changes: { from: 0, to: current.length, insert: text },
        effects: historyCompartment.reconfigure([]),
        annotations: [
          Transaction.addToHistory.of(false),
          // Tells protectedChangeFilter to skip, or it would keep the old
          // `#note(...)` against this whole-document replace and break the
          // content.
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
      // `ensureParsed` can time out on large docs, leaving a partial tree, and
      // old replace decorations can then blank the new content. So parse
      // generously, retry on each frame (a limited number of times) until the
      // tree covers the doc, and always dispatch at least once.
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
          visualCompartment.reconfigure(enabled ? visualModeExtensions() : []),
          activeLineCompartment.reconfigure(enabled ? [] : [highlightActiveLine(), highlightActiveLineGutter()]),
          selectionToolbarCompartment.reconfigure(enabled && toolbarEnabled ? selectionToolbar : []),
          commandPaletteCompartment.reconfigure(enabled && paletteEnabled ? commandPalette : []),
          // Typewriter scrolling is visual-mode only, like focus mode.
          typewriterCompartment.reconfigure(enabled && typewriterEnabled ? typewriterMode() : []),
          focusModeCompartment.reconfigure(focusModeExtensionFor(focusModeSetting, focusDimSetting, enabled)),
          // Automatic line breaks are visual-mode only.
          enterLineBreakCompartment.reconfigure(enterInsertsLineBreakFacet.of(enterLineBreakSetting && enabled)),
        ],
      });
    },
    setAutoExpand(enabled: boolean) {
      view.dispatch({
        effects: autoExpandCompartment.reconfigure(autoExpandFacet.of(enabled)),
      });
    },
    relocalize() {
      // The search panel builds its labels when it opens, so only an already
      // open one is stale: close and reopen it, keeping the query.
      if (searchPanelOpen(view.state)) {
        closeSearchPanel(view);
        openSearchPanel(view);
      }
    },
    setFocusMode(mode: FocusMode, dim: boolean) {
      focusModeSetting = mode;
      focusDimSetting = dim;
      view.dispatch({
        effects: focusModeCompartment.reconfigure(focusModeExtensionFor(mode, dim, isVisual)),
      });
    },
    setTypewriterMode(enabled: boolean) {
      typewriterEnabled = enabled;
      // Typewriter scrolling is a visual-editor affordance (mirrors focus
      // mode's gating) — source mode keeps ordinary scroll behaviour.
      view.dispatch({
        effects: typewriterCompartment.reconfigure(enabled && isVisual ? typewriterMode() : []),
      });
    },
    setSpellChecker(checker: SpellChecker | null) {
      view.dispatch({
        effects: spellcheckCompartment.reconfigure(
          checker ? [spellcheck, spellCheckerFacet.of(checker)] : [],
        ),
      });
    },
    setSmartIndentLists(enabled: boolean) {
      view.dispatch({
        effects: smartIndentCompartment.reconfigure(smartIndentListsFacet.of(enabled)),
      });
    },
    setAutoPairBrackets(enabled: boolean) {
      view.dispatch({
        effects: autoPairCompartment.reconfigure(autoPairBracketsExtension(enabled)),
      });
    },
    setEnterInsertsLineBreak(enabled: boolean) {
      enterLineBreakSetting = enabled;
      view.dispatch({
        effects: enterLineBreakCompartment.reconfigure(enterInsertsLineBreakFacet.of(enabled && isVisual)),
      });
    },
    setSelectionToolbar(enabled: boolean) {
      toolbarEnabled = enabled;
      view.dispatch({
        effects: selectionToolbarCompartment.reconfigure(enabled && isVisual ? selectionToolbar : []),
      });
    },
    setCommandPalette(enabled: boolean) {
      paletteEnabled = enabled;
      view.dispatch({
        effects: commandPaletteCompartment.reconfigure(enabled && isVisual ? commandPalette : []),
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
      const doc = view.state.doc;
      const ranges = view.state.field(protectedRangesField, false);
      let pos = 0;
      if (ranges && ranges.length > 0) {
        pos = Math.max(...ranges.map((r) => r.to));
      }
      // Also skip the collapsible style preamble (#set/#show/#let), which isn't
      // protected; otherwise the cursor lands in it and expands the chip. `.to`
      // is a line end, so +1 is the next line.
      const preamble = findStylePreamble(view.state);
      if (preamble) pos = Math.max(pos, Math.min(preamble.to + 1, doc.length));
      pos = Math.min(pos, doc.length);
      // Snap to the first non-blank line at/after `pos` so the cursor never sits
      // on the (now-hidden) preamble or a leading blank line.
      let lineNo = doc.lineAt(pos).number;
      while (lineNo < doc.lines && doc.line(lineNo).text.trim() === "") lineNo++;
      view.dispatch({ selection: { anchor: doc.line(lineNo).from } });
      view.focus();
    },
    setCursor(offset: number) {
      const pos = Math.min(offset, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    },
    setSearchMatches(ranges: SearchMatchRange[]) {
      view.dispatch({ effects: setSearchMatches.of(ranges) });
    },
    serializeState() {
      return view.state.toJSON({ history: historyField });
    },
    scrollSnapshot() {
      return view.scrollSnapshot();
    },
    destroy() {
      view.destroy();
    },
  };
}
