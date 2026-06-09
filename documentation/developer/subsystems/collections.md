# Collections

> **Audience:** developers working on InkyCap's collection layer.
> **Status:** living reference. Update it when the filter model, view model, or
> export paths change.

A **collection** is a database-like layer over a notebox: a saved query, one or
more table or agenda views over the matching notes, optional per-collection
styling, and a publishing target. It turns a folder of Typst notes into
something you can filter, sort, tabulate, and bind into a book, without changing
the notes themselves. Membership is computed, not stored on each note, so a note
can belong to several collections at once and a collection's contents update as
the notebox changes.

Collections lean hard on the rest of the system: membership evaluates against the
`PropertyIndex`, export reuses the [export pipeline](import-export-backup.md),
and styling reuses the [Typst style injection](import-export-backup.md). This
doc describes the collection-specific model and the database-like behaviour.

---

## 1. The `.collection` file

Collections are YAML files under `.inkycap/collections/` (one file per
collection, `<name>.collection`). They are enumerated on notebox scan and held
in the session. The parsed model is `CollectionFile` (in
[`src-tauri/src/collection_parser/model.rs`](../../../src-tauri/src/collection_parser/model.rs)):

| Field | Purpose |
|---|---|
| `icon` | Lucide icon name for the sidebar |
| `filters` | the collection-wide membership filter (a `FilterGroup`) |
| `views` | one or more `ViewDef` (table or agenda) over the members |
| `style` | per-collection style overrides (page, text, paragraph, heading) |
| `typst_template`, `custom_typst` | a template package import, and a raw-Typst escape hatch |
| `bibliography_style`, `bibliography_file` | citation style and source for this collection |
| `book` | the persistent book-export configuration (`BookExportConfig`) |
| `formulas`, `summaries` | reserved for a future computed-column feature |

A freshly created collection gets a sensible default: a filter that excludes the
collection file itself and includes notes tagged for it, plus one table view
sorted by file name.

---

## 2. Membership: a recursive filter, not a stored flag

A note belongs to a collection if it passes the collection's filter (and, for a
given view, that view's filter too). Membership is **filter-only**; there is no
per-note "this is in collection X" override. The default entry path is the
`collection` property:

```typst
#note(collection: ("papers", "to-read"))
```

which the default filter matches with `collection.contains("papers")`. But that
is just the default. A filter can admit notes by folder, tag, any property, or
any boolean combination, so membership is as flexible as the query language
below.

The single resolver `resolve_collection_members()` (in
[`commands/collections.rs`](../../../src-tauri/src/commands/collections.rs))
computes membership for **every** consumer: the table, the agenda, export, and
the `collection:` search scope. Table and agenda can therefore never disagree
about what is in the collection.

---

## 3. The filter query language

The filter is the database-like heart of collections. It is a **recursive
boolean tree**, not a flat list of per-row operators. The structure
(`FilterGroup` plus `FilterExpr` in `collection_parser/`):

- **Groups** combine children: `and` (all must pass), `or` (any), `not` (none).
  When more than one combinator is present in a group they are themselves AND-ed,
  and groups nest, so you can express `(A or B) and C and not (D or E)`.
- **Leaf expressions** are one of:
  - **Comparison**: `==` / `!=` between a property reference and a value (a
    string, number, bool, or another property reference).
  - **Method call**: `.contains(x)` (substring on strings, membership on lists)
    and `.isEmpty()`, each negatable (`!.contains(...)`, `!.isEmpty()`).
- **Property references** come in three kinds:
  - `file.*` derived properties (`file.name`, `file.folder`, `file.ext`,
    `file.ctime`, `file.mtime`, `file.size`, `file.tags`), which are read-only.
  - note properties (`title`, `status`, `tags`, or `note["odd-key"]` for keys
    that are not bare identifiers).
  - `this.file.*`, a self-reference to the collection file (used by the default
    filter to exclude itself).

Filters evaluate against each note's `PropertyIndex` entry. Equality against a
list property is treated as membership (`collection == "X"` matches when `X` is
in the list). The frontend `FilterBuilder` edits this tree with combinators
labelled All / Any / None, to a nesting depth of three.

---

## 4. Views, sorting, columns

A collection has one or more **views** (`ViewDef`), each its own lens over the
same membership set:

- `view_type` is `"table"` or `"agenda"`.
- `filters` optionally narrows further than the collection-wide filter.
- `order` is the visible column list (property keys); `file.*` and user
  properties both work. Friendly labels come from `property-labels.ts` on the
  frontend (for example `file.mtime` renders as "Modified").
