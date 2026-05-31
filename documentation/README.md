# InkyCap Documentation

This folder holds InkyCap's living documentation, split by audience.

## Structure

- **[`developer/`](developer/)** — reference material for contributors: architecture, design decisions, normative rules for subsystems. Update whenever the corresponding code or design changes.
- **[`user/`](user/)** — end-user documentation: how to use InkyCap, notebox concepts, editor features. (Reserved — content to come.)

## Developer documentation

- [Visual Editor — Pill System](developer/visual-editor/pill-system.md) — the universal `#` pill: kinds, consistency rules (R1–R11), registry, and how to add new pills.
- [Extending InkyCap](developer/extending/README.md) — the four ways to extend InkyCap without modifying it:
  - [The open notebox format](developer/extending/notebox-format.md) — read/write notes & metadata from any program.
  - [Declarative plugins](developer/extending/declarative-plugins.md) — add `/`-commands, snippets, and query-views via a JSON manifest.
  - [External tools](developer/extending/external-tools.md) — pipe note text through your own program (grammar, AI, dictation, linters…).

## Conventions

- Documentation is committed to the repo; treat it as code.
- When you change subsystem behavior, update the corresponding doc in the same change.
- Cross-link freely. Use relative paths so links stay valid when the repo is cloned.
- Match the project tone: precise, terse, no marketing language.
