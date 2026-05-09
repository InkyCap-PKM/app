# Leaning harder on native Typst — audit & implementation log

**Status:** Implemented 2026-05-09. All tier 1 + tier 2 items landed; tier 3
items handled or explicitly deferred with rationale below.



Audit of `src-tauri/src/typst_pipeline/`, `src-tauri/src/markdown/`, the
`inkycap-vault` package, and the merged-book/export commands looking for
places we hand-roll behaviour that Typst can express natively. Each
finding lists the current approach, what Typst already offers, the
trade-offs, and a rough size. Nothing here is implemented — it's a
discussion list.

The `inkycap-vault` package itself (`inkycap-vault/0.1.0/lib.typ`) is
already idiomatic: `state` for toggles, `metadata` + labels for
queryable surfaces, `context` blocks for resolution, `html.elem` for
the HTML target, explicit `text(..args, body)` to override outer
`set text`. The opportunities below mostly live in Rust glue *around*
the package.

---

## Tier 1 — high-value, low risk

### 1. Move app/collection style cascade into the vault package
**Where:** [src-tauri/src/typst_pipeline/style_injection.rs](../../src-tauri/src/typst_pipeline/style_injection.rs) (whole file, ~300 lines)

**Today:** Rust builds `#set text(...)`, `#set page(...)`, `#show raw: set text(font: ...)` rule strings, finds the `#import "/.inkycap/..."` line in source, and splices them in. Collection styles are a second string spliced after defaults so the Typst cascade resolves precedence (`inject_style_rules`, lines 136–169).

**Native equivalent:** Expose a single configurable entry point in the package, e.g.
```typst
#apply-vault-defaults(
  text-font: "Inter",
  text-size: 12pt,
  page-paper: "us-letter",
  monospace-font: ("Adwaita Mono", "Ubuntu Mono"),
)
```
Rust emits one function call after the import; the package owns the actual `set` rules. Collection rules become a second call (`apply-collection-style(...)`) that runs after defaults — Typst's normal cascade does the precedence work we currently do via string ordering. Reference: <https://typst.app/docs/reference/styling/>, <https://typst.app/docs/reference/foundations/arguments/>.

**Why it's worth it:** Today's string-splicing has subtle invariants (recognise both canonical and legacy import paths, fall back to prepend, watch order). Moving the rules into Typst means we lose the splicer, the order-sensitive concatenation, and the tests for both. The parameters become typed at the Typst boundary (length, length, str, array) instead of stringly-typed Rust→Typst formatting.

**Risk:** Bumps the vault package version; older vaults need migration (the package is already vendored per-vault, so this is a one-shot rewrite of `lib.typ` rather than a user-visible upgrade).

**Size:** Medium. ~200 lines of Rust deleted, ~80 lines of Typst added, plus tests.

---

### 2. Move bibliography injection into the vault package
**Where:** [src-tauri/src/typst_pipeline/bibliography.rs](../../src-tauri/src/typst_pipeline/bibliography.rs) lines 47–95 (`augment_source_with_bibliography`).

**Today:** Rust appends `#bibliography("path", style: "apa")` to the source if no `#bibliography(...)` is already present. Detection is a substring match on the source.

**Native equivalent:** Expose `apply-bibliography(path, style: ..., title: none)` from the vault package and have Rust call it once. Detection of an existing user `#bibliography(...)` can stay in Rust (still a substring check on the original source — same line cost), but the rendering decision and styling moves into Typst where it belongs.

Better still, encode the convention: a `bibliography.bib` at the vault root is auto-attached unless the document opts out. Today's "scan source for `#bibliography`" check moves into the package via a state flag.

**Risk:** Low. The injection is already a leaf of the pipeline.

**Size:** Small.

---

### 3. Page-number offset closure → helper in package
**Where:** [src-tauri/src/typst_pipeline/book_wrapper.rs](../../src-tauri/src/typst_pipeline/book_wrapper.rs) lines 596–612.

**Today:** Rust emits a string containing an inline Typst closure for page numbering offset. Already Typst-idiomatic, but the closure source lives in a Rust `format!`.

**Native equivalent:** `inkycap-vault/lib.typ` exposes `make-offset-numbering(start)`; Rust emits `#set page(numbering: make-offset-numbering({start}))`. Closure body is in `.typ` where it can be edited and tested.

**Risk:** None.

**Size:** Small.

---

## Tier 2 — meaningful refactors, worth doing soon

### 4. Replace hand-written `#note(...)` parser with `typst::syntax`
**Where:** [src-tauri/src/typst_pipeline/note_rewriter.rs](../../src-tauri/src/typst_pipeline/note_rewriter.rs) (519 lines).

**Today:** Hand-rolled balanced-paren scanning, named-argument extraction, value parsing, and rewriter reconstruction. ~300 lines of delimiter logic plus value-side parsing.

