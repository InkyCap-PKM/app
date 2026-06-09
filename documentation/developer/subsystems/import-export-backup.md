# Import, export, and backup

> **Audience:** developers working on InkyCap's data-portability paths.
> **Status:** living reference. Update it when the import dialects, export
> matrix, or backup format change.

These three subsystems share one principle: a notebox is **open data**. You can
bring notes in from Markdown, take them out to many formats, and keep encrypted
archives, all without lock-in. Everything funnels through the notebox's own
conventions (Typst source, the `inkycap-notebox` package, notebox-root-absolute
paths) so what comes out is as portable as what stays in.

---

## 1. Import (`src-tauri/src/markdown/`)

InkyCap imports **Markdown to Typst**. The converter is Rust (not a Typst
package) because it must *emit* InkyCap-specific calls (`#wikilink`, `#tag`,
`#highlight`, `#note`, review markup), which a generic Markdown-to-PDF reader
cannot do.

### 1.1 Dialects

`MarkdownDialect` selects the source flavour:

- **Standard (CommonMark):** `#` is literal outside headings, no `$...$` math,
  no `%%` comments. A bare `$3000` stays text.
- **Obsidian:** enables `#tag` syntax, `$...$` math, `%%comment%%`, callout
  blockquotes, and `![[embed]]` / `[[wikilink]]` forms.

The dialect is auto-detected (an `.obsidian/` folder implies Obsidian) and can be
overridden.

### 1.2 Transformations

The converter maps Markdown constructs to InkyCap package calls, for example:

| Input | Output |
|---|---|
| `![[name.png\|alt]]` | `#image("/<attachment_folder>/name.png", alt: "alt")` |
| `[[target\|display]]` | `#wikilink("target", display: "display")` |
| `#word` (Obsidian) | `#tag("word")` |
| `==text==` | `#highlight[text]` |
| CriticMarkup `{++...++}` / `{--...--}` / `{~~a~>b~~}` | `#suggestion(...)` |
| `{>>comment<<}` | `#annotation[comment]` |

Math has its own mode: if the target notebox has the `mitex` package installed
(detected by scanning `.inkycap/packages/preview/mitex/`), LaTeX is emitted as
`#mi(...)` / `#mitex(...)`; otherwise it is **preserved** verbatim as raw or
fenced `latex` blocks (no data loss), and the count of equations kept as code is
reported back to the user.

### 1.3 Attachments and paths

Every referenced image is **funnelled** into
`settings.files.attachment_folder` and emitted as a notebox-root-absolute path
(`#image("/<folder>/<file>")`), matching how drag-drop and paste behave. This is
the portability rule from `CLAUDE.md`: InkyCap-emitted paths always start with
`/` so they survive note moves and merged-collection export. External/absolute
URLs pass through untouched; a referenced file that is missing is reported as an
error, not silently rewritten.

### 1.4 Frontmatter and the mapping dialog

YAML frontmatter is parsed with `serde_yaml` (in
[`frontmatter.rs`](../../../src-tauri/src/markdown/frontmatter.rs)), so typed
scalars, booleans, dates, and block-style lists all parse correctly. Before a
full notebox import, `scan_markdown_frontmatter()` aggregates every distinct key
across the source with a sample value, occurrence count, inferred property type,
and a suggested target. The frontend `PropertyMappingDialog` lets the user
confirm or change each mapping (map to a system property, an existing property,
create a new one, or skip). Confirmed mappings drive
`frontmatter_to_note_mapped()`, which emits the `#note(...)` call. Unmapped keys
are dropped.

### 1.5 Entry points

`import_from_directory` / `import_from_zip` / `import_from_tarball` (in
`notebox_import.rs`) share one pipeline: detect dialect, scaffold `.inkycap/`,
pre-scan for embeds, then convert each `.md` to `.typ` (rebasing paths), copy
referenced attachments into the attachment folder, and report an `ImportResult`.
The Tauri commands are `scan_markdown_frontmatter`, `import_markdown_notebox`,
`detect_markdown_dialect`, `convert_markdown_to_typst`, and
`paste_markdown_as_typst` (clipboard).

---

## 2. Export (`src-tauri/src/commands/export/`)

Export always starts from the **real Typst document** and goes outward. Where a
target format cannot represent something natively, InkyCap compiles to Typst's
own output first rather than letting a lossy reader guess.

### 2.1 The format matrix

