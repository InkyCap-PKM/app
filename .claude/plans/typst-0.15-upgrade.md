# Typst 0.14.2 → 0.15.0 upgrade

Status: ALL 4 PHASES IMPLEMENTED + COMMITTED on `typst-0.15` · 2026-06-15 ·
gates green · NOT yet in-app validated, NOT merged to `main`.
Commits: `cd75d83` (P1 finish) · `4ed838f` (P2) · `a1725d1` (P3) · `8fec573`
(P4), atop merge `72709d5`. Pin now `typst* = 0.15` (typst 0.15.0).
Next: in-app validation → merge to `main` → release as the combined 0.15 version.

## Why this upgrade

Typst 0.15.0 lands several things we previously scoped *out* of InkyCap
because the old compiler couldn't do them:

- **Multiple bibliographies per document** (`target` / `group` params) —
  we explicitly blocked this in book export.
- **PDF/A + PDF/UA in one file** — archival *and* accessibility together;
  we left a TODO for exactly this.
- **HTML export improvements** — auto-MathML, variable fonts, fixed
  paragraph grouping, fixed quote attribution, box/block aligned with
  paged output.
- **Variable font support.**

## Key finding: the code change is small

The changelog's biggest breaking item — the **complete rewrite of
`typst-kit`** — does **not** affect us. We hand-roll our own `World`
(`world.rs`), font loading (`Font::iter` + `typst_assets::fonts()` in
`fonts.rs`), and package resolution (`package_fetch.rs`). We have **no
dependency on `typst-kit`**. The actual Rust breakage is ~4 sites plus a
toolchain bump.

The real risk is **output fidelity**, not compilation. 0.15 changes how
documents render and serialize (minification, MathML, math/list baseline
tweaks, variable-font name normalization). Those ripple through every
note in every notebox, so the upgrade needs real rendering validation.

---

## Phase 1 — Compiler bump + green gates

Bump the five crates in `src-tauri/Cargo.toml` (lines 92–97) from `0.14`
to `0.15`: `typst`, `typst-library`, `typst-svg`, `typst-pdf`,
`typst-html`, `typst-assets`. Update the pin-rationale comment at
`Cargo.toml:88-91`.

### Breaking fixes — ACTUAL (DONE 2026-06-15)

The docs.rs API diff under-counted the breakage: 0.15 also split out a
`typst-layout` crate and substantially refactored `typst-syntax`
(paths, diagnostic spans, introspection). Real surface was ~12 sites
across 7 files, all now migrated. Full list for the runbook:

1. **Layout crate split** — `PagedDocument` moved from `typst::layout`
   to a new `typst-layout` crate. Added `typst-layout = "0.15"` dep;
   imports now `typst_layout::PagedDocument` (compiler.rs, query.rs).
   `PagedDocument.pages`/`.introspector` are now private behind
   `pages()` / `introspector()` accessors.
2. **`compile` bound** — `compile<T>` now bounds `T: typst::foundations::
   Output` (was `Document`). recovery.rs `recover<D>` bound updated.
3. **Introspection refactor** — `Introspector` is now a *trait*
   (`&dyn Introspector`); concrete is `PagedIntrospector`. `position()`
   returns `Option<DocumentPosition>` (was a bare `Position`), and
   `DocumentPosition` abstracts paged/HTML → `.as_paged_or_default()`
   yields the `page`/`point` we sort on. (query.rs)
4. **Path/FileId rework** — `FileId::new(Option<PackageSpec>, VirtualPath)`
   → `FileId::new(RootedPath::new(VirtualRoot::Project|Package(spec),
   vpath))`. `VirtualPath::new` now *validates* (forward-slashes only)
   and returns `Result`. `FileId::package()` → match `id.root()`;
   `VirtualPath::as_rootless_path()` deprecated → `get_without_slash()`.
   (world.rs, source_lint.rs)
5. **Diagnostic spans** — `SourceDiagnostic.span` is now `DiagSpan` (not
   `Span`); `.hints` are `Spanned<EcoString, DiagSpan>` (take `.v`).
   Range resolution goes through `DiagSpanKind` (Detached / Number{num,
   sub_range} via `Source::range(num, sub_range)` / raw Range). Added a
   shared `diagnostic::diag_span_range()` helper reused by recovery.rs +
   source_lint.rs. `From<Span> for DiagSpan` lifts trace-point spans.
