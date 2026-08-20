// Typst as a highlightable fence language — ```` ```typ ```` / ```` ```typst ````.
//
// Both raw-block highlighters (code-highlight.ts for the visual editor's
// CodeBlockWidget, source-raw-highlight.ts for source mode) resolve languages
// through `@codemirror/language-data`. That registry ships 143 language
// descriptions and none of them is Typst, so a Typst code block in a note —
// an entirely ordinary thing to write in this app — rendered as flat grey text
// while the Rust block beside it lit up.
//
// Per CLAUDE.md's Typst-first principle the answer is `typst-syntax`'s own
// parser, which we already bundle and already run for the source editor, not a
// hand-maintained Prism/regex grammar that would drift as Typst evolves. The
// tags it emits flow through @lezer/highlight's `classHighlighter` into the
// same `tok-*` classes both surfaces already style, so Typst fences pick up
// colours in source *and* visual mode with no new CSS.
//
// The catch, and the reason this needs a module rather than a one-line lookup
// entry: `TypstParser` is document-bound. Its `createParse` lazily builds a
// `TypstWasmParser` from the first input it sees and reuses it thereafter,
// while the main editor keeps its own instance in sync through
// `typstUpdateListenerForcingFreshParseOnHistory` (see typst-editor.ts).
// Handing that instance a code snippet would corrupt the note's parse. So
// snippets get their own instance, reset before every parse.

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

/** True when a fenced block's language tag names Typst. Callers should consult
 *  this *before* their `@codemirror/language-data` lookup — that registry has
 *  no Typst entry, so the lookup would fall through to plain text. */
export function isTypstFenceLang(name: string): boolean {
  return TYPST_FENCE_ALIASES.has(name.toLowerCase().trim());
}

type ParseRange = { from: number; to: number };

/**
 * A `TypstParser` wrapper safe for parsing standalone snippets.
 *
 * Two things it adds over the bare parser:
 *
 * 1. **Reset per parse.** The underlying WASM parser is built from the first
 *    input it sees and cached (along with `last_tree`), so without a
 *    `clearParser()` the second snippet would be highlighted against the
 *    first one's tree.
 * 2. **Guaranteed termination.** `Parser.parse` loops until `advance()`
 *    returns non-null. `TypstParseContext.advance()` returns
 *    `parser.tree()`, which is nullable — so a snippet the WASM parser
 *    declines to produce a tree for (an empty block, say) would spin
 *    forever and hang the editor. Falling back to an empty tree turns that
 *    into "no highlighting", which is the correct degradation.
 */
class TypstSnippetParser extends Parser {
  // The package's type declarations mark the constructor `@internal` and omit
  // its NodePropSource parameter, which it does accept at runtime — the same
  // cast `typstLanguage()` uses in typst-editor.ts. Passing `typstHighlight`
  // is what makes the tree carry highlight tags at all.
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
 * Language support for Typst code *snippets* — fenced blocks inside a note,
 * never the note itself. The note's own Typst is parsed by the editor's
 * document-bound parser (`typstLanguage()` in typst-editor.ts); this is a
 * separate instance precisely so the two can't interfere.
 *
 * Built lazily and memoized: the parser's constructor queries the WASM module
 * for node types, so there's no reason to pay for it in notes that contain no
 * Typst code blocks.
 */
export function typstSnippetSupport(): LanguageSupport {
  if (!cached) {
    cached = new LanguageSupport(
      new Language(defineLanguageFacet({}), new TypstSnippetParser(), [], "typst"),
    );
  }
  return cached;
}
