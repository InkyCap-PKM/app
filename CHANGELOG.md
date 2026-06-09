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

## [Unreleased]

Nothing yet.

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
