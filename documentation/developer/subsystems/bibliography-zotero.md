# Bibliography and Zotero

> **Audience:** developers working on InkyCap's citation and bibliography paths.
> **Status:** living reference. Update it when the bibliography sources, the
> citation detection, or the Zotero access change.

InkyCap treats bibliography as a **first-class, Typst-native** concern. Citations
are Typst's own `@key` and `#cite(...)`, the reference list is rendered by
Typst's bibliography engine (Hayagriva with CSL styles), and InkyCap's job is to
discover the source, wire it into the document, surface references in the UI, and
bridge to Zotero. It never hand-formats a citation that Typst can format itself;
the only custom rendering is serializing an already-formatted reference list to
Typst markup for the "copy bibliography" convenience.

A reference library can come from a **file** in the notebox or from **Zotero**.
Both converge on the same in-memory entry shape and the same rendering path.

---

## 1. The bibliography pipeline (`typst_pipeline/bibliography.rs`)

**Discovery.** `detect_default()` finds the notebox bibliography by convention,
preferring `references.bib` (BibTeX), then `references.yml` (Hayagriva YAML),
then `references.json` (CSL JSON), unless the notebox setting overrides the path.

**Injection, not mutation.** `augment()` appends an `#apply-bibliography("/path",
style: "...")` call to the *compiled* source when the note does not already
declare one (checked permissively by `already_declares_bibliography()`). The
on-disk note is never modified; the bibliography is added in the compile
pipeline. This is why a note can cite freely and still render a reference list
without the author manually adding `#bibliography(...)`.

**Formats.** BibTeX is parsed via the `biblatex` crate and converted to
Hayagriva; Hayagriva YAML is read natively; CSL JSON has a custom reader for the
display rows. For full CSL *rendering*, `load_library()` builds a
`hayagriva::Library` (`.bib`/`.yml` only; CSL JSON is rejected with a clear error
because Hayagriva has no native reader for it).

**Citation detection.** `extract_citations()` finds both `@key` and
`#cite(<key>)` in source, deduplicated, deliberately skipping escaped `\@`,
inline code spans, fenced code, and string literals (so a `@` in a code sample
is not a citation). It is regex-based on purpose: it runs on a hot path over
mid-edit source that may not parse. `escape_invalid_citations()` rewrites
unresolved references to literal `\@key` so a stray `@` (e.g. the `@domain` in
an email) does not spew compile errors. It walks the `typst::syntax` AST rather
than a regex so it only acts on genuine `Ref` nodes, and it treats a `@target`
as valid when the target is either a bibliography key **or** a `<label>` defined
anywhere in the document. This is what keeps a cross-reference to a heading,
figure, or equation (`@intro` → `= Heading <intro>`) from being escaped when a
bibliography is loaded — in Typst `@` is the universal reference operator, not a
citation-only sugar, and citations are just one kind of reference target. The
empty-`valid_keys` guard (no bibliography, or a failed load) leaves the source
untouched so a transient load failure never rewrites real citations.

**Rendering for "copy bibliography".** `render_cited_bibliography()` runs
Hayagriva's CSL formatter for the cited keys and converts the formatted tree to
Typst markup (italics, bold, super/subscript, smallcaps, links), so the user can
paste a frozen, styled reference list.

**Style resolution.** Precedence is: a per-notebox **custom CSL file**, then a
named **style**, then the `chicago-author-date` default.

Parsing is cached on `(path, mtime, size)`, so repeated reads are cheap and
invalidate when the file changes.

---

## 2. Zotero integration (`typst_pipeline/zotero.rs`)

InkyCap reads the Zotero SQLite database **directly and read-only**:

- `open_zotero_readonly()` opens `zotero.sqlite` with `SQLITE_OPEN_READ_ONLY` and
  the `immutable=1` URI flag, which skips locking so InkyCap can read while Zotero
  is running. The tradeoff is possibly-stale data if Zotero has uncommitted WAL
  writes, which is acceptable for bibliography.
- `auto_detect_path()` knows the per-platform default locations (including the
  Linux Zotero snap path).
- `read_entries()` (cached on mtime+size) queries real items (excluding deleted,
  attachments, notes, annotations), pulling title, date/year, creators, and the
  citation key. The key prefers a **Better BibTeX** `citationKey`, then an
  "extra" field, then Zotero's internal item key. `read_notes()` fetches an
  item's child notes as HTML.