6. **Syntax node API** — `SyntaxNode/LinkedNode::text()` → `leaf_text()`
   (plaintext.rs, search/text_projection.rs). `SyntaxNode::errors()` →
   `errors_and_warnings().0` (source_lint.rs).
7. **`World::today`** — param `Option<i64>` → `Option<typst::foundations::
   Duration>`; convert via `d.seconds()` → `chrono::Duration` (world.rs).
8. **Export option structs** — `typst_html::html(doc, &HtmlOptions)` and
   `typst_svg::svg(page, &SvgOptions)` each gained an options arg
   (compiler.rs). `PdfOptions { .. }` unaffected (we spread defaults).
9. **MSRV** — needs ≥1.92; `rust-toolchain.toml` already pins 1.94.1, so
   no-op.

Gate status 2026-06-15: clippy --all-targets clean, `cargo test` 708
passed, tsc 0, vitest 196, i18n 100%. (vite build blocked locally by a
root-owned `dist/assets` from a prior container build — env, not code.)

### Confirmed NON-breaking for us (no action)

- `PdfOptions { standards, ..default() }` (`compiler.rs:310,364`) — we
  don't set `ident`, so the `Smart<&str>`→`Smart<String>` change and the
  new `creator`/`pretty` fields cost us nothing.
- `PdfStandards::new` return type changed (`StrResult` →
  `HintedStrResult`) but we `.expect()`, so it still compiles.
- `FontInfo` gained an `axes` field — we clone `info()`, never build it.
- Removed `PathElem` / `pattern` / `pdf.embed` — unreferenced.
- `Selector` gained a `Within` variant — we only construct
  `Selector::Label` and don't exhaustively match `Selector`, so no break
  (verify during build).
- `typst query` CLI deprecation — irrelevant; we use the in-process
  `Introspector` (`query.rs`).

### Required by our own process

- Re-run the pin benchmark the `Cargo.toml:90` comment mandates
  (`spike-bench` / `bench-napi.mjs`) against 0.15 and record results.

### Build the fidelity snapshot corpus (double duty: 0.15 validation +
streamlines all future bumps)

The expensive part of any Typst bump is confirming rendered output didn't
silently shift across documents. Make that a test, not an eyeball pass.

- Add a checked-in corpus of representative `.typ` notes under
  `src-tauri/tests/fixtures/fidelity/`: math, lists, tables, callouts,
  verse, wikilinks, single + multiple bibliographies, citations, a
  `#note(...)` properties doc.
- Snapshot via **`insta`** (the diff engine `similar` we already depend
  on backs it — cheap to adopt):
  - **HTML** and **SVG** output → snapshot the serialized text.
  - **`typst query` / metadata extraction** → snapshot the structured
    result.
  - **PDF** → snapshot page count + extracted text projection
    (`plaintext.rs`) + the tag/standard structure, NOT raw bytes
    (non-deterministic).
- This corpus *is* the Phase 1 validation step: build it against 0.14
  first if practical (or accept 0.15 as the new baseline and review the
  diffs deliberately), then every future upgrade is `cargo insta test` +
  reviewing the diff.

### Confine the Typst API surface to one module

A bump should only ever touch `typst_pipeline/`. Today there are leaks:
`markdown/mod.rs`, `search/text_projection.rs`, and `models/recurrence.rs`
import `typst::syntax` directly. As part of this phase, route their
syntax/AST needs through helpers re-exported from `typst_pipeline/` so
that **all `use typst*` imports live under `typst_pipeline/`**. Keep the
volatile bits (compile invocation, PDF/HTML/SVG option structs, the
`World` impl) in the few files that already hold them.

### Coding practice to lock in

Always construct Typst option structs with `..Default::default()`
(`PdfOptions`, `HtmlOptions`, `SvgOptions`). This is *why* 0.15's new
`creator`/`pretty` fields didn't break us — additive fields stay free.

### Gate: cargo build, clippy (0 warnings), full `cargo test` (incl. the
new snapshot corpus), `tsc`, vitest, vite build, `i18n:check`.

---

## Phase 2 — PDF/A + PDF/UA combined standards

0.15 lifts the *single-substandard* restriction (one PDF/A + one PDF/UA
at once), but **NOT** version compatibility. Follow the TODO at
`compiler.rs:60-68`.

