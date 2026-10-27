// Source-mode highlighting of code inside Typst raw blocks. The Typst
// highlighter styles a whole `Raw` node as monospace; this parses its content
// with the block's language and adds `tok-*` mark classes, the same ones the
// visual editor's CodeBlockWidget uses, so the CSS is shared.
//
// Languages load asynchronously; they are cached, and a refresh effect is sent
// when one finishes loading.

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { LanguageDescription, LanguageSupport, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { ERROR_UNDERLINE_STYLE } from "../diagnostic-style";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { isTypstFenceLang, typstSnippetSupport } from "./typst-snippet-lang";

// Loaded languages. The first time a language is seen its load starts, and
// highlighting begins once it finishes.
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
  // Typst isn't in `@codemirror/language-data`, so check it before the lookup
  // below. It is bundled, so it's available at once, like a cache hit (see
  // typst-snippet-lang.ts).
  if (isTypstFenceLang(key)) return typstSnippetSupport();
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
      // Send the refresh effect so the plugin redraws. The view may have closed
      // while the language loaded, hence the try.
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

// Collect `{lang, contentFrom, contentTo}` for each code block (`
// ```lang\n...\n``` `) in the visible range. Inline raw (single backticks)
// isn't highlighted.
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

  // Spans come out in document order, but are sorted anyway since
  // RangeSetBuilder requires it.
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
    if (s.from < s.to) builder.add(s.from, s.to, Decoration.mark({ class: s.cls }));
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

// Colours for the `tok-*` classes from classHighlighter. Here, not in the
// visual plugin's theme (which only loads in visual mode), so they apply in
// both modes.
//
// The classes are those @lezer/highlight emits. Colours use the `--syntax-*`
// variables, so they follow the theme.
const tokTheme = EditorView.theme({
  ".tok-keyword": { color: "var(--syntax-keyword)" },
  ".tok-atom": { color: "var(--syntax-keyword)" },
  ".tok-bool": { color: "var(--syntax-keyword)" },
  ".tok-string": { color: "var(--syntax-string)" },
  ".tok-string2": { color: "var(--syntax-string)" },
  ".tok-literal": { color: "var(--syntax-number)" },
  ".tok-number": { color: "var(--syntax-number)" },
  ".tok-comment": {
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  ".tok-typeName": { color: "var(--syntax-type)" },
  ".tok-className": { color: "var(--syntax-type)" },
  ".tok-namespace": { color: "var(--syntax-type)" },
  ".tok-labelName": { color: "var(--syntax-type)" },
  ".tok-macroName": { color: "var(--syntax-keyword)" },
  ".tok-propertyName": { color: "var(--syntax-variable)" },
  ".tok-variableName": { color: "var(--fg-primary)" },
  ".tok-variableName2": { color: "var(--syntax-keyword)" },
  ".tok-definition": { fontWeight: "500" },
  ".tok-meta": { color: "var(--syntax-comment)" },
  ".tok-operator": { color: "var(--fg-secondary, var(--fg-primary))" },
  ".tok-punctuation": { color: "var(--fg-dim)" },
  ".tok-invalid": {
    color: "var(--accent-danger)",
    textDecoration: `underline ${ERROR_UNDERLINE_STYLE}`,
  },
  ".tok-inserted": { color: "var(--syntax-string)" },
  ".tok-deleted": { color: "var(--accent-danger)" },
  ".tok-heading": {
    color: "var(--syntax-keyword)",
    fontWeight: "bold",
  },
  ".tok-link": {
    color: "var(--syntax-keyword)",
    textDecoration: "underline",
  },
  ".tok-url": { color: "var(--syntax-string)" },
  ".tok-emphasis": { fontStyle: "italic" },
  ".tok-strong": { fontWeight: "bold" },
});

/**
 * Extensions that highlight code in Typst raw blocks (` ```lang ... ``` `) in
 * source mode. Safe in visual mode too: there the blocks are widgets, which use
 * the same theme, so colours match.
 */
export function sourceRawHighlight() {
  return [refreshField, sourceRawHighlightPlugin, tokTheme];
}