When the notebox's citation source is Zotero, entries are **materialized to
`.inkycap/zotero-export.bib`** (deterministic, alphabetically-ordered fields to
avoid spurious diffs) so the Typst compile path always reads a real bibliography
file. The References panel's refresh button re-runs this export.

---

## 3. Tauri commands (`commands/bibliography.rs`)

| Command | Returns | Purpose |
|---|---|---|
| `get_bibliography_entries` | `Vec<BibEntry>` | the full library (file or Zotero), for the References panel and autocomplete |
| `get_file_citations` | `Vec<FileCitation>` | the `@key` citations in one note, enriched with metadata |
| `aggregate_citations` | `Vec<AggregatedCitation>` | citations across several notes with occurrence counts (used by the Scroll Context panel) |
| `copy_file_bibliography` | `String` | a note's cited references rendered as static Typst markup, for the clipboard |
| `get_reference_notes` | `Vec<RefNote>` | a reference's attached notes (Zotero HTML or BibTeX LaTeX), stripped to text |
| `refresh_bibliography` | `Option<String>` | re-export Zotero to `.inkycap/zotero-export.bib` |
| `detect_zotero_path` | `Option<String>` | auto-detect the Zotero database |
| `get_bibliography_skip_count` | `u32` | entries dropped on the last parse (type errors), for an honest "loaded N of M" |

`BibEntry` carries `key`, `title`, `authors`, `year`, `entry_type`, a
`has_notes` flag (precomputed), and a `zotero_item_key` (so the UI can deep-link
to `zotero://select/...`).

---

## 4. The editor and the References sidebar

- **Autocomplete** (`editor/typst-decorations/citation-suggest.ts`): typing `@`
  opens a popup fuzzy-matching key, title, and authors, with a preview panel and
  keyboard navigation. Bibliography keys are cached (short TTL) so the popup is
  responsive, and a post-accept suppression stops a double insert.
- **References panel** (`components/ReferencesPanel.tsx`): two sections, "Browse
  all references" (search, sort, paginate, refresh, skip-count warning) and
  "Citations in current file" (with a "copy bibliography" action). Each row
  (`CitationRow.tsx`) deep-links to Zotero when the source is Zotero.
- **Citation picker** (`components/CitationPicker.tsx`): a modal search that
  inserts `@key`; it can filter to entries that have notes (used by the
  import-note-text feature).
- **Unresolved-citation diagnostic** (`editor/lsp/cm6-lsp.ts`): when the language
  server flags a label that does not exist but *is* a known bibliography key, the
  message gains a hint that it will resolve in preview. This is the fix for the
  old "citations look broken in source mode" confusion: source-mode compile lacks
  the auto-injected bibliography, but preview/export add it, so the citation is
  fine.

---

## 5. Settings

- **Global** (`settings.rs`, `CitationSettings`): the default `citation_style`
  and the `zotero_database_path`.
- **Per-notebox** (`notebox_settings.rs`, `NoteboxCitationSettings`): the
  `source` (`"file"` or `"zotero"`), the `bibliography_path`, and a
  `custom_csl_path` override.

The per-notebox custom CSL wins over the global style, which wins over the
`chicago-author-date` default. The UI is `CitationsSettingsSection.tsx` (source
toggle, path/auto-detect, style or custom-CSL picker).

---

## 6. Bibliography in collection and book export

When a [collection](collections.md) exports a merged book, the `bibliography_mode`
decides placement: **Unified** strips every per-note `#bibliography(...)` /
`#apply-bibliography(...)` and emits one consolidated list at the back, while
**InPlace** leaves a single note's bibliography where the author put it (Typst
allows at most one per document, so a guard rejects more). The collection can
override the style and bibliography file for the whole book. See the
[export doc](import-export-backup.md) for the surrounding pipeline.

---

## 7. Key files

| Concern | Path |
|---|---|
| Bibliography pipeline | `src-tauri/src/typst_pipeline/bibliography.rs` |
| Zotero SQLite access | `src-tauri/src/typst_pipeline/zotero.rs` |
| Commands | `src-tauri/src/commands/bibliography.rs` |
| Source/style resolution | `src-tauri/src/state.rs`, `src-tauri/src/notebox_settings.rs`, `src-tauri/src/settings.rs` |
| Autocomplete | `src/editor/typst-decorations/citation-suggest.ts` |
| Diagnostic hint | `src/editor/lsp/cm6-lsp.ts` |
| Sidebar + picker | `src/components/ReferencesPanel.tsx`, `CitationRow.tsx`, `CitationPicker.tsx` |
| Settings UI | `src/components/settings/CitationsSettingsSection.tsx` |