- `sort` is an ordered list of `{ property, direction }` rules (primary,
  secondary, and so on; nulls sort last, ties are stable).

The table is rendered by `CollectionTable.tsx`: a view-switcher across the top,
sortable column headers, inline cell editing for note properties (the `file.*`
columns are read-only), and click-to-open (with open-in-new-tab via
modifier/middle click). View edits go through dedicated commands
(`update_view_sort`, `update_view_columns`, `update_collection_filters`,
`add_view`, `remove_view`, `rename_view`, `reorder_views`); each persists back to
the `.collection` file and bumps a property version so the table refetches.

---

## 5. Per-collection style

A collection can restyle every note it renders or exports, without touching the
notes. `CollectionStyle` covers page (paper, margin, columns, numbering), text
(font, size, language/region), paragraph (leading, spacing, first-line indent,
justify), and heading numbering. These inject at compile time through
[`style_injection.rs`](../../../src-tauri/src/typst_pipeline/style_injection.rs)
in a defined order: app defaults, then the collection style, then any
`typst_template` import, then the user's own `#set` rules (which win via Typst's
cascade). Page geometry is emitted as a direct `#set page(...)` because
`set page` inside a show rule is a no-op; text/paragraph/heading delegate to
helper functions in the `inkycap-notebox` package, keeping the styling logic
Typst-native. `custom_typst` is a verbatim escape hatch for power users.

The frontend edits all of this in `CollectionSettings` (Characteristics, Style
Overrides, and Book Metadata tabs), autosaving on change.

---

## 6. Publishing

Collections are also a publishing target. The export paths (all reusing the
shared [export pipeline](import-export-backup.md), with the collection's style
and bibliography applied):

- **Book (merged) export** is the headline feature: `export_collection_book_pdf`
  binds the view's notes into one document via `book_wrapper.rs`. Notes are
  **inlined** (not `#include`d) so wikilinks and rebased paths resolve, then
  wrapped with an optional title page, abstract, and table of contents. The
  configuration (`BookExportConfig`, persisted in the `.collection` file, with
  per-export `BookExportOverrides`) covers:
  - `toc_placement` (Beginning / End / AfterChapter), `toc_depth`,
    `include_outline`, `include_title_page`.
  - `inject_chapter_heading` (Always / Fallback / Never) for using each note's
    title as a chapter heading.
  - `wikilink_mode` (Internal cross-references / External per-note links /
    Plain text).
  - `bibliography_mode`: **Unified** (one consolidated bibliography at the back)
    or **InPlace** (keep per-note `#bibliography(...)`, capped at one across the
    book by a guard).
  - `page_numbering` (Arabic, Arabic-from-chapters, Roman-then-Arabic,
    Arabic-from-page), the PDF standard, and the review-markup mode.
  - a **contributors** roster with bibliographic (CSL) roles and CRediT roles,
    driving both the byline and an optional CRediT statement.
  Book export returns warnings and any label collisions so the user can fix
  cross-reference clashes.
- **Batch export** (`export_collection_batch_pdf`, `export_collection_batch_markdown`)
  writes one file per note.
- **CSV export** (`export_collection_csv` / `..._to_file`) emits the table as
  CSV or TSV, flattening booleans and lists.
- **Static site** (`export_collection_static_site`) compiles each note to HTML
  with internal wikilinks rewritten to relative links and assets copied in.

---

## 7. Reserved and constrained

- `formulas` / `summaries` (computed columns and per-view summaries) are parsed
  but not yet implemented; `column_size` is frontend-only.
- `file.*` properties are read-only (derived from the filesystem).
- Collection files must live in `.inkycap/collections/` (not configurable).
- In `InPlace` bibliography mode, at most one note in a book may declare a
  `#bibliography(...)` (a Typst constraint), enforced by a guard.

---

## 8. Key files

| Concern | Path |
|---|---|
| Parsed model + filter AST + style | `src-tauri/src/collection_parser/` |
| Runtime data types | `src-tauri/src/models/collection.rs` |
| Commands + membership resolver | `src-tauri/src/commands/collections.rs` |
| Book assembly | `src-tauri/src/typst_pipeline/book_wrapper.rs` |
| Style injection | `src-tauri/src/typst_pipeline/style_injection.rs` |
| Export commands | `src-tauri/src/commands/export/` (`pdf.rs`, `csv.rs`, `site.rs`) |
| Table + settings + filter UI | `src/components/CollectionTable.tsx`, `CollectionSettings.tsx`, `FilterBuilder.tsx`, `ContributorsEditor.tsx` |
| Friendly property labels | `src/lib/property-labels.ts` |
