# The notebox open format

> **Audience:** developers writing tools that operate on an InkyCap notebox.
> **Status:** versioned contract. Breaking changes bump `notebox_format_version`.

A notebox is **plain files on disk** — there is no database and no proprietary
container. Any program can read and write a notebox directly; InkyCap's file
watcher notices external changes and re-indexes them. This page is the contract
that lets you do that safely.

## On-disk layout

```
<notebox>/
├── *.typ                      Notes — plain Typst. Arrange in folders freely.
├── <attachments>/             Images/media (folder name = settings.files.attachment_folder)
└── .inkycap/                  Reserved InkyCap directory
    ├── format.json            Version marker (see below) — read this first
    ├── notebox.typ            The bundled inkycap-notebox library (version-less path)
    ├── settings.json          Per-notebox settings
    ├── collections/           *.collection files
    ├── scaffolds/             Note templates
    ├── plugins/               Declarative plugin manifests (see declarative-plugins.md)
    └── packages/              Vendored Typst packages (when bundled)
```

Notes import the bundled library with one stable, version-less line:

```typ
#import "/.inkycap/notebox.typ": *
```

Paths InkyCap emits into note source (`image`, `read`, `bibliography`, …) are
**notebox-root-absolute** — they start with `/`, which Typst resolves against
the notebox root. Prefer that shape when you write paths too; relative paths are
tolerated but fragile under note moves.

## Detecting the format: `.inkycap/format.json`

Read this file first to confirm you understand the notebox. It is refreshed on
every notebox open, so it always reflects the InkyCap build that last touched
the notebox.

```json
{
  "notebox_format_version": "1",
  "library_version": "0.2.0",
  "import_line": "#import \"/.inkycap/notebox.typ\": *",
  "query_labels": [
    "inkycap-note", "inkycap-tag", "inkycap-link", "inkycap-agenda",
    "inkycap-annotation", "inkycap-suggestion"
  ],
  "docs": "documentation/developer/extending/notebox-format.md"
}
```

- **`notebox_format_version`** — the contract version. Check it before relying on
  the layout or labels below. A bump means something here changed
  incompatibly; gate your tool on a version you've tested.
- **`library_version`** — the embedded `inkycap-notebox` build (informational).
- **`query_labels`** — the stable Typst labels InkyCap emits and queries.

## Reading metadata with `typst query`

All structured metadata is exposed as labelled Typst `#metadata`, so you extract
it with the standard `typst` CLI — no InkyCap process required:

```sh
# Document properties (title, tags, date, aliases, …) for one note:
typst query path/to/note.typ "<inkycap-note>" --field value --one

# Every tag across a note:
typst query path/to/note.typ "<inkycap-tag>" --field value

# Outgoing links (wikilinks + link-ref metadata):
typst query path/to/note.typ "<inkycap-link>" --field value
```

`query_labels` lists the full set. Each label's `value` is a dictionary; the
exact keys are defined by the functions in
[`inkycap-notebox/lib.typ`](../../../inkycap-notebox/lib.typ) (`note`, `tag`,
`wikilink`, `task`, `due`, `annotation`, `suggestion`). That file is the source
of truth for the dictionary shapes.

## Writing safely from outside InkyCap

- **Write whole files.** Replace a note's content in one write; don't hold long
  locks. InkyCap writes atomically and its watcher reconciles your changes.
- **Keep the import line.** New `.typ` notes should begin with the `import_line`
  above so notebox functions resolve.
- **Don't repurpose `.inkycap/`.** Everything under it is InkyCap-reserved; add
  your own files elsewhere in the notebox, or under `.inkycap/plugins/` if you're
  shipping a [declarative plugin](declarative-plugins.md).

## Stability promise

The on-disk layout, the `.inkycap/format.json` shape, the `query_labels`, and the
dictionary keys emitted by `inkycap-notebox` are a **versioned contract**. They
do not change incompatibly without bumping `notebox_format_version` and noting
the migration. Build against the version you tested and check it at startup.
