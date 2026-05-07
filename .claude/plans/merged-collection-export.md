# Merged collection export ("Export as book")

Export a collection as a single merged PDF — title page, TOC, sequential
chapters drawn from the collection's notes, single bibliography. Driven from a
new "Export as book" action distinct from the existing per-note batch export.

## Goals

- Use Typst-native primitives (`#include`, `#outline`, `#counter(page)`,
  `#bibliography`) wherever possible. Avoid custom string-stitching of body
  content.
- Keep notes unmodified on disk. The merge is performed on a transient wrapper
  document that is never persisted.
- Surface settings that book authors expect (TOC depth, chapter numbering,
  page-numbering scheme, front-matter handling) without overwhelming users
  who just want a sensible default.
- Honour collection-level styling and template selection that already work for
  per-note compilation.

## Non-goals

- No bidirectional cross-vault book composition (a book is one collection).
- No custom typesetting beyond what Typst templates and the `inkycap-vault`
  package already provide.
- No PDF post-processing (e.g. pdftk-style stitching). Single Typst compile.

## User-facing surface

### "Export as book" action

A new menu entry / button in the collection view, parallel to the existing
batch-PDF export. Opens a dialog that:

1. Reads the collection's `book:` block (if present) for default values.
2. Lets the user override per-export without persisting unless they tick
   "Save settings to collection".
3. Picks an output `.pdf` path (default filename: `book.title || collection
   filename`, sanitised).

### Dialog fields

- **Title / Subtitle / Author / Date / Abstract** (free text)
- **Include title page** (bool, default true; ignored when a Typst template
  is set — templates own the title page)
- **Include outline** (bool, default true)
- **TOC depth** (1–6, default 2)
- **Number chapters** (bool, default true → `#set heading(numbering: "1.1")`)
- **Chapter heading source**: `always inject from title` |
  `inject only when missing` (default) | `never inject`
- **Wikilink mode**: `internal` (default) | `external` | `plain text`
- **Page numbering style**: `arabic` | `arabic from chapters` |
  `roman then arabic` (default) | `arabic from page N`
- **Save settings to collection** (bool, default false)

## `.collection` schema additions

```yaml
book:
  title: string?
  subtitle: string?
  author: string?
  date: string?               # ISO 8601
  abstract: string?           # multi-line
  toc_depth: int?             # 1..6, default 2
  number_chapters: bool?      # default true
  inject_chapter_heading: "always" | "fallback" | "never"   # default "fallback"
  wikilink_mode: "internal" | "external" | "plain"          # default "internal"
  include_title_page: bool?   # default true
  include_outline: bool?      # default true
  page_numbering:
    style: "arabic" | "arabic_from_chapters" | "roman_then_arabic" | "arabic_from_page"
    start_page: int?          # consulted only when style == "arabic_from_page"
```

All fields optional; the export dialog supplies defaults at use time.
Implemented as a `BookExportConfig` struct in
`src-tauri/src/collection_parser/model.rs`, attached as
`CollectionFile.book: Option<BookExportConfig>`.

## Note ordering

**Source of truth: the collection view's current sort/manual order** (the
`ViewDef.sort` / `ViewDef.order` already consumed by
`get_collection_data_internal`). No new per-note property. The view passed to
the export command is what determines chapter sequence.

## Wrapper document (generated, never written to disk)

Built as a string by a new module `typst_pipeline::book_wrapper`. Layout:

```typst
#import "/.inkycap/packages/inkycap-vault/0.1.0/lib.typ": *

// Book metadata
#let book-meta = (
  title: ..., subtitle: ..., author: ..., date: ..., abstract: ...,
)

// Merged-context state read by the vault package
#let inkycap-merged-context = (
  active: true,
  mode: "internal" | "external" | "plain",
  chapters: ("note-stem-a", "note-stem-b", ...),
)

// Existing collection-level style/defaults injection (unchanged path)
#set page(...)
#set text(...)
#set heading(numbering: "1.1")   // if number_chapters

// Optional template
#show: template.with(title: book-meta.title, author: book-meta.author)

// --- Front matter ----------------------------------------------------------
// Page numbering for front matter (depends on style)
// e.g. "roman_then_arabic": #set page(numbering: "i")
//      "arabic_from_chapters": #set page(numbering: none)

// Title page (only when no template AND include_title_page)
#align(center + horizon)[ ... ]
#pagebreak()

// Abstract (if set)
#heading(level: 1, numbering: none, outlined: false)[Abstract]
#book-meta.abstract
#pagebreak()

// Outline
#outline(depth: <toc_depth>)
#pagebreak()

// --- Chapters --------------------------------------------------------------
// Switch to body page numbering (e.g. roman_then_arabic resets to arabic 1)
#set page(numbering: "1")
#counter(page).update(1)

// One <chap-foo> label per chapter for internal wikilinks; injected heading
// only when needed per inject_chapter_heading mode.
<chap-note-a>
#include "/abs/path/to/note-a.typ"
#pagebreak(weak: true)

= Chapter Title (injected from title property)  <chap-note-b>
#include "/abs/path/to/note-b.typ"
#pagebreak(weak: true)

// --- Bibliography ----------------------------------------------------------
#bibliography("/abs/path/to/refs.bib", style: "ieee")
```

### Per-note preprocessing before include

Each included note file is rewritten in memory through a new
`prepare_note_for_include(content: &str) -> String` helper:

1. Strip preamble (`#import` of vault package + leading `#note(...)` call) —
   reuse `strip_note_preamble`.
2. Strip any standalone `#bibliography(...)` call — bibliography is global at
   the wrapper level. New helper `strip_bibliography_call`.
3. (No heading-level shifting in v1; we trust author conventions, optionally
   inject a level-1 heading at the wrapper site.)

The transformed content is written to a temp file under the OS temp dir so
`#include` can read it. Temp dir is cleaned up after compile (success or
failure). Including from a temp path means the original notes are never
mutated.

### Label collision pre-scan

Before generating the wrapper, scan all candidate notes for Typst label
declarations (`<name>`). For collisions, return an `InkyCapError::ExportFailed`
with a message listing each colliding label and the notes that define it.
Implemented as `scan_label_collisions(notes: &[(PathBuf, String)]) ->
Result<(), Vec<LabelCollision>>`.

The injected `<chap-stem>` chapter labels are validated to not collide with
existing labels in any note; if a collision is detected the chapter label is
suffixed (`<chap-stem-2>`) and a warning is logged.

## Vault package update — wikilink merged-context

`inkycap-vault/0.1.0/lib.typ` `wikilink` becomes context-aware. Add a state:

```typst
#let _merged-context = state("inkycap-merged-context", (
  active: false,
  mode: "external",
  chapters: (),
))

#let set-merged-context(active: false, mode: "external", chapters: ()) = {
  _merged-context.update((active: active, mode: mode, chapters: chapters))
}
```

In `wikilink`:

- If `active == false`: current behaviour (link to `name + ".typ"`).
- If `active == true` and `mode == "internal"`:
  - If `name` is in `chapters`, emit `link(label("chap-" + name))[shown]`.
  - Else fall back to plain text (target not in this book).
- If `active == true` and `mode == "external"`: current behaviour.
- If `active == true` and `mode == "plain"`: emit just the display text, no
  `link(...)`.

The wrapper calls `#set-merged-context(...)` near the top.

## Backend implementation

### New module `src-tauri/src/typst_pipeline/book_wrapper.rs`

Exports:

```rust
pub struct BookExportOptions { /* mirrors BookExportConfig + dialog overrides */ }

pub struct PreparedBook {
    pub wrapper_source: String,
    pub wrapper_path: PathBuf,   // temp file location for the wrapper
    pub temp_dir: TempDir,       // RAII cleanup
}

pub fn build_book(
    collection: &CollectionFile,
    notes: Vec<(PathBuf, String)>,    // ordered
    bib: Option<&Path>,
    template: Option<&str>,
    style_rules: &str,
    options: &BookExportOptions,
) -> Result<PreparedBook, InkyCapError>;
```

Internally:
- Calls `scan_label_collisions`.
- Writes each preprocessed note to `temp_dir/notes/<stem>.typ`.
- Generates the wrapper string and writes it to `temp_dir/book.typ`.

### New Tauri command `commands::export::export_collection_book_pdf`

```rust
#[tauri::command]
pub async fn export_collection_book_pdf(
    collection_path: String,
    view_name: String,
    output_path: String,
    options: BookExportOptions,
    state: State<'_, AppState>,
) -> Result<String, InkyCapError>
```

Steps:
1. Load collection + view rows (`get_collection_data_internal`) to determine
   note order.
2. Load each note's content via `VaultStorage`.
3. Build the prepared book via `book_wrapper::build_book`.
4. Compile via `compiler.compile_pdf(wrapper_path, wrapper_source)`. Re-uses
   the existing compile path; the wrapper is just another Typst document the
   compiler hasn't seen before.
5. Write PDF bytes to `output_path`.
6. Return the absolute output path.

### Existing batch export untouched

`export_collection_batch_pdf` keeps producing N PDFs. The book export is a
sibling command, not a modal flag.

## Frontend

### IPC

Add to `src/lib/ipc.ts`:

```ts
export interface BookExportOptions { /* matches Rust */ }

export async function exportCollectionBookPdf(
  collectionPath: string,
  viewName: string,
  outputPath: string,
  options: BookExportOptions,
): Promise<string> { ... }
```

### UI

- New "Export as book…" menu item in the collection export menu (sibling to
  the existing batch-PDF action) in
  `src/components/CollectionTable.tsx`.
- New dialog `src/components/BookExportDialog.tsx`. Loads defaults from the
  parsed `.collection` `book` block (fetched via existing
  `get_collection_data_internal` flow or a new `get_collection_book_config`
  if needed).
- Save-settings checkbox: when set, writes back to the `.collection` file
  using a new `update_collection_book_config` command (or piggybacks on the
  existing collection-update path if present).

## Tests

Unit tests in Rust:

- `prepare_note_for_include` strips imports, `#note(...)`, and
  `#bibliography(...)` correctly without touching surrounding content.
- `scan_label_collisions` detects duplicates and ignores per-chapter
  `<chap-foo>` labels added by the wrapper.
- `build_book` produces a wrapper that:
  - Has the expected number of `#include` lines.
  - Contains exactly one `#bibliography(...)` call when bib is set.
  - Honours each `inject_chapter_heading` mode.
  - Honours each `page_numbering.style` mode (regex on emitted source).

Integration test:

- A fixture vault with two short notes and a bib file compiles end-to-end via
  `export_collection_book_pdf` and produces a non-empty PDF.

## Open questions deferred to v0.2

- Heading-level shifting for notes whose top-level heading is `==` instead of
  `=` (workaround: convention).
- Per-chapter scoped `#show` rules for fine-grained styling.
- Preface vs. abstract vs. dedication as distinct front-matter slots (v1
  collapses to a single abstract field).
- "Save wrapper for inspection" debug toggle.

## Sequencing

1. Schema (Rust struct + serde) + parser test.
2. Vault package `wikilink` merged-context update + Typst test fixture.
3. `prepare_note_for_include` + `strip_bibliography_call` + tests.
4. `scan_label_collisions` + tests.
5. `book_wrapper::build_book` + tests.
6. Tauri command + IPC + integration test.
7. Frontend dialog + menu wiring.
8. Manual smoke test with a 3-note collection: title page, TOC, two chapters
   with wikilinks between them, one bib citation per chapter.