| Format | Path | Notes |
|---|---|---|
| **PDF** | `typst-pdf` | Plain, plus **PDF/A-4** (archival) and **PDF/UA-1** (accessibility) presets. Required metadata (e.g. document date) is injected and validated before compile. |
| **HTML** | `typst-html` | Native Typst HTML. An **html-align shim** re-emits `align()` as styled `<div>`s (typst-html drops alignment), and assets are localized next to the output so the file is self-contained. Optional wikilink stripping. |
| **Typst** | direct | Self-contained `.typ`; can inline the package source for portability. |
| **Markdown** | `typst_to_md` | Reverses the import transforms. |
| **DOCX / ODT / LaTeX / PDF-via-engine** | **Pandoc, via real Typst HTML** | InkyCap compiles the note to Typst HTML, then hands *that* to Pandoc, rather than relying on Pandoc's partial Typst reader. Math/LaTeX fidelity is the accepted tradeoff for resolving the package, `#include`, and layout correctly. |

Review markup (`#suggestion` / `#annotation`) is resolved per an
accept / reject / keep choice on every export path, via the shared helpers; the
Pandoc path additionally flattens surviving review marks to native constructs so
Pandoc's reader does not choke.

### 2.2 Collections and merged "book" export

A collection can export as one merged document. `export_collection_book_pdf`
assembles a title page, optional abstract, a table of contents, one chapter per
note, and a bibliography. The options surface includes:

- `toc_placement` (Beginning / End / AfterChapter)
- `bibliography_mode` (**Unified** one list at the end, or **InPlace** per note)
- chapter-heading injection, wikilink handling (keep / follow / omit), page
  numbering, and the PDF standard.

Each note is inlined through `path_rebase::rebase_relative_paths` (the single
AST-based rewriter, see `CLAUDE.md`) so any hand-authored relative image path
resolves against the synthetic merged root rather than the note's own folder.
TOC rendering uses an `inkycap-notebox` helper (`#outline-with-bare-page-numbers`)
so the package stays the Typst-native home for that logic.

### 2.3 Frontend

`ExportDialog` exposes format, metadata mode, PDF standard, review-markup mode,
and bibliography inclusion (showing only the controls relevant to the chosen
format). File dialogs route their default location through
[`src/lib/dialog-defaults.ts`](../../../src/lib/dialog-defaults.ts) so exports
remember the last-used folder instead of opening in the build directory.

---

## 3. Backup (`src-tauri/src/backup/`)

The backup module produces a **ZIP archive**, optionally **AES-256 encrypted**.
ZIP+AES was chosen over tar.gz/7z because it is universally readable and the
encryption is standard and cross-platform; this is data-at-rest protection, not
transport security.

### 3.1 What is archived

The whole notebox under a `notebox/` prefix, plus the user config under
`user-config/`. Excluded: `.git` and `.inkycap/git/` (large and recoverable by
re-fetch) and OS cruft (`.DS_Store`, `Thumbs.db`, `desktop.ini`). The rest of
`.inkycap/` (templates, scaffolds, settings) **is** included.

### 3.2 Scheduling, retention, restore

- `runner.rs` orchestrates one run: an only-on-change guard (skip a scheduled
  run if the notebox is unchanged since the last success), filename templating
  (`{notebox}`, date/time tokens), archive write, retention prune, and a state
  update. A run lock serializes concurrent invocations; cancellation is
  cooperative.
- `schedule.rs` runs interval and on-launch checks.
- `state.rs` persists the "last backup" record (timestamp, size, last error) in
  the OS config dir, per notebox, separate from `settings.json` to avoid churn.
- `password.rs` stores the archive password in the OS keychain (`keyring`).
- `restore.rs` lists archives and their contents, then selectively extracts with
  a conflict policy (skip / overwrite / rename). Encrypted archives prompt for
  the password (from the keychain or a per-restore override).

### 3.3 Frontend

`BackupSettingsSection` (under Settings) configures destination, schedule,
only-on-change, filename pattern, password, and a "run now" action, with a
last-backup status line driven by a `backup:state-changed` event.
`BackupBrowser` lists archives, filters contents, and restores selected entries
to the notebox or an alternate folder.

---

## 4. Key files

| Concern | Path |
|---|---|
| Markdown to Typst | `src-tauri/src/markdown/md_to_typst.rs` |
| Frontmatter parsing | `src-tauri/src/markdown/frontmatter.rs` |
| Archive/zip/tar import | `src-tauri/src/markdown/notebox_import.rs` |
| Import commands | `src-tauri/src/commands/markdown.rs` |
| PDF / book export | `src-tauri/src/commands/export/pdf.rs` |
| HTML export | `src-tauri/src/commands/export/html.rs` |
| Pandoc export | `src-tauri/src/commands/export/pandoc.rs` |
| Export helpers (review, bib, metadata) | `src-tauri/src/commands/export/helpers.rs` |
| Path rebasing | `src-tauri/src/typst_pipeline/path_rebase.rs` |
| Backup module | `src-tauri/src/backup/` |
| Backup commands | `src-tauri/src/commands/backup.rs` |
| Frontend | `src/components/ExportDialog.tsx`, `PropertyMappingDialog.tsx`, `BackupBrowser.tsx`, `src/components/settings/BackupSettingsSection.tsx` |
