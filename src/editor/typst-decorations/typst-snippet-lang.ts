// Typst as a code block language (```` ```typ ```` / ```` ```typst ````).
//
// Both code highlighters (code-highlight.ts in the visual editor,
// source-raw-highlight.ts in source mode) find languages through
// `@codemirror/language-data`, which has no Typst, so Typst code blocks were plain
// text. Per CLAUDE.md's Typst-first principle this uses `typst-syntax`'s own
// parser (already bundled for the editor) rather than a separate grammar; its tags
// map through `classHighlighter` to the `tok-*` classes both modes already style.
//
// It needs its own module because `TypstParser` is tied to one document: it builds
// its WASM parser from the first input and reuses it, and the main editor keeps
// its instance in step (see `typstUpdateListenerForcingFreshParseOnHistory` in
// typst-editor.ts). Giving it a snippet would corrupt the note's parse, so
// snippets get their own instance, reset before each parse.

import { Language, LanguageSupport, defineLanguageFacet } from "@codemirror/language";
import {
  Parser,
  Tree,
  type Input,
  type PartialParse,
  type TreeFragment,
} from "@lezer/common";
import { TypstParser, typstHighlight } from "codemirror-lang-typst";

/** Fence languages that mean "this is Typst". Matches how Typst's own docs
 *  and the wider ecosystem tag code blocks. */
const TYPST_FENCE_ALIASES = new Set(["typ", "typst"]);

/**
 * True when a code block's language names Typst. Check this before the
 * `@codemirror/language-data` lookup, which has no Typst entry.
 */
export function isTypstFenceLang(name: string): boolean {
  return TYPST_FENCE_ALIASES.has(name.toLowerCase().trim());
}

type ParseRange = { from: number; to: number };

/**
 * A `TypstParser` wrapper for standalone snippets:
 *
 * 1. **Reset per parse.** The WASM parser is built from its first input and
 *    caches its tree, so without `clearParser()` the next snippet would be
 *    highlighted against the previous one.
 * 2. **Always terminates.** `Parser.parse` loops until `advance()` returns a
 *    tree, and `TypstParseContext.advance()` can return null (e.g. for an empty
 *    block), which would hang the editor. An empty tree means no highlighting
 *    instead.
 */
class TypstSnippetParser extends Parser {
  // The type declarations mark the constructor internal and omit its
  // NodePropSource parameter, which it accepts at runtime (as in
  // `typstLanguage()` in typst-editor.ts). `typstHighlight` is what gives the
  // tree highlight tags.
  private readonly inner = new (TypstParser as unknown as new (
    h: typeof typstHighlight,
  ) => TypstParser)(typstHighlight);

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly ParseRange[],
  ): PartialParse {
    this.inner.clearParser();
    const inner = this.inner.createParse(input, fragments, ranges);
    return {
      get parsedPos() {
        return inner.parsedPos;
      },
      get stoppedAt() {
        return inner.stoppedAt;
      },
      stopAt(pos: number) {
        inner.stopAt(pos);
      },
      advance() {
        return inner.advance() ?? Tree.empty;
      },
    };
  }
}

let cached: LanguageSupport | null = null;

/**
 * Language support for Typst code blocks inside a note, never the note itself,
 * which uses the editor's own parser (`typstLanguage()` in typst-editor.ts); a
 * separate instance so they can't interfere. Built on first use, since the
 * constructor queries the WASM module.
 */
export function typstSnippetSupport(): LanguageSupport {
  if (!cached) {
    cached = new LanguageSupport(
      new Language(defineLanguageFacet({}), new TypstSnippetParser(), [], "typst"),
    );
  }
  return cached;
}
