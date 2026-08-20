import { describe, it, expect } from "vitest";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { isTypstFenceLang, typstSnippetSupport } from "./typst-snippet-lang";

// Typst code blocks (```typ / ```typst) inside a note, highlighted with
// Typst's own parser rather than a hand-written grammar. See
// typst-snippet-lang.ts for why snippets need a parser instance separate from
// the one the editor runs against the note itself.

/** Highlight `code` and return `[text, class]` pairs, the same spans the two
 *  raw-block highlighters turn into decorations / DOM. */
function spansOf(code: string): [string, string][] {
  const tree = typstSnippetSupport().language.parser.parse(code);
  const out: [string, string][] = [];
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    out.push([code.slice(from, to), classes]);
  });
  return out;
}

const classFor = (spans: [string, string][], text: string) =>
  spans.find(([t]) => t === text)?.[1];

describe("isTypstFenceLang", () => {
  it("matches both spellings, case- and whitespace-insensitively", () => {
    expect(isTypstFenceLang("typ")).toBe(true);
    expect(isTypstFenceLang("typst")).toBe(true);
    expect(isTypstFenceLang("TYPST")).toBe(true);
    expect(isTypstFenceLang("  Typ ")).toBe(true);
  });

  it("does not claim other languages", () => {
    // `typescript` is the near-miss that matters: it starts with "typ" and is
    // a language `@codemirror/language-data` really does provide.
    for (const other of ["typescript", "ts", "rust", "python", "", "ty"]) {
      expect(isTypstFenceLang(other), other).toBe(false);
    }
  });
});

describe("Typst snippet highlighting", () => {
  it("tokenizes code mode — keywords, identifiers, numbers, lengths", () => {
    const spans = spansOf("#let x = 4\n#set text(size: 12pt)");
    expect(classFor(spans, "let")).toContain("tok-keyword");
    expect(classFor(spans, "set")).toContain("tok-keyword");
    expect(classFor(spans, "x")).toContain("tok-variableName");
    expect(classFor(spans, "4")).toContain("tok-number");
    // A Typst length literal is one token, not a number followed by a unit.
    expect(classFor(spans, "12pt")).toContain("tok-number");
  });

  it("tokenizes markup mode — headings and emphasis", () => {
    const spans = spansOf("= Heading\n\n*bold* text");
    expect(classFor(spans, "= Heading")).toContain("tok-heading");
    expect(classFor(spans, "*bold*")).toContain("tok-strong");
  });

  it("emits only `tok-*` classes, which both highlighters already style", () => {
    // The shared CSS lives in source-raw-highlight.ts; a span carrying some
    // other class prefix would render unstyled.
    for (const [, cls] of spansOf("#let x = 4\n= Heading")) {
      for (const one of cls.split(/\s+/).filter(Boolean)) {
        expect(one, cls).toMatch(/^tok-/);
      }
    }
  });

  it("parses consecutive snippets independently", () => {
    // The load-bearing invariant. The underlying parser builds its WASM state
    // from the first input it sees and caches the resulting tree, so without a
    // reset per parse the second block would be highlighted against the
    // first's tree — offsets landing on unrelated text.
    const first = spansOf("#let alpha = 1\n#let beta = 2\n#let gamma = 3");
    expect(first.length).toBeGreaterThan(3);

    const second = spansOf("#let y = 9");
    expect(second.map(([t]) => t)).toEqual(["#", "let", "y", "=", "9"]);
    expect(classFor(second, "y")).toContain("tok-variableName");

    // And back to a longer one, to catch a reset that only works one way.
    expect(spansOf("#let alpha = 1\n#let beta = 2\n#let gamma = 3")).toEqual(first);
  });

  it("returns an empty tree for an empty snippet instead of hanging", () => {
    // `Parser.parse` loops until `advance()` yields non-null, and the Typst
    // parse context's `advance()` is nullable — hence the empty-tree fallback.
    // A regression here locks up the editor rather than failing a render, so
    // it is worth pinning explicitly.
    expect(spansOf("")).toEqual([]);
    expect(spansOf("\n\n")).toEqual([]);
  });

  it("memoizes the language support", () => {
    expect(typstSnippetSupport()).toBe(typstSnippetSupport());
  });
});
