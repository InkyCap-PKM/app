import { Compartment, EditorState, Prec, StateField, Transaction, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, foldKeymap, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  searchKeymap,
  searchPanelOpen,
  openSearchPanel,
  closeSearchPanel,
} from "@codemirror/search";
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
// Characters whose insertion/deletion can open or close a parse region much
// larger than the edit itself: raw/inline-code fences (`` ` ``), math (`$`),
// and the bracket/brace/paren delimiters of content blocks, code, and function
// calls. A single-character edit to one of these forces a full reparse (see
// the call site) because the incremental parser doesn't reliably restructure
// the affected region — most visibly when re-closing an unterminated fence.
const STRUCTURAL_DELIMITER = /[`$()[\]{}]/;

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

      // First pass — decide whether we must full-clear, WITHOUT touching the
      // WASM parser. A multi-region transaction (alt-up/down move,
      // find-replace-all, multi-cursor) or any line-spanning change leaves the
      // incremental tree mismatched against the post-doc; for those we drop the
      // parser's state and reparse from scratch (clearParser). Critically, when
      // we're going to clearParser() anyway we must NOT call edit() first: a
      // full-document / multi-region replace (e.g. inserting a scaffold, which
      // replaces 0..len) makes the incremental edit() panic inside the WASM
      // parser ("unreachable" / "recursive use of an object … unsafe
      // aliasing"), poisoning it for every subsequent edit. clearParser()
      // reparses from the live doc, so those edit() calls are pointless as well
      // as dangerous.
      let changeCount = 0;
      let crossesLine = false;
      let structural = false;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changeCount++;
        const removed = tr.startState.doc.sliceString(fromA, toA);
        const ins = inserted.toString();
        if (removed.includes("\n") || ins.includes("\n")) {
          crossesLine = true;
        }
        // Editing a structural delimiter — a raw-block / inline-code backtick,
        // a math `$`, or a bracket/brace/paren — can open or close a region
        // that spans far beyond the edit. Closing a previously-unterminated
        // code fence, for instance, must turn a Raw node that swallowed the
        // rest of the document back into normal markup. The WASM parser's
        // *incremental* tree edit doesn't restructure that reliably: the fence
        // stays "open", everything below stays raw red source, and wikilinks
        // there die — and don't come back when the user re-adds the backtick.
        // A from-scratch reparse (clearParser, below) always recovers, so we
        // treat any delimiter edit like a multi-region change.
        if (STRUCTURAL_DELIMITER.test(removed) || STRUCTURAL_DELIMITER.test(ins)) {
          structural = true;
        }
      });

      if (isHistory || changeCount > 1 || crossesLine || structural) {
        wasm.clearParser();
        return null;
      }

      // Incremental path: a single, in-line (no-newline) change — the normal
      // typing case the WASM parser handles reliably. Keep it in sync via
      // edit() and apply the returned tree edits.
      const collected: unknown[] = [];
      let needsFullClear = false;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const result = wasm.parser?.edit(fromA, toA, inserted.toString());
        if (!result) return;
        if (result.full_update) {
          needsFullClear = true;
        } else if (!needsFullClear && result.edits) {
          for (const e of result.edits) collected.push(e);
        }
      });

      if (needsFullClear) {
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

import { typstVisualMode, autoExpandFacet, protectedRangesField, findStylePreamble, rebuildVisualDecorations, externalReload } from "./typst-decorations/visual-plugin";
import { verseFocusRouter, verseSearchHighlighter } from "./typst-decorations/widgets";
import { selectionToolbar } from "./typst-decorations/selection-toolbar";
import { commandPalette } from "./typst-decorations/command-palette";
import { sourceRawHighlight } from "./typst-decorations/source-raw-highlight";
import { importLineGuard } from "./typst-decorations/import-line-guard";
import { focusModeExtension, type FocusMode } from "./typst-decorations/focus-mode";
import { typewriterMode } from "./typst-decorations/typewriter-mode";
import { spellcheck, spellCheckerFacet } from "./typst-decorations/spellcheck";
import type { SpellChecker } from "../lib/spellchecker";
import { typstKeymap, smartIndentListsFacet, enterInsertsLineBreakFacet } from "./typst-decorations/keymaps";
import { drawnCaret } from "./typst-decorations/drawn-caret";
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
  setSelectionToolbar(enabled: boolean): void;
  setCommandPalette(enabled: boolean): void;
  /** Refresh editor-owned UI that captured translated strings, after a
   *  UI-language switch. Today that's the search panel (its labels are built
   *  on open); a panel that's open during the switch is rebuilt so its strings
   *  update live. This is the editor-side extension point for i18n: as more
   *  CM6 surfaces (selection toolbar, command palette) move onto `t(...)` in a
   *  later phase, their compartment reconfigures belong here too. */
  relocalize(): void;
  ensureParsed(timeout?: number): void;
  /** Force the visual decoration field to rebuild from a fully-parsed tree.
   *  Call after setText() during external reloads (sidebar property edits)
   *  to avoid stale Replace ranges blanking the editor. */
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
  /** Capture the current scroll position as a document-anchored effect. Pair
   *  with the `restoreScroll` option so a remount of this tab returns the
   *  reader to where they left off. */
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
  typewriterMode?: boolean;
  selectionToolbar?: boolean;
  commandPalette?: boolean;
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
  /**
   * Scroll effect from a previous `scrollSnapshot()` call. When provided, the
   * view restores this scroll position on its first measure (via CM6's
   * `EditorViewConfig.scrollTo`), so reactivating a tab returns the reader to
   * where they had scrolled rather than the top of the document.
   */
  restoreScroll?: StateEffect<unknown>;
}

const inkycapTheme = EditorView.theme({
  "&": {
    height: "100%",
  },
  // Selection: native browser selection (no `drawSelection` layer). CodeMirror's
  // drawn selection measures each endpoint with `coordsAtPos`, which is
  // unreliable on WebKitGTK for lines with non-trivial inline structure — a
  // large-font heading span, or a leading pill widget — so a partial selection
  // could paint the whole row. The browser's own `::selection` paints directly
  // on the selected glyphs with no measurement, so it is always exact. We tint
  // it with `--bg-selection` (the same translucent colour the opaque-span
  // `::selection` overrides in visual-theme use, so the whole selection reads as
  // one colour). WebKitGTK honours only `background-color` inside `::selection`,
  // not the `background` shorthand.
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
  // No `.cm-cursor` rule: the editor uses the native caret (no `drawSelection`
  // layer), coloured via `caret-color` on `.cm-content` above.
  // Only the current match is highlighted while searching — the always-on
  // all-match highlight is suppressed so it can't be confused with the
  // "All" (select-all-matches) action. See search-panel.ts.
  ".cm-searchMatch": {
    backgroundColor: "transparent",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--bg-search-match)",
  },
  // The search panel's "All" toggle adds this class to the editor root to
  // bring back the highlight on every match (otherwise only the current
  // match is shown). See search-panel.ts.
  "&.cm-search-highlight-all .cm-searchMatch": {
    backgroundColor: "var(--bg-search-match)",
  },
  // Current Ctrl+F match painted inside a verse canvas (see
  // verseSearchHighlighter in widgets.ts). CM's own match highlight can't
  // reach into the atomic verse widget, so this mirrors the selected-match
  // colour there. `box-decoration-break` keeps the background continuous if
  // the match wraps across a line within the canvas.
  ".cm-typst-verse-canvas .cm-verse-search-hit": {
    backgroundColor: "var(--bg-search-match)",
    borderRadius: "2px",
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
    // Carry the content area's bottom "lip" shadow onto the panel's top edge
    // so editor content still appears to slide underneath when the panel is
    // open. Mirrors the editor header's lip (.editor-header in
    // styles/layout/editor-header.css).
    position: "relative",
    zIndex: "2",
    boxShadow: "0 -4px 6px -4px rgba(0, 0, 0, 0.22)",
  },
  // In-page find/replace panel (Ctrl+F). InkyCap supplies its own panel DOM
  // (see search-panel.ts); these rules style it with app tokens so it reads
  // correctly in both themes and matches the rest of the UI. The whole block
  // is centred horizontally while its rows stay left-justified within it.
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
  // Each text field is wrapped so a clear button can sit at its right edge.
  // Find and Replace share one width so the two rows align cleanly.
  // Wraps a text field + its clear button; the relative box the absolutely
  // positioned clear button centres against. A plain block, so its height is
  // exactly the input's — like the references-panel filter field.
  ".cm-search__field": {
    position: "relative",
    display: "block",
    width: "20em",
  },
  ".cm-panel.cm-search .cm-textfield": {
    background: "var(--bg-input)",
    color: "var(--fg-primary)",
    border: "1px solid var(--border-input)",
    borderRadius: "4px",
    // Right padding leaves room for the clear button.
    padding: "5px 26px 5px 8px",
    fontSize: "var(--text-md)",
    outline: "none",
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    // @codemirror/search's base theme sets `margin: .2em .6em .2em 0` on every
    // input/button/label under .cm-panel.cm-search; clear it so the field's
    // box height is exactly the input and nothing is nudged off-axis.
    margin: "0",
  },
  // Selector is qualified with `.cm-panel.cm-search` so it out-specifies
  // @codemirror/search's base-theme rule `.cm-panel.cm-search button`
  // (0,2,1), which sets `margin: .2em .6em .2em 0` on every button in the
  // panel. On this absolutely positioned button that .2em top margin pushed
  // it ~3px below centre; a bare `.cm-search__clear` (0,2,0) loses the
  // cascade, so the margin reset below only takes effect at this specificity.
  ".cm-panel.cm-search .cm-search__clear": {
    // Absolutely positioned inside the field wrapper (which is
    // position:relative) over the input's reserved 26px right padding, so it
    // sits *within* the text-entry box rather than after it. Being out of
    // normal flow, toggling its visibility with the field's contents never
    // reflows the row — the Next/Previous/All buttons stay put.
    //
    // Vertically centred against the (block) wrapper, which is exactly the
    // input's height — the same recipe the references-panel filter clear uses.
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
  // "{n} of {m}" indicator, absolutely positioned inside the field just left
  // of the clear button (which sits at right:6px, ~22px wide). Out of normal
  // flow like the clear button, so showing/hiding it never reflows the row.
  // `updateCount` reserves matching right-padding on the input so typed text
  // never slides under it. Dim hint colour, tabular figures so the width
  // doesn't jitter as the digits change while stepping through matches.
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
    borderRadius: "4px",
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
  { tag: tags.invalid, color: "var(--accent-danger)", textDecoration: "underline wavy" },
]);

// Obsidian-style "scroll past the end", but half as far as CodeMirror's
// built-in `scrollPastEnd()`. The stock version pads the bottom by a full
// editor height (last line scrolls to the very top); we want the last line to
// rise only to roughly the middle, so we use half that. Mirrors CM's own
// plugin (padding via the contentAttributes facet) — non-typable space, no
// real blank lines inserted.
const scrollPastEndHalf = (() => {
  const plugin = ViewPlugin.fromClass(
    class {
      height = 0;
      attrs: { style: string } = { style: "padding-bottom: 0px" };
      update(update: { view: EditorView }) {
        // Use the cached editor height (same field CM's own scrollPastEnd
        // reads) rather than `scrollDOM.clientHeight`, which would force a
        // synchronous reflow on every update.
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

function baseExtensions(options: TypstEditorOptions): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightSpecialChars(),
    // Outliner folding (headings + nested list items) lives in the base config,
    // not the visual-mode compartment, so folds work in both source and visual
    // mode and survive switching between them. Uses a hover chevron, so the
    // standard fold gutter is deliberately omitted. See folding.ts.
    typstFolding(),
    // Rectangular selection + the Alt "crosshair" cursor are code-editor
    // affordances: in a prose/notebox editor they add little, and the crosshair
    // turned holding Alt (e.g. for the Alt-Shift line-move shortcut) into a
    // confusing "+" pointer. Dropped in favour of plain prose-style selection.
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true }),
    tooltips({ position: "fixed" }),
    autoPairTypstInput,
    markdownShortcuts,
    keymap.of([
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
    drawnCaret,
    inkycapSearch,
    searchMatchHighlight,
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
    EditorView.lineWrapping,
    // Obsidian-style "scroll past the end": lets the last line scroll up toward
    // the middle of the viewport instead of staying pinned to the bottom while
    // typing. Half the reach of CM's built-in scrollPastEnd (see definition).
    scrollPastEndHalf,
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

/// Minimal read-only Typst rendering extensions, for embedding note source in
/// a non-editing surface (the collaboration review diff's `@codemirror/merge`
/// panes). Reuses the same parser, highlight style, and theme as the main
/// editor so the markup reads identically — but with editing disabled. Kept
/// here so Typst highlighting stays owned by one module.
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

/// Minimal *editable* Typst extensions for a standalone editor that isn't a
/// note — e.g. the collection's "Custom Typst" modal. Reuses the same parser,
/// highlight style, and theme as the main editor so markup reads identically,
/// but omits the note-only machinery (visual mode, LSP, wikilinks, decoration
/// trackers). Editing essentials only: history, bracket matching/closing,
/// indentation, and the standard keymaps.
export function editableTypstExtensions(): Extension[] {
  return [
    lineNumbers(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    keymap.of([
      ...closeBracketsKeymap,
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
  // history() lives in a compartment so setText() can reset the undo stack
  // when loading new file content — otherwise prior edits' offsets persist
  // against a freshly-replaced doc and Ctrl-Z eventually empties the file.
  const historyCompartment = new Compartment();
  const selectionToolbarCompartment = new Compartment();
  const commandPaletteCompartment = new Compartment();
  // Single source of truth for the visual-mode extension set, used both for the
  // initial config and for setVisualMode()'s compartment reconfigure — so the
  // two can never drift (a past drift silently dropped the suggest popups and
  // verse search highlighting when toggling source→visual). Note: folding is
  // NOT here — it lives in the base config so folds persist across mode
  // switches (see typstFolding in baseExtensions).
  const visualModeExtensions = () => [
    typstVisualMode(), verseFocusRouter, verseSearchHighlighter,
    wikilinkSuggest, referenceSuggest, visualModeFacet.of(true),
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
  // The auto-`\` linebreak is a *visual-mode* affordance: pressing Enter there
  // inserts a Typst linebreak that the visual editor renders invisibly and
  // manages as an atomic "soft break" (see visual-plugin.ts), so the writer
  // sees a real new line without ever touching the `\`. Source mode never
  // auto-inserts the `\` — Enter stays a plain newline there; the `\` only
  // becomes *visible* in source mode (as ordinary text) once it exists. The
  // keymap stays a pure consumer of the facet; this closure recomputes the
  // effective value (setting AND visual mode) whenever either the setting or
  // the mode changes (see setVisualMode / setEnterInsertsLineBreak below).
  let enterLineBreakSetting = options.enterInsertsLineBreak !== false;

  const stateConfig = {
    doc: options.doc ?? "",
    extensions: [
      ...baseExtensions(options),
      visualCompartment.of(visualExts),
      autoExpandCompartment.of(autoExpandFacet.of(false)),
      lspCompartment.of(lspExts),
      focusModeCompartment.of([]),
      typewriterCompartment.of(options.typewriterMode && isVisual ? typewriterMode() : []),
      // Spellcheck underlining is installed later via setSpellChecker once the
      // dictionaries have loaded (async); starts empty.
      spellcheckCompartment.of([]),
      activeLineCompartment.of(activeLineExts),
      smartIndentCompartment.of(smartIndentListsFacet.of(!!options.smartIndentLists)),
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
          visualCompartment.reconfigure(enabled ? visualModeExtensions() : []),
          activeLineCompartment.reconfigure(enabled ? [] : [highlightActiveLine(), highlightActiveLineGutter()]),
          selectionToolbarCompartment.reconfigure(enabled && toolbarEnabled ? selectionToolbar : []),
          commandPaletteCompartment.reconfigure(enabled && paletteEnabled ? commandPalette : []),
          // Typewriter scrolling is visual-mode only, like focus mode.
          typewriterCompartment.reconfigure(enabled && typewriterEnabled ? typewriterMode() : []),
          // Auto-linebreak is visual-mode only; entering visual mode turns it
          // on (subject to the setting), leaving it returns Enter to a plain
          // newline in source mode.
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
      // The search panel builds its labels via `t(...)` in its constructor,
      // so a panel opened AFTER the switch already shows the new language.
      // Only an already-open panel is stale — close and reopen it to rebuild.
      // Both commands preserve the active query.
      if (searchPanelOpen(view.state)) {
        closeSearchPanel(view);
        openSearchPanel(view);
      }
    },
    setFocusMode(mode: FocusMode, dim: boolean) {
      const ext = isVisual && mode !== "none"
        ? focusModeExtension(mode, dim)
        : [];
      view.dispatch({
        effects: focusModeCompartment.reconfigure(ext),
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
      // Also skip past the collapsible style/code preamble (#set/#show/#let),
      // whose range isn't in protectedRangesField. Otherwise the cursor lands on
      // it and the preamble chip auto-expands the moment a note opens. (`.to` is
      // a line end, so +1 steps onto the next line.)
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