- ⚠ CORRECTION (2026-06-15, impl): the original decision — **PDF/A-4 +
  PDF/UA-1** — is **impossible**. typst-pdf 0.15 rejects it: "PDF/A-4 and
  PDF/UA-1 are mutually incompatible because they do not have any
  overlapping PDF versions" (A-4 requires PDF 2.0; UA-1 requires PDF
  1.4–1.7). Empirically, UA-1 pairs only with A-1 / A-2 / A-3 (all PDF
  ≤1.7). UA-2 (PDF 2.0, the natural A-4 partner) is "future" in typst-pdf
  0.15 — not yet exposed.
- IMPLEMENTED: combined variant `PdfA2aUa1` → `&[A_2a, Ua_1]`. PDF/A-2a is
  the PDF-1.7 archival level whose **Level-A** conformance mandates the
  same full document tagging UA-1 needs — the coherent archival+accessible
  pairing. (A-2b/A-3b are "basic", visual-only; Level A is the accessible
  one. A-3a would also work and additionally permits file attachments;
  A-2a chosen as the cleaner baseline for a notes tool.) Standalone `PdfA4`
  and `PdfUa1` unchanged. Compiles cleanly (unit test
  `combined_pdf_a2a_ua1_standard_compiles`).
- Wired through: `ipc.ts` type (`"pdf-a2a-ua1"`), `ExportDialog.tsx` +
  `CollectionTable.tsx` select options, i18n keys
  `collection.table.pdfStandard.pdfa2aua1` + `export.pdfDesc.pdfa2aua1`
  (en + fr-CA). `includes_ua1()` / `label()` helpers centralize the UA-1
  branching (alt-text/heading checks, heading normalization, doc date).
- OPEN for user: keep A-2a, or switch to A-3a? One-line change.

---

## Phase 3 — Multiple bibliographies in book export

Today's constraint: `pdf.rs:562-579` *rejects* a book export when >1
note declares a `#bibliography`, citing Typst's one-per-document limit.
0.15 removes that limit via `target` (scope a bibliography to a subset
of citations) and `group` (share vs. reset numbering).

