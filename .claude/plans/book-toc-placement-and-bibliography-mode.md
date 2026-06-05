# Merged-book ToC placement + two-mode bibliography

Status: in progress (2026-06-05). Scope agreed with user across design discussion.

## Problem

The Collections "merge into one PDF book" export hardcodes the table of
contents into the front matter and always consolidates a single
bibliography at the back, with no user control over either. French (and
other) book traditions place the ToC elsewhere, and edited volumes want
author-controlled bibliographies.

## Native-Typst findings (why this is orchestration, not a Typst gap)

- `set text(lang:, region:)` localizes terms/typography (outline title,
  supplements, quotes, hyphenation, dates) but has **no** notion of
  document *structure*. ToC/bibliography placement is purely where the
  call sits in source — an InkyCap-level decision. Typst-first tiers:
  this is tier-3 Rust glue ordering native `#outline` / `#bibliography`.
- **Typst 0.14 allows at most one `#bibliography()` per document.** A
  second is a hard compile error. This is why the existing builder strips
  per-note bibliographies unconditionally. It bounds the "in place" mode.

## Shipping scope

### ToC placement (`TocPlacement`)
- `Beginning` (default) | `End` | `AfterChapter { stem }`.
- Anchored by **note stem** (the book's chapter identity everywhere else).
  If the anchored stem isn't in the resolved export set → fall back to
  `Beginning` (silent; documented limitation — membership can change
  between config save and export).
- `#outline()` is whole-document, so placement changes only *where* the
  ToC sits, never its contents. Forward references work from any position.
- Page numbering: only a `Beginning`-placed ToC counts as front matter.
  Any other placement makes the ToC ordinary body content — identical to
  today's already-supported `include_outline = false` front-matter shape.
- `End` = after the last chapter, **before** the consolidated bibliography
  (documented; keeps the bibliography as the genuine last section).

### Bibliography mode (`BibliographyMode`)
- `Unified` (default) — strip per-note `#bibliography()`, emit one
  consolidated `#apply-bibliography(...)` at the back (today's behaviour).
- `InPlace` — leave per-note `#bibliography()` untouched, emit no
  consolidated bibliography, ignore the collection bib path.
- No bibliography *placement* control: in `Unified` it goes at the back;
  in `InPlace` the author positions it by writing the call where they
  want. (The single-bib limit means `InPlace` is itself the placement.)
- **Guard:** in `InPlace`, if >1 resolved note declares a `#bibliography(`,
  fail before compile with a clear message (Typst would otherwise emit a
  cryptic multi-bibliography error). Mirrors the existing label-collision
  pre-flight guard.
- Drops the old "render-but-hide" (`include_bibliography = false`) state
  for the merged book — meaningless in a finished book. `include_bibliography`
  is removed from the book config (no users yet → no migration shim).

### Out of scope (recorded as the future path)
- Per-chapter independent bibliographies via the `@preview/alexandria`
  package (prefix-scoped citations). Would land as a third
  `BibliographyMode::PerChapter`. Not built now per user decision.

## Touch points
- `src-tauri/src/collection_parser/model.rs` — enums + `BookExportConfig`.
- `src-tauri/src/typst_pipeline/book_wrapper.rs` — `BookExportOptions`,
  `build_book_source` (conditional strip, outline placement, conditional
  consolidated bib), `notes_declaring_bibliography` helper, tests.
- `src-tauri/src/commands/export/pdf.rs` — overrides, in-place guard,
  drop `apply_bibliography_visibility` from the book path.
- `src/lib/types.ts`, `src/lib/ipc.ts` — config + overrides shapes.
- `src/components/CollectionSettings.tsx` — unified-bib checkbox + ToC
  placement dropdown (chapters fetched via `getCollectionData(path, "")`).
- `src/locales/en.json` + `src/locales/fr-CA.json` — keys (parity).
