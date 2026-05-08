// Source-mode highlighter for embedded code inside Typst raw blocks.
//
// In source mode the existing Typst highlighter colors `Raw` nodes uniformly
// as `tags.monospace`. This plugin layers per-token colors on top by parsing
// the raw block's content with the corresponding language and emitting
// Decoration.mark spans with `tok-*` classes — the same classes the visual
// editor's CodeBlockWidget uses, so the CSS is shared.
//
// Language loads are async; we cache loaded languages globally and dispatch
// a refresh effect once a new language resolves so the plugin re-decorates.

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { LanguageDescription, LanguageSupport, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";

// Synchronous handle to a loaded language. Languages take a microtask + module
// fetch to load, so the first time we see one we kick off the load and only
// start rendering colors after it resolves.
const loadedLangs = new Map<string, LanguageSupport>();
const inFlight = new Map<string, Promise<void>>();

// Bumped each time a new language finishes loading; the plugin watches this
// effect to know it should rebuild its decoration set.
const refreshHighlight = StateEffect.define<null>();

// StateField acts as a tickle point: dispatching `refreshHighlight` flips the
// field and counts as a state change, which triggers the ViewPlugin's update.
const refreshField = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(refreshHighlight)) return value + 1;
    return value;
  },
});

function ensureLangLoaded(lang: string, view: EditorView): LanguageSupport | null {
  const key = lang.toLowerCase().trim();
  if (!key) return null;
  const cached = loadedLangs.get(key);
  if (cached) return cached;
  if (inFlight.has(key)) return null;

  const desc =
    LanguageDescription.matchLanguageName(languages, key, true) ??
    LanguageDescription.matchFilename(languages, `f.${key}`);
  if (!desc) {
    // Mark as resolved-but-unsupported so we don't keep retrying.
    inFlight.set(key, Promise.resolve());
    return null;
  }

  const promise = desc
    .load()
    .then((support) => {
      loadedLangs.set(key, support);
      // Fire the refresh effect so any plugin instance rebuilds. Wrap in
      // try/catch — the view may have been destroyed before the language
      // resolved (tab closed mid-load).
      try {
        view.dispatch({ effects: refreshHighlight.of(null) });
      } catch {}
    })
    .catch(() => {
      // Swallow load errors so a single broken language doesn't block others.
    });
  inFlight.set(key, promise);
  return null;
}

interface RawSlice {
  lang: string;
  contentFrom: number;
  contentTo: number;
}

// Walk the syntax tree in the visible range and collect `{lang, contentFrom,
// contentTo}` for each block raw (` ```lang\n...\n``` `). Inline raw spans
// (single backticks) are skipped — language-tagged blocks are the only place
// the user expects code highlighting.
function collectRawSlices(view: EditorView): RawSlice[] {
  const out: RawSlice[] = [];
  const doc = view.state.doc;
  for (const range of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== "Raw") return;
        const from = node.from;
        const to = node.to;
        if (to - from < 6) return; // shortest block raw is ``` + ``` + newline
        const text = doc.sliceString(from, to);
        if (!text.startsWith("```")) return;
        const firstNL = text.indexOf("\n");
        if (firstNL < 0) return;
        const lang = text.substring(3, firstNL).trim();
        if (!lang) return;
        const contentStart = from + firstNL + 1;
        const lastDelim = text.lastIndexOf("```");
        const contentEnd = lastDelim > 3 ? from + lastDelim : to;
        if (contentEnd <= contentStart) return;
        out.push({ lang, contentFrom: contentStart, contentTo: contentEnd });
      },
    });
  }
  return out;
}