DECIDED (2026-06-15): do **both** 3a (lift the cap) and 3b (automate
per-chapter / consolidated). Categorized lists (#2, "Primary"/"Secondary
Sources") are **the author's job** via the now-uncapped InPlace mode — we
do not try to model or manage that.

### 3a — Always: lift the cap (unambiguously correct)

- Remove the `notes_declaring_bibliography().len() > 1` guard at
  `pdf.rs:562-579`.
- In `book_wrapper.rs` InPlace path (`:735-736`), assign each surviving
  `#bibliography` a distinct `target` so they coexist. Thread `target`
  through the `#apply-bibliography` wrapper in `inkycap-notebox/lib.typ`
  (`:129`) — Typst-first, no Rust string-building of bibliography markup.
- Update the InPlace hint text in `CollectionSettings.tsx:762-764`
  (drop "at most a single note may declare one").

### 3b — New: automated per-chapter bibliographies

Add a `PerChapter` variant to `BibliographyMode`
(`collection_parser/model.rs:245-264`): each chapter ends with a
`#bibliography(target: <chapter>)` scoped to that chapter's citations.
`book_wrapper.rs` emits one scoped call per chapter; `group` decides
shared vs. per-chapter numbering. New UI control + hint in
`CollectionSettings.tsx`, TS mirror in `types.ts:256-258`, i18n keys.

The three book bibliography modes then are: **Unified** (one consolidated
list at the back — existing default), **PerChapter** (auto, scoped list
per chapter — new), **InPlace** (author hand-places `#bibliography`
calls, now uncapped — covers categorized/custom layouts).

### Deferred

Categorized lists as an automated feature — left to the author via
InPlace per the 2026-06-15 decision; we don't model reference categories.

---

## Phase 4 — HTML / SVG polish + variable fonts

- **Retire shims if upstream now covers them.** 0.15 fixed quote
  attribution and aligned box/block with paged output. Test whether the
  `html-align` shim (`style_injection.rs`, `commands/export/html.rs`,
  `commands/export/site.rs`) and the quote-attribution workaround are
  still needed; remove what's now redundant. **Validate, don't assume.**
- **MathML** — auto-exported now; confirm equations render in
  HTML/site output and remove any equation workarounds.
- **`pretty` flags** — HTML/SVG/PDF are minified by default in 0.15.
  Decide per surface: minified for shipped artifacts; `pretty: true`
  where a human reads the output (e.g. site export source-view, if any).
- **SVG CSS classes removed** — 0.15 stops emitting `typst-frame` /
  `typst-text` / etc. on SVG. Verify the in-app preview (the
  `render_frames` SVGs displayed in the webview) doesn't style against
  those classes; fix preview CSS if it does.
- **Variable fonts** — family names now strip "Variable"/"VF"/"Var"
  suffixes. Audit string-matching in `fonts.rs` and the font picker so
  static + variable faces unify correctly.

---

## Validation checklist (run before merge to main)

Round-trip and render against representative docs covering: headings &
lists (baseline/marker changes), math (layout refinements, `lr` /
glyph-stretch base-relative change), tables, single + multiple
bibliographies, citations, PDF export (plain / PDF-A / PDF-UA /
combined), HTML + site export (MathML, alignment, quotes), in-app SVG
preview, font picker (variable fonts). Confirm `#note(...)` property
round-trip and `typst query` label stability are unaffected.

---

## Release & branch strategy

1. **Branch `typst-0.15` off `main`** whenever the arc starts; it holds
   all four phases.
2. **The stable fixes already on `main` (`e04720c` etc.) release on their
   own timeline** — branching does NOT force a release. Cut that stable
   patch release today, in a few days, or even after the branch is under
   way; order is purely mechanical (if released after branching, just
   `git merge main` → `typst-0.15` afterward). DECIDED (2026-06-15): user
   may hold the current fixes and release them whenever convenient.
3. **`main` stays the stable line.** Further small fixes commit to `main`
   and release normally; periodically `git merge main` → `typst-0.15` to
   prevent drift (one-author merges are cheap).
4. **When the arc is validated, merge `typst-0.15` → `main` and release**
   as the combined 0.15 version. Per user (2026-06-15): ship all four
   phases together — <10 users, little feedback expected, so no separate
   public beta; validate locally on the branch instead.

## Decisions (2026-06-15) — all resolved

- **Phase 2:** expose PDF/A-4 + PDF/UA-1 combined (keep standalone A-4 and
  UA-1).
- **Phase 3:** do 3a (lift cap) *and* 3b (automated per-chapter mode);
  categorized lists are the author's job via InPlace, not modelled.
- **Release:** all four phases in one release, no public beta; current
  `main` fixes release separately on the user's own timeline.

---

## Streamlining future Typst upgrades

Investments here (most land in Phase 1) so the *next* bump is routine.
The two real costs of a bump are (1) finding which call sites broke and
(2) confirming rendered output didn't silently shift. Target both.

1. **Fidelity snapshot corpus** (Phase 1) — kills cost (2). On any future
   bump: `cargo insta test`, review the diff. See Phase 1 for the build.
2. **API surface confined to `typst_pipeline/`** (Phase 1) — kills cost
   (1). A bump's blast radius is one directory; the leaks
   (`markdown/mod.rs`, `search/text_projection.rs`,
   `models/recurrence.rs`) get routed through that module.
3. **`..Default::default()` discipline** (Phase 1) — additive option
   fields never break us.
4. **Upgrade runbook** — write `documentation/developer/typst-upgrade.md`:
   bump the pins → diff docs.rs for *our* dependency symbols (keep the
   symbol inventory from this arc in the doc) → run the snapshot corpus →
   run the pin benchmark → walk the validation checklist → check MSRV /
   `rust-toolchain`. This plan file is the first instance of that runbook.
5. **Track MSRV + changelog** — Typst bumps MSRV regularly (1.89→1.92
   here). Skim each changelog from the embedder angle; keep
   `rust-toolchain` current.

### Deliberately NOT doing: adopt `typst-kit`

The reworked `typst-kit` exists to "make `World` easier," but this bump
proved our hand-rolled `World` is the *more* stable choice: it needed a
one-line `today` change while `typst-kit` itself was rewritten wholesale.
We keep owning the core (`World`, fonts, packages) and just isolate it
well. Revisit only if we later need on-demand system-font discovery or
sandboxed package fetching that typst-kit does materially better.
