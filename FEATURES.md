# InkyCap — Features & Functions

A Typst-first personal knowledge management editor for writing, academic, and research note-taking. The source is always Typst; the app layers writing-friendly tooling on top of it.

---

## Core PKM features 

- **Reciprocal note linking** — `[[Wikilinks]]` with optional display/heading targets (`[[Name::Heading]]`), hover previews, click-to-navigate, and fuzzy-matched link suggestions.
- **Automatic backlinks** — a Links/Backlinks panel listing incoming and outgoing links with surrounding context, sortable by title, frequency, or direction.
- **Tags** — inline `#tag("name")` tags with click-to-filter; a flat (non-hierarchical) tag browser.
- **Typed properties / metadata** — text, number, boolean, list, date, select, and tag property types, edited in a right-panel Properties tab and stored as arguments to a `#note(...)` call at the top of each note.
- **Full-text search** — notebox-wide search with case-sensitive and regex modes, snippet previews, pagination, and global find-and-replace.
- **Quick Open** — jump to any note by title with fuzzy matching.
- **Find & Replace** — in-note (current file) and notebox-wide, with per-match confirmation.
- **File tree** — folder hierarchy with drag-drop reordering, file-type icons, sort modes, folder grouping, optional extension display, and a full right-click menu (new/move/rename/delete).
- **Bookmarks** — quick-access items for notes, headings, searches, or collections, drag-reorderable and persistent.
- **Outline** — document structure with clickable heading navigation.
- **Templates / scaffolds** — reusable note bodies stored in the notebox and inserted via a picker.
- **Attachments** — drag-drop, paste-image, and command-palette insertion all funnel files into a configurable attachment folder.

---

## Distinctive InkyCap features

- **Three editor modes** — *Source* (full Typst), *Visual / Live Preview* (a CodeMirror decoration layer that makes markup writer-friendly without leaving Typst), and *Reading* (rendered output, SVG or HTML). Mode is remembered per tab.
- **Visual editor pill system** — non-trivial Typst function calls collapse behind a circled `#` pill that expands to raw source on the cursor line and re-collapses when the cursor leaves; interactive elements (wikilinks, tags, links, tasks) render as semantic widgets.
- **Journal Scroll** — an infinite, continuously compiled feed of related notes anchored on the current note, with sort options (created/modified/Zettelkasten ID/custom date) and scope filters (all/daily-notes/custom folder), stabilized scrolling, and per-entry HTML rendering.
- **Mycelial View** — a knowledge-graph visualization centred on the active note that surfaces *latent links* (suggested connections), *emergent concepts* (TF-IDF / PMI term detection), and source notes, with pan/zoom, hover highlighting, and a filtering panel.
- **Dynamic agenda** — task and due-date aggregation (`#task(...)`, `#due(...)`) surfaced through Typst-query labels and filterable within collections.
- **Collections** — dynamic, database-style table views over notes (`.collection` files) with a visual filter builder (recursive All/Any/None groups), multi-column sort, custom property columns, inline cell editing, and multiple saved views per collection.
- **Split panes & tabs** — recursive horizontal/vertical splits, per-pane reading format, tab reordering, cross-pane drag, reopen-closed-tab, and tab history.
- **Multi-window, multi-tab, split windows** — open multiple noteboxes in separate windows, each with its own session. Windows support multiple tabs and split tabs.
- **Tasks & due dates** — inline checkbox tasks with toggle state and calendar-picked due dates, rendered and editable inside callouts and other blocks.
- **Verse mode** — first-class free-form/poetry writing that preserves idiosyncratic whitespace while still evaluating per-line markup, with its own font role.

---

## Academic & research features

- **First-class bibliography** — a dedicated References sidebar tab listing all citations with multiple sort modes and pagination; `@key` citation autocomplete; `#bibliography(...)` rendering.
- **Citation sources** — native Typst BibTeX/Hayagriva (`.bib`/`.yml`/`.json`) plus live **Zotero** integration with auto-detection.
- **Citation styles** — Chicago Author-Date, Harvard, APA, IEEE, and others, plus custom CSL files; per-collection unified-vs-in-place bibliography modes.
- **Collection / book export** — merge a collection of notes into a single styled document with a generated title page, configurable table-of-contents placement (beginning/end/after-chapter), front/back matter, and per-collection style overrides.
- **CRediT contributor roles** — a per-collection contributor table mapped to the NISO Contributor Roles Taxonomy (Conceptualization, Methodology, Software, Writing, etc.), with auto-grouped bylines and an optional contributions statement.
- **PDF standards** — export to plain PDF, **PDF/A-4** (long-term archival), or **PDF/UA-1** (accessibility), driven by Typst's own PDF backend.
- **Review markup / tracked changes** — `#annotation(...)` and `#suggestion(...)` (insert/delete/replace) reviewed in an Annotations panel; export can keep, accept, or reject all markup.
- **Multiple export targets** — PDF, self-contained Typst, Typst-native HTML, Markdown, and Pandoc formats (DOCX, ODT, LaTeX) compiled via real Typst HTML.

