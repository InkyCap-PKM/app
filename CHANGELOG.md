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

## [26.7.4] - 2026-08-25

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
