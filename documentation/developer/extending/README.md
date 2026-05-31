# Extending InkyCap

> **Audience:** developers who want to extend InkyCap without modifying its source.
> **Status:** living spec. Update whenever the extension surfaces change.

InkyCap is built to be extended from the outside. There are **four ways** to do
it, from least to most involved. Reach for the lowest one that does the job —
the lower rungs are simpler, safer, and need no InkyCap code.

| Want to… | Use | Needs InkyCap code? |
|---|---|---|
| Read/write notes & metadata from another program | [The open notebox format](notebox-format.md) | No |
| Add `/`-commands, snippets, or saved query-views | [Declarative plugins](declarative-plugins.md) | No |
| Pipe note text through your own program (grammar, AI, dictation, linters…) | [External tools](external-tools.md) | No |
| Add new document functions, styling, or metadata | A [Typst package](https://typst.app/docs/reference/) (`inkycap-notebox` or `@preview`) | No |

A deeper, in-process plugin runtime (custom panes, sandboxed compute) is a
possible future tier; the registries the declarative system uses
(`palette-registry`, `right-panel-registry`, `sidebar-registry`) are the seams
it would attach to. Today those registries are usable by in-tree code and by
declarative manifests.

## Decision guide

- **Just need the data?** Operate on the files. A notebox is plain Typst plus a
  documented `.inkycap/` layout, and all metadata is queryable with the `typst`
  CLI. No app, no API — see [notebox-format.md](notebox-format.md).
- **Want to add editor commands or snippets, or a saved-search pane, with no
  code?** Drop a JSON manifest in a plugins folder — see
  [declarative-plugins.md](declarative-plugins.md).
- **Want to run a program on the current note/selection and use its output?**
  Register an external tool — see [external-tools.md](external-tools.md). This is
  how you'd wire up LanguageTool, an LLM, a dictation post-processor, or a
  custom formatter without InkyCap shipping any of them.
- **Want new document-level behaviour** (a new callout, a metadata schema, a
  layout helper)? That's Typst's job — extend `inkycap-notebox/lib.typ` or import
  a Universe package. See [CLAUDE.md](../../../CLAUDE.md)'s Typst-first principle.

## Principles

- **Local-first.** Nothing here sends your notes anywhere. External tools run on
  your machine; if *you* point one at a network service, that's your call.
- **You authorize what runs.** InkyCap only executes programs you explicitly
  register (the same model as the Pandoc and Zotero paths). Declarative plugins
  run no code at all.
- **Additive, not invasive.** Every extension point adds to InkyCap; none
  require patching it. Your extension keeps working across updates because it
  rides documented contracts, not internals.