---

## Experimental features

- **Notebox-level git collaboration** — whole-notebox git sync with a merge-first workflow: Sync (pull/merge/push), Check Updates (pull/merge only), inline merge-conflict review, a post-sync change digest, and per-note version history with read-only diffs and restore.
- **Offline package handoff** — exchange a notebox (optionally as an encrypted `.git` archive) without a server, including a "bundle Typst packages on share" option that vendors `@preview` dependencies for portability.
- **Structured settings merge** — three-way JSON merge of `settings.json` during sync, with per-key conflict resolution.
- **External tools / extensions** — user-defined shell commands runnable from the Tools menu, with an extension-point architecture (storage trait, event bus, extension enum) laid down for future plugins.
- **Media embeds** — `#video` / `#audio` insertion targeting HTML output with in-editor players (in progress).

---

## Typst-specific compatibilities

- **Typst is the source of truth** — notes are real `.typ` files; everything (links, tags, properties, agenda) flows through `typst query` against stable labels rather than a parallel data model.
- **`inkycap-notebox` package** — bundled into every notebox and auto-imported, providing `note`, `tag`, `wikilink`, `link-ref`, `task`, `due`, `callout`, `verse`, `annotation`, `suggestion`, `contributors-byline`, and `credit-statement` primitives that compile in any plain Typst environment.
- **Tinymist language server** — real-time diagnostics, autocomplete, and go-to-definition in source mode (suppressed in visual mode to reduce noise).
- **Typst package resolution** — `@preview` dependencies resolve from cache with on-demand download and transitive retry; a package manager lists, downloads, and removes packages.
- **Notebox-root-absolute paths** — InkyCap-emitted `image`/`read`/`embed`/`bibliography` paths are project-root-absolute and AST-rebased on note moves and merged export, so they survive reorganization.
- **Native Typst syntax** — `*bold*`, `_italic_`, `= heading`, `- bullet`, `+ ordered`, `$math$` are recognized directly; Markdown shortcuts are intentionally *not* aliased. The only translations are `[[Name]]` → `#wikilink("Name")` and the `/` command palette.
- **`.typ` audit** — scan the notebox for Typst syntax errors.

---

## Quality-of-life niceties

- **Creation rules** — user-defined new-note templates with name, icon, target folder, filename pattern, scaffold/body, per-rule hotkey, and toolbar toggle (e.g. New Note, Daily Note).
- **Command palette** — categorized, fuzzy-searchable access to ~100+ commands plus creation rules, with editable per-command hotkeys.
- **Slash (`/`) command menu** — in-editor markup insertion menu.
- **Selection toolbar** — floating format buttons on text selection.
- **Spellcheck** — Hunspell-backed spell-checking with per-language dictionaries and right-click suggestions.
- **Internationalization** — fully translatable UI (every user-facing string flows through a locale seam); ships with English and French (Québec), and adding a language is a single JSON file.
- **Localized typesetting** — optional auto-injection of `#set text(lang/region)` for non-English notes, hidden as preamble machinery in the visual editor.
- **Writing modes** — typewriter mode, focus mode (line/section dimming), distraction-free mode, and a readable line-length constraint.
- **Editor conveniences** — auto-pair brackets and Typst calls, auto-expand markup, smart list indentation/continuation, configurable Enter behaviour, and symbol shorthands (em/en dash, ellipsis, non-breaking space).
- **Keyboard navigation** — region cycling (F6), focus-editor and panel-toggle shortcuts, in-tree rename (F2), in-note replace (Ctrl+H), and a full documented shortcut scheme.
- **Themes & fonts** — light/dark/system themes, warm/default background palettes, custom accent colour, and per-role fonts (Interface, Editor, Monospace, document Text, Verse), each system/bundled/custom.
- **Zoom** — content, interface, or both, with configurable target.
- **Backups** — scheduled (hourly/daily/weekly/monthly) or on-demand backups with optional encryption, zip/tar.gz formats, and a restore browser.
- **Smart dialog defaults** — file dialogs remember sensible default locations (last directory, notebox root, or backup folder).
- **Help panel** — in-app manual, keyboard reference, and Typst/InkyCap documentation (F1), backed by a bundled documentation notebox.
- **Status bar** — file path, word/character count, cursor position, and dirty/clean state.

---

## Privacy posture

InkyCap is local-first: no telemetry, analytics, remote logging, or gen AI by default. Notebox contents never leave the device unless the user explicitly opts into a sync backend.
