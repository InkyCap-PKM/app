# Plan: script sub-box in the visual editor

Tracks part 3 of [issue #20](https://codeberg.org/InkyCap/app/issues/20)
("Quality of Life", louis2038, 2026-07-07). Parts 1 (reading-mode zoom) and 2
(the `#func(` chip bug) are fixed.

**Status:** the Typst-fence half of this plan (§2 below) **shipped** — see
[typst-snippet-lang.ts](src/editor/typst-decorations/typst-snippet-lang.ts) and
its tests. The sub-box half (§1) is deliberately deferred; what follows is the
design for it, kept for whoever picks it up.

## Context

The reporter asked for "real syntax highlighting for the Typst code", and
proposed that **wrapping scripts in a dedicated sub-box editor** would solve
both that and the visual-mode confusion at once. Their instinct is right about
the coupling: the confusion came from a script region that gave the writer no
signal it *was* a script region. Part 2 fixed the acute symptom (the call no
longer vanishes under the caret); this part gives the revealed region a visible
identity.

Investigation found the request splits into two independent gaps, one smaller
than it looks and one larger:

**Revealed script is already coloured, but not demarcated.** Visual mode keeps
the base `syntaxHighlighting(inkycapHighlight)` from
[`baseExtensions`](src/editor/typst-editor.ts), running over the same WASM Typst
parser as source mode. So when a `#func(...)` drops to raw source under the
caret, the tokens *are* coloured. What's missing is any frame: the source
renders in the body font, inline with prose, at prose size. There is no
"you are now editing code" boundary. The gap is presentation, not parsing.

**Fenced Typst code has no highlighting at all.** Both raw-block highlighters —
[code-highlight.ts](src/editor/typst-decorations/code-highlight.ts) (visual
mode's `CodeBlockWidget`) and
[source-raw-highlight.ts](src/editor/typst-decorations/source-raw-highlight.ts)
(source mode's inline decorations) — resolve languages exclusively through
`@codemirror/language-data`. That package ships 143 language descriptions and
**none of them is Typst**. So a ```` ```typ ```` block inside a note — a note
*about* Typst, which is a very ordinary thing to write in this app — falls back
to plain text, while ```` ```rust ```` and ```` ```python ```` light up. We
bundle a Typst parser already; it simply isn't reachable from that lookup.

## Precedent to follow, not invent

The exact pattern the reporter is asking for already ships for fenced code
blocks, in [visual-plugin.ts](src/editor/typst-decorations/visual-plugin.ts)'s
`Raw` case:

- Cursor away → `Decoration.replace` with a `CodeBlockWidget` (framed box,
  header with language name, copy button, highlighted `<pre>`).
- Cursor inside → the widget drops and every line of the block gets
  `Decoration.line({ class: "cm-typst-codeblock-edit" })`, which switches those
  lines to monospace at 0.9em so the live source still reads as code.

The theme comment on `.cm-typst-codeblock-edit` records the reasoning: no
surrounding frame while editing, "since the visible delimiters (` ``` `)
already mark the block boundaries". Script has no such delimiters, which is
precisely why it needs the frame the code block can do without.

So: **generalize `cm-typst-codeblock-edit` into a script-aware sibling**, don't
build a second system.

## Design

### 1. `.cm-typst-script-edit` — the sub-box

A line decoration applied to the lines of a `#func(...)` / `#set` / `#show`
call while it is showing raw source. Emitted from the same places that already
decide "reveal raw source":

- `handleFuncCall`'s early `return false` paths (caret inside an
  arguments-only call — the part-2 fix; `expandedPos === from`; `autoExpand`).
- The `SetRule` / `ShowRule` case's `if (onCursor) return false`.

Those are currently bare `return false` statements scattered through the
switch. Route them through one small helper —
`revealScriptSource(state, from, to, decos)` — that pushes the line
decorations and returns `false`, so the sub-box can never drift out of sync
with the reveal decision. That refactor is the load-bearing part of this
change; the CSS is the easy half.

Styling reuses the existing tokens (`--syntax-mono-bg`, `--border-subtle`,
`--radius-sm`, `--editor-font-mono`) so it matches `.cm-typst-codeblock`
without a new palette:

```
.cm-typst-script-edit {
  font-family: var(--editor-font-mono, monospace) !important;
  font-size: 0.9em;
  background-color: var(--syntax-mono-bg);
  border-left: 2px solid var(--border-subtle);
  padding-left: 6px;
}
```

Deliberately a left rule plus a tint rather than a full box: a line decoration
can't round the corners of a multi-line run without per-line first/last
classes, and an inline `#func(...)` sitting mid-paragraph would have its
paragraph broken by a full frame. The left rule reads as "this run is code"
at a glance and degrades gracefully for a single-line call.

**Open question for implementation:** whether a call that sits *inline in a
paragraph* (`prose #foo(1) more prose`) should get the line treatment at all,
since the decoration paints the whole line including the surrounding prose. Two
candidates: (a) restrict the line decoration to calls that occupy their own
line and give inline calls a `Decoration.mark` over just the call's range
instead; (b) always use the mark, never the line. (a) is more work but matches
what a reader expects in both positions. Decide with a real note in front of
you, not on paper.

### 2. Typst as a highlightable fence language — SHIPPED

Both highlighters need `typ` / `typst` to resolve to a language. The blocker is
that `TypstParser` is **stateful and document-bound**: `createParse` lazily
builds a `TypstWasmParser` from the first input it sees and then reuses it
(`node_modules/codemirror-lang-typst/dist/index.js`), and the main editor keeps
its instance in sync through `typstUpdateListenerForcingFreshParseOnHistory`.
Handing that instance a code snippet would corrupt the note's parse.

So add a dedicated module — `src/editor/typst-decorations/typst-snippet-lang.ts`
— owning a **separate** `TypstParser` used only for snippets:

- `new TypstParser(typstHighlight)` (the `NodePropSource` is what makes
  `highlightTree` emit tags at all — same construction as `typstLanguage()`).
- `clearParser()` before each snippet parse, since the instance would otherwise
  reuse the previous snippet's WASM parser.
- Export a `LanguageSupport` (or just a `parse(code): Tree`) plus the alias set
  `{"typ", "typst"}`.

Then both call sites short-circuit before their `LanguageDescription` lookup:

- `code-highlight.ts` → `loadLanguage()`
- `source-raw-highlight.ts` → `ensureLangLoaded()`

One module, two three-line call-site changes, no duplicated parser handling.
The emitted classes are `classHighlighter`'s `tok-*`, which are already styled
in [source-raw-highlight.ts:186-210](src/editor/typst-decorations/source-raw-highlight.ts#L186)
and shared by both surfaces — so Typst fences pick up colours for free, in both
modes, with no CSS at all.

Per CLAUDE.md's Typst-first principle this is squarely the right layer: it uses
`typst-syntax`'s own parser rather than hand-rolling a Typst tokenizer, which
is what a Prism/highlight.js grammar would amount to.

**As built**, two details differed from the sketch above:

- The snippet parser also needs a **termination guard**. `Parser.parse` loops
  until `advance()` returns non-null, and `TypstParseContext.advance()` returns
  the nullable `parser.tree()` — so a snippet the parser declines to produce a
  tree for would spin forever and hang the editor. `TypstSnippetParser` falls
  back to `Tree.empty`, degrading to "no highlighting" instead.
- The per-parse `clearParser()` is not a nicety. Without it, every snippet
  after the first is highlighted against the *first* one's tree, with offsets
  landing on unrelated text. Verified by removing it: three tests fail.

The async-contract worry turned out to be a non-issue — resolving synchronously
is the same shape as a cache hit in both call sites.

## Sequencing

1. ~~`typst-snippet-lang.ts` + both call-site hooks.~~ Done.
2. `revealScriptSource` helper — pure refactor, no behaviour change. Land and
   verify the visual editor is unchanged before styling anything. Note that
   `collapseWouldSwallowCaret` (added for issue #20's chip fix) already names
   one half of the reveal decision; the helper should sit alongside it.
3. `.cm-typst-script-edit` styling, then resolve the inline-vs-own-line
   question above against real notes.

## Testing

The Typst WASM parser **does** load under Vitest — contrary to a long-standing
note in list-enter.test.ts, since corrected. So snippet parsing and highlighting
are directly testable; see
[typst-snippet-lang.test.ts](src/editor/typst-decorations/typst-snippet-lang.test.ts).

The sub-box is unit-testable the way
[func-collapse.test.ts](src/editor/typst-decorations/func-collapse.test.ts) is:
`handleFuncCall` is deliberately parser-independent, so a test can assert that
every reveal path emits the sub-box decoration — exactly the invariant that
would rot if a future branch adds another bare `return false`.

## Explicitly out of scope

- Making the sub-box a *nested CodeMirror instance*. The reporter said
  "sub-box editor", but a real nested editor conflicts with the Tier 1
  principle in CLAUDE.md: visual mode is a decoration layer over Typst source,
  and the source stays one document. Styling a range of the outer editor gives
  the same affordance with none of the focus-routing, undo-stack, or
  selection-model problems a nested instance brings (see the CM6 widget recipe
  in CLAUDE.md for how sharp those edges already are with a single
  `contentEditable`).
- Tinymist-driven semantic highlighting of script. The LSP is already wired for
  code-mode autocomplete and could in principle supply semantic tokens, but
  that's a much larger change and the syntactic colouring here is what the
  issue asks for.