function buildDecorations(view: EditorView): DecorationSet {
  const slices = collectRawSlices(view);
  if (slices.length === 0) return Decoration.none;

  // highlightTree emits ranges in document order *within* its parsed tree,
  // and slices are in document order, so spans are pre-sorted by start. We
  // still sort defensively — RangeSetBuilder requires sorted input.
  type Span = { from: number; to: number; cls: string };
  const spans: Span[] = [];

  for (const slice of slices) {
    const support = ensureLangLoaded(slice.lang, view);
    if (!support) continue; // first sight: kicked off a load; we'll re-run.

    const code = view.state.doc.sliceString(slice.contentFrom, slice.contentTo);
    const tree = support.language.parser.parse(code);
    highlightTree(tree, classHighlighter, (treeFrom, treeTo, classes) => {
      if (treeFrom === treeTo) return;
      spans.push({
        from: slice.contentFrom + treeFrom,
        to: slice.contentFrom + treeTo,
        cls: classes,
      });
    });
  }

  if (spans.length === 0) return Decoration.none;
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const s of spans) {
    builder.add(s.from, s.to, Decoration.mark({ class: s.cls }));
  }
  return builder.finish();
}

const sourceRawHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      const refreshed = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshHighlight)),
      );
      if (
        refreshed ||
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// Color rules for the `tok-*` classes emitted by classHighlighter. Lives
// here (not in visual-plugin's theme) so it loads in both source and visual
// mode — the visual plugin's theme is gated behind the visual compartment
// and disappears in source mode, where these rules are still needed.
//
// Class set is the actual emitted set from @lezer/highlight (see
// node_modules/@lezer/highlight). Colors map to the editor's `--syntax-*`
// theme vars so light/dark switches apply automatically.
const tokTheme = EditorView.theme({
  ".tok-keyword": { color: "var(--syntax-keyword, #c678dd)" },
  ".tok-atom": { color: "var(--syntax-keyword, #c678dd)" },
  ".tok-bool": { color: "var(--syntax-keyword, #c678dd)" },
  ".tok-string": { color: "var(--syntax-string, #98c379)" },
  ".tok-string2": { color: "var(--syntax-string, #98c379)" },
  ".tok-literal": { color: "var(--syntax-number, #d19a66)" },
  ".tok-number": { color: "var(--syntax-number, #d19a66)" },
  ".tok-comment": {
    color: "var(--syntax-comment, #7d8590)",
    fontStyle: "italic",
  },
  ".tok-typeName": { color: "var(--syntax-type, #e5c07b)" },
  ".tok-className": { color: "var(--syntax-type, #e5c07b)" },
  ".tok-namespace": { color: "var(--syntax-type, #e5c07b)" },
  ".tok-labelName": { color: "var(--syntax-type, #e5c07b)" },
  ".tok-macroName": { color: "var(--syntax-keyword, #c678dd)" },
  ".tok-propertyName": { color: "var(--syntax-property, #61afef)" },
  ".tok-variableName": { color: "var(--fg-primary)" },
  ".tok-variableName2": { color: "var(--syntax-keyword, #c678dd)" },
  ".tok-definition": { fontWeight: "500" },
  ".tok-meta": { color: "var(--syntax-comment, #7d8590)" },
  ".tok-operator": { color: "var(--fg-secondary, var(--fg-primary))" },
  ".tok-punctuation": { color: "var(--fg-dim)" },
  ".tok-invalid": {
    color: "#e06c75",
    textDecoration: "underline",
  },
  ".tok-inserted": { color: "var(--syntax-string, #98c379)" },
  ".tok-deleted": { color: "#e06c75" },
  ".tok-heading": {
    color: "var(--syntax-keyword, #61afef)",
    fontWeight: "bold",
  },
  ".tok-link": {
    color: "var(--syntax-keyword, #61afef)",
    textDecoration: "underline",
  },
  ".tok-url": { color: "var(--syntax-string, #98c379)" },
  ".tok-emphasis": { fontStyle: "italic" },
  ".tok-strong": { fontWeight: "bold" },
});

/**
 * Returns the extension(s) needed to syntax-highlight code inside Typst raw
 * blocks (` ```lang ... ``` `) in source mode. Safe to include in visual
 * mode too — the visual plugin replaces raw blocks with widgets before this
 * plugin's marks would render, but the bundled theme still applies to those
 * widgets so the same colors are used in both modes.
 */
export function sourceRawHighlight() {
  return [refreshField, sourceRawHighlightPlugin, tokTheme];
}
