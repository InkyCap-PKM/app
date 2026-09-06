# Changelog

All notable changes to InkyCap are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

InkyCap uses date-based versions, `YY.MM.RELEASE` (see
[documentation/developer/releasing.md](documentation/developer/releasing.md)).
The last `RELEASE` number selects the channel: **even** is a user-facing stable
release, **odd** is a development (beta) release. Add a new heading below for
each tagged release, newest first, grouping entries under **Added**, **Changed**,
**Fixed**, **Removed**, **Security**, or **Deprecated** as needed.


## [26.9.4] - 2026-09-05

### Added

- An `@` reference can point at a specific section inside another note, and
  correcting a broken label reference is simpler.
- The in-app update check reads a static release feed published at
  `inkycap.org/releases/latest.json` instead of querying the code host's API
  directly. The feed carries both channels and the release and download links,
  so a change in where InkyCap is hosted no longer strands installed copies.
  Builds older than 26.9 fall back to the forge API automatically.
- Advanced `settings.updates.feed_url` override (https only, no Settings UI)
  for forks and self-builders.

### Changed

- Bold and italic applied inside a word (Ctrl+B / Ctrl+I and the selection
  toolbar) now emit markup Typst renders consistently. Plain `*` and `_` do not
  always display the same way mid-word.
- Indenting and un-indenting lists behaves more predictably.
- Shell scripts are pinned to LF line endings so they run from a Windows
  checkout.
- README and contributor documentation clarify where to report issues.

### Fixed

- Code blocks, block quotes and callouts keep the same height when the caret
  enters or leaves them, so the page no longer shifts.
- The page no longer creeps upward on each click into a block.
- "Dim unfocused text" works on its own, without Focus mode. Both settings are
  applied when an editor is created and are remembered across a visual/source
  switch.
- The Tinymist language-server download script runs on macOS again, which had
  failed because macOS ships a bash without associative arrays.


## [26.9.2] - 2026-09-02

### Added

- Mycelial View: exclude notes from its calculations by property or tag.
- "Search in folder" on the file tree's folder right-click menu. Search also
  lists matches found through filenames, which previously only contributed to
  relevance scoring.
- Command palette scan for filenames that could cause cross-platform problems,
  with a guided fix.
- Button on Collection rows that opens a file in the visual editor.
- Folding for lists as well as headings. Lists move with their child items, and
  expand/collapse state persists for the session.

### Changed

- UI design system overhaul: `layout.css` split into per-area files, a token
  system for typography, spacing, geometry and motion, token-level
  accessibility work, semantic status colours, and a single icon-button class.
- Sorting throughout the app uses the ICU collator, so numerals, accented
  characters and mixed case order naturally. Replaces the previous custom
  comparison code.
- Tab styling and usability with many tabs open, pinned sidebar and right-panel
  pane headers, and scrollbar refinements.

### Fixed

- Task shortcuts in the visual editor: adding a task with `- [ ]`, the command
  palette or the slash menu now allows the text to be edited directly, or
  through a dialog from the pill's right-click menu.
- Backtick auto-pairing.
- Verse element: the arrow keys enter and exit it, and it no longer trapped the
  cursor.
- Tag filtering in Collections.
- List creation recognition after a space.
- Misspelled words no longer shift position when the spellcheck underline
  appears.


## [26.8.4] - 2026-08-28

### Fixed

— selection toolbar popups near a viewport edge
— tab strip overflow detection and scroll affordances
— @ in an email address misread as a broken reference, breaking PDF export
- Verse lines now wrap at the right margin in the reading view and in exported
  PDFs instead of running off the page. Preserved indentation and run-spacing
  are unchanged.

### Added
— Mycelial View: n-gram phrase detection, hiding under-developed pages, expand/collapse in the growth pane


## [26.8.2] - 2026-08-25

### Added

- Split with preview: a split view pairing a live editor with a synced reading
  pane, so writing and rendered output sit side by side.
- Customizable UI keyboard shortcuts. Shortcuts can be remapped from their
  defaults through the Help display (F1 or the help icon).
- Setting to disable GPU compositing (Settings > Behaviour), for Linux system
  configurations where compositing causes visual glitches.
- Typst syntax highlighting inside the visual editor's code blocks, matching the
  other code-block displays.

### Changed

- Mycelial View: anchor-specific scoring, support for small noteboxes, and new
  gap signals surfacing weak hubs and open questions.
- Journal Scroll now defaults to the most recently modified note as its anchor
  when opened without another note already active.
- Inserting a scaffold when no note is open now automatically starts a new note.
- Visual editor pills gain a trailing space on the right for a cleaner
  appearance, and no longer collapse markup into a pill until the user closes a
  parenthesis rather than assuming it.
- Reworded the calendar task-list options.
- Bumped the Typst compile pipeline 0.15.0 to 0.15.1 and the Tinymist language
  server sidecar 0.14.16 to 0.15.2.

### Fixed

- Heading detection now uses Typst's own parser instead of a line regex, so edge
  cases parse correctly.
- Search: typing in the Replace field no longer steals the caret back to Find on
  macOS/WebKit.
- Zooming now works in the SVG and HTML view modes.
- Bookmarks update when a file is renamed or moved, and the system no longer
  creates duplicate bookmarks.
- Blockquote: wrapping existing text with `>` places the quote correctly, and the
  cursor now lands inside the quotation marks for inline quotes.
- Code blocks no longer advance a line before letting the user specify the
  language.

## [26.6.2] - 2026-06-09

First public release. InkyCap is a local-first personal knowledge management and
writing application built on Typst: notes are plain Typst source that compiles
anywhere, with metadata queryable by the `typst` command-line tool. Available in
English and Français.

### Added

- Reciprocal note-linking with wikilinks and automatic backlinks at the centre
  of the navigation model.
- Portable, typed metadata via the bundled `inkycap-notebox` Typst package
  (`#note(...)` properties queryable by any Typst tool).
- Three editor modes: source (full Typst), visual (write-what-you-mean over live
  Typst markup), and reading (the rendered document).
- First-class bibliography: native Typst BibTeX/Hayagriva citations, a dedicated
  References sidebar, and Zotero integration.
- The Mycelial View: a graph surfacing emergent concepts and latent links from
  corpus statistics.
- Optional whole-notebox git collaboration with a merge-first sync model.
- Import from Markdown / Obsidian-flavoured vaults; export to PDF (incl. PDF/A
  and PDF/UA), HTML, Markdown, and ODT/DOCX/LaTeX via Pandoc.
- In-app update checker (Windows installs in place; Linux is notified and links
  to the releases page), privacy-first: no check without user action.

### Distribution

- Windows: NSIS installer (`-setup.exe`) and an MSI. Linux: `.deb`, `.rpm`, and
  a downloadable Flatpak bundle. Updater artifacts are signed with the project's
  minisign key; OS-level code signing is not yet set up.
