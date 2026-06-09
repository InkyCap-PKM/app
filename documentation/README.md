# InkyCap Documentation

This folder holds InkyCap's living documentation, split by audience.

## Structure

- **[`developer/`](developer/)**: reference material for contributors: architecture, design decisions, normative rules for subsystems. Update whenever the corresponding code or design changes.
- **[`user/`](user/)**: end-user documentation: how to use InkyCap, notebox concepts, editor features. (Reserved; content to come.)

## Developer documentation

Start here:

- [Architecture overview](developer/architecture.md): how the Rust backend, the
  Solid.js + CodeMirror frontend, and the Typst pipeline fit together; the
  architectural seams; the `.inkycap/` on-disk layout. The map for new
  contributors.

Subsystem deep-dives:

- [The Mycelial View](developer/subsystems/mycelial-view.md): the corpus-stats
  engine (TF-IDF, PMI, cosine similarity), latent links and emergent concepts,
  the neighborhood model, and the force-directed layout.
- [The Journal Scroll](developer/subsystems/journal-scroll.md): the `ScrollQuery`
  primitive, one-directional pagination, always-on connection flags, and manual
  scroll anchoring for the chronological reading view.
- [Collections](developer/subsystems/collections.md): the database-like layer:
  the recursive filter query language, computed membership, table/agenda views,
  per-collection styling, and book/CSV/static-site publishing.
- [The Agenda](developer/subsystems/agenda.md): task and dated-item aggregation
  from note properties and inline `#task`/`#due` markers.
- [Bibliography and Zotero](developer/subsystems/bibliography-zotero.md):
  Typst-native citations, file and Zotero libraries, the References sidebar,
  citation autocomplete, and CSL style resolution.
- [Collaboration and sync (git)](developer/subsystems/collaboration-git.md): the
  merge-first model, hunk-level review and revert, structured settings merge,
  version history, credentials, and offline package mode.
- [Import, export, and backup](developer/subsystems/import-export-backup.md):
  Markdown import with property mapping, the export matrix (PDF/A and PDF/UA,
  HTML, Pandoc-via-HTML, merged book export), and encrypted ZIP backups.

Editor, UI, and extension surfaces:

- [Visual Editor, Pill System](developer/visual-editor/pill-system.md): the
  universal `#` pill: kinds, consistency rules (R1 to R11), registry, and how to
  add new pills.
- [UI styling](developer/ui-styling.md): the token system (radius, spacing,
  colour, surfaces), buttons, badges, and inputs.
- [Releasing InkyCap](developer/releasing.md): the `YY.MM.RELEASE` versioning
  scheme and channels, the release pipeline, and the in-app updater.
- [Extending InkyCap](developer/extending/README.md): the four ways to extend
  InkyCap without modifying it:
  - [The open notebox format](developer/extending/notebox-format.md): read/write notes & metadata from any program.
  - [Declarative plugins](developer/extending/declarative-plugins.md): add `/`-commands, snippets, and query-views via a JSON manifest.
  - [External tools](developer/extending/external-tools.md): pipe note text through your own program (grammar, AI, dictation, linters).

## Conventions

- Documentation is committed to the repo; treat it as code.
- When you change subsystem behavior, update the corresponding doc in the same change.
- Cross-link freely. Use relative paths so links stay valid when the repo is cloned.
- Match the project tone: precise, terse, no marketing language.