**Native equivalent:** The `typst::syntax` crate (already a dep — used in [world.rs](../../src-tauri/src/typst_pipeline/world.rs) and [diagnostic.rs](../../src-tauri/src/typst_pipeline/diagnostic.rs)) gives us a real parser. Parse the source to a `SyntaxNode`, locate the `FuncCall` whose callee is `note`, manipulate its `Args` typed children, re-emit via `node.into_text()`. The byte-range preservation we need (whitespace, comment fidelity for fields we're not touching) falls out of the typed AST instead of being defended via string-level invariants.

**Why this is non-obvious:** "Use `typst query` instead" was tempting (and the audit suggested it), but `typst query` only gives us *evaluated* metadata — fine for the read path, useless for the write path because we can't round-trip arbitrary Typst expressions through `serde_json` and back. The CLAUDE.md principle "property editor must preserve untouched fields and whitespace byte-for-byte" forces a source-level rewriter; the question is just whether it's hand-written or AST-driven. Typst's own crate is the right answer.

**Risk:** `typst::syntax` is not a stable public API in the strict semver sense — it tracks the Typst crate version. We already pin the Typst version, so this is a known cost on each Typst bump (probably no worse than what `world.rs` already pays).

**Size:** Medium-large. Real rewrite; needs a parallel test pass to lock down round-trip identity on an existing fixture set before swapping.

---

### 5. Heading-level normalization for PDF/UA via a show rule
**Where:** [src-tauri/src/typst_pipeline/book_wrapper.rs](../../src-tauri/src/typst_pipeline/book_wrapper.rs) lines 336–415.

**Today:** Rust collects all heading levels in each chapter, computes a mapping that compresses gaps and shifts the minimum to a target level, and rewrites `=`, `==`, `===` markers in the source.

**Native equivalent:** A `#show heading: ...` rule that consults `counter(heading)` / `here()` and re-emits the heading at the corrected level via `heading(level: ...)`. Combined with a per-chapter `set heading(offset: ...)`, the level math happens in Typst instead of in a source-rewriting pass over the chapter text. Reference: <https://typst.app/docs/reference/model/heading/>, `set heading(offset: ...)` in particular.

**Why it matters:** Source rewriting of heading markers is one of the few things in the pipeline that *modifies the user's text* before compile. It's a place where bugs are user-visible (a missed case shows up as a wrong heading level in the PDF). Pushing the logic into a show rule means Typst guarantees consistency.

**Risk:** Need to verify PDF/UA-1 tagged-output preserves the Typst heading level (not the original markup level). Worth a small spike with a UA validator before committing.

**Size:** Medium.

---

### 6. Drop the custom `outline.entry` show rule if Typst 0.13+ handles it
**Where:** [src-tauri/src/typst_pipeline/book_wrapper.rs](../../src-tauri/src/typst_pipeline/book_wrapper.rs) lines 554–582.

**Today:** Custom `show outline.entry: it => link(label("chap-..."))[it.body]` to make TOC entries clickable in merged books.

**Native equivalent:** Modern Typst `outline()` produces clickable entries by default when entries are real headings with labels. Our chapters already get `<chap-stem>` labels. Worth re-running a merged book through the current Typst version with the show rule deleted to see whether the override is still needed at all.

**Risk:** None — if it doesn't work, we keep the override.

**Size:** Trivial (a delete-and-test exercise).

---

## Tier 3 — worth knowing about, lower priority

### 7. Markdown ↔ Typst conversion vs. native markdown
**Where:** [src-tauri/src/markdown/md_to_typst.rs](../../src-tauri/src/markdown/md_to_typst.rs) (915 lines), [typst_to_md.rs](../../src-tauri/src/markdown/typst_to_md.rs) (921 lines).

**Today:** Full bespoke converters built on `pulldown-cmark` + regex pre-processing for wikilinks, Obsidian tags, highlights.

**Native option:** Typst has a community `cmarker` package that compiles CommonMark inside Typst. It's *consume-only* (md → rendered output), not symmetric, so it doesn't replace the typst→md exporter and doesn't help us preserve `#note(...)` semantics on import. It also can't carry InkyCap-specific extensions (wikilinks, tags) into the typst AST without pre-processing — exactly what we're doing now.

**Recommendation:** No change. Document this finding so we don't revisit it. The 1800 lines are doing real work that no Typst feature covers.

---

### 8. Fallback property extraction when compile fails
**Where:** [src-tauri/src/typst_pipeline/query.rs](../../src-tauri/src/typst_pipeline/query.rs) lines 60–146.

**Today:** When `typst::compile` fails, we hand-parse `#note(...)` from raw source so the property panel still has values. ~85 lines of value parsing (`parse_raw_typst_value`).

**Native option:** The property index cache (written by [scanner/walker.rs](../../src-tauri/src/scanner/walker.rs)) already stores the last-known-good properties per file. Use it as the failure fallback and delete the source-level value parser.

**Trade-off:** Stale values in the panel for files that have never compiled successfully. Probably fine — a never-compiled file is broken anyway.

**Size:** Small.

**Note:** Worth folding into Tier-2 #4 if we're touching this area. The value parser duplicates a subset of what a real `typst::syntax` walk would give us for free.

---

### 9. Frontend outline computation
**Where:** [src/editor/typst-decorations/heading-tracker.ts](../../src/editor/typst-decorations/heading-tracker.ts) (47 lines).

Already small and reasonable — it tracks visible headings for the editor sidebar. No reason to push this through `typst query`; the editor needs this synchronously on every keystroke and the round-trip cost would be wrong.

**Recommendation:** No change.

---

## Implementation outcomes (2026-05-09)

| Item | Status | Notes |
|------|--------|-------|
| 1. Style cascade | **done** | `apply-vault-defaults` + `apply-collection-style` in `lib.typ`; Rust now emits one `#show: ...with(...)` per level. Sharp edge: `show: f` calls `f(body)` positionally, so `body` must be a *parameter* on the function, not a `body => …` closure return. Same fix applies to any future show-rule helper. |
| 2. Bibliography injection | **done** | `apply-bibliography(path, ..opts)` in `lib.typ`; Rust emits `#apply-bibliography(...)`. Updated `strip_bibliography_call` to also recognise the wrapper form so merged-book stripping still works. |
| 3. Page-number offset | **done** | `make-offset-numbering(start-page)` in `lib.typ`. |
| 4. Note rewriter on `typst::syntax` | **done** | Hand-rolled scanner replaced with `LinkedNode`-based AST walk. Added Unicode and inline-comment regression tests. |
| 5. Heading normalization | **deferred** with safety net | The Typst-native rewrite (`set heading(offset: 1)` per chapter) only handles the *shift* half of the algorithm — gap compression still needs Rust-side inspection. Modest cleanup, real risk on a load-bearing PDF/UA-1 path. Instead: added `tests/verapdf_pdf_ua.rs` so any future refactor (or unrelated regression) is caught by the real validator. The veraPDF run on the existing implementation passes UA-1 cleanly. |
| 6. Outline override | **done** | `outline-with-bare-page-numbers(depth: N)` in `lib.typ`. The override is still needed (it strips body page-pattern decoration out of TOC entries), so deletion was the wrong call — moving it into the package was the right one. |
| 7. Markdown converters | **no change** (documented) | `cmarker` is consume-only and can't carry InkyCap's wikilink/tag extensions. The 1800 lines do real work. |
| 8. Fallback property extraction | **done** | Removed `fallback_text_extraction` and `parse_raw_typst_value`. Compile failures now return `QueryResult::default()`; the scanner's persisted cache is the supported source for broken files. |
| 9. Frontend outline computation | **no change** (documented) | Synchronous editor concern — round-tripping through `typst query` would be wrong. |

### Bug surfaced by the veraPDF wiring (item 5)

Adding the validator immediately found a real PDF/UA-1 bug: the
merged-book wrapper never emitted a `#set document(title:, author:)`
rule, so the typst-pdf backend rejected UA-1 export with `missing
document title`. Fixed in `book_wrapper::build_book_source` by
emitting `#set document(...)` from `options.title` and `options.author`,
and in `commands::export::ensure_document_date_for_standard` by changing
the short-circuit predicate to look for an actual `date:` argument
inside any existing `#set document(...)` rule rather than just any
`#set document(` substring. After the fix, veraPDF passes UA-1
validation on the test fixture.

## Suggested sequencing

If we agree on these:

1. **Quick wins first** (Tier 1, all small/medium): style cascade → bibliography → page-number helper. These move logic into the vault package and reduce Rust string-splicing surface.
2. **AST refactor** (Tier 2 #4): note rewriter on `typst::syntax`. Big quality win for the property write path.
3. **Heading & outline** (Tier 2 #5, #6) once we're already in `book_wrapper.rs`.
4. **Fallback extraction** (Tier 3 #8) folded in with #4.
5. Tier 3 #7 / #9 are no-ops — documented for future-us.

Bumping the vault package version once at the start of this work and doing #1, #2, #3 together is probably cleaner than three separate package versions.

## Open questions for discussion

- Are we OK bumping the vault package version (currently `0.1.0`) for the cascade move? Existing vaults vendor the package, so this is per-vault opt-in via re-running the package writer.
- Tier 2 #4 (AST refactor) is the biggest effort. Worth doing before v0.1 ships, or after first real users surface a property-rewrite bug?
- Tier 2 #5 (heading normalization via show rule) — do we have a PDF/UA validator in the loop to verify?
