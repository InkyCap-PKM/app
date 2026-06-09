<p align="center">
  <img src="design-assets/inkycap-logo.png" alt="InkyCap" width="120">
</p>

<h1 align="center">InkyCap</h1>

<p align="center">
  A Typst editor for writing, academic, and research note-taking, built around
  reciprocal links, portable metadata, and local-first ownership of your work.
</p>

---

InkyCap is a desktop knowledge-management editor whose documents are plain
[Typst](https://typst.app) files. It is built for people who write seriously:
researchers, academics, and anyone who wants their notes to stay legible,
linkable, and theirs. Notes are not trapped in a proprietary format; they are
real Typst source that compiles anywhere, and every piece of metadata is
queryable with the `typst` command-line tool, with or without InkyCap.

## Why InkyCap

- **Reciprocal note-linking.** Wikilinks and automatic backlinks are the centre
  of the navigation model, not an add-on.
- **Portable, typed metadata.** Note properties are typed arguments to a Typst
  `#note(...)` call, queryable by any Typst tool through the bundled
  `inkycap-notebox` package. Your structure travels with your files.
- **Three editor modes.** Source (full Typst), visual (write-what-you-mean over
  live Typst markup), and reading (the rendered document).
- **First-class bibliography.** Native Typst BibTeX/Hayagriva citations and a
  dedicated References sidebar, with Zotero integration.
- **The Mycelial View.** A graph that surfaces *latent links* (notes you mention
  but never linked) and *emergent concepts* (recurring ideas you have not yet
  named a page for), using classical corpus statistics rather than guesswork.
- **Local-first and private.** No telemetry, no analytics, no remote logging.
  Your notebox never leaves your device unless you opt into sync.
- **Collaboration when you want it.** Optional whole-notebox git sync with a
  calm, merge-first model that never blocks your writing on a conflict.
- **Open formats in and out.** Import from Markdown/Obsidian; export to PDF
  (including PDF/A and PDF/UA), HTML, Markdown, and DOCX/ODT/LaTeX via Pandoc.

## Status

InkyCap is in active development, working toward its first public release. The
feature set is broad and the core is stable, but expect rough edges. Issues and
contributions are welcome.

## Installing

Pre-built packages are published on the
[releases page](https://codeberg.org/InkyCap/app/releases). Pick the artifact for
your platform:

- **Linux:** AppImage (self-updating), or `.deb` / `.rpm` / Flatpak.
- **Windows:** the `*-setup.exe` installer.
- **macOS:** the `.app` bundle. (macOS builds are not yet code-signed, so
  Gatekeeper will warn on first launch.)

The app has an in-app updater (Settings, Overview). See
[documentation/developer/releasing.md](documentation/developer/releasing.md) for
how releases and the updater work.

## Building from source

### Prerequisites

- **Rust** (the version is pinned in [`rust-toolchain.toml`](rust-toolchain.toml);
  `rustup` reads it automatically).
- **Node.js** 20+ and npm.
- **Tauri v2 system dependencies** for your platform. Follow the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) (on
  Linux this is WebKitGTK and related `-dev` packages).

### Setup

```sh
git clone https://codeberg.org/InkyCap/app.git inkycap
cd inkycap
npm install                      # frontend deps (also runs patch-package)
./scripts/download-tinymist.sh   # fetch the Tinymist LSP sidecar (verified by pinned SHA-256)
```

The Tinymist sidecar powers code-mode autocomplete and is bundled as a Tauri
`externalBin`. It is downloaded into `src-tauri/binaries/` (gitignored), so this
step is required before the first build.

### Run and test

```sh
npm run tauri:dev    # launch the app with hot reload
                     # (plain `npm run tauri dev` works too; tauri:dev unsets a
                     #  few VS Code/snap env vars that confuse WebKitGTK on Linux)

cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit + integration tests
npm test                                          # Vitest frontend tests
npm run i18n:check                                # locale key/placeholder parity
```

Enable the formatting pre-commit hook once per clone:

```sh
git config core.hooksPath .githooks
```

## Repository layout

```
inkycap/
├── src/                  Frontend: Solid.js UI + CodeMirror 6 editor
├── src-tauri/            Backend: Rust + Tauri v2
├── inkycap-notebox/      The Typst package bundled into every notebox (lib.typ)
├── scripts/              Build/setup scripts (Tinymist, icons, versioning, i18n)
├── documentation/        Developer and user documentation
├── CLAUDE.md             Engineering principles and normative coding standards
└── .forgejo/workflows/   CI and release pipelines (Codeberg/Forgejo Actions)
```

## Documentation

- **[Architecture overview](documentation/developer/architecture.md)** is the
  starting point for contributors: how the backend, frontend, and Typst pipeline
  fit together.
- **Subsystem deep-dives:**
  [Mycelial View](documentation/developer/subsystems/mycelial-view.md) ·
  [Journal Scroll](documentation/developer/subsystems/journal-scroll.md) ·
  [Collections](documentation/developer/subsystems/collections.md) ·
  [Agenda](documentation/developer/subsystems/agenda.md) ·
  [Bibliography & Zotero](documentation/developer/subsystems/bibliography-zotero.md) ·
  [Collaboration / git](documentation/developer/subsystems/collaboration-git.md) ·
  [Import, export & backup](documentation/developer/subsystems/import-export-backup.md)
- **[The visual editor pill system](documentation/developer/visual-editor/pill-system.md)**,
  **[UI styling tokens](documentation/developer/ui-styling.md)**, and
  **[extending InkyCap without forking](documentation/developer/extending/README.md)**.
- **[CLAUDE.md](CLAUDE.md)** holds the project's governing engineering
  principles (the Typst-first rule, UTF-8/path-safety invariants, i18n, the UI
  token system). Read it before contributing code.

## Contributing

Contributions are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first. Translations have their own short
guide: [CONTRIBUTING-translations.md](documentation/developer/CONTRIBUTING-translations.md).

## Technology

Rust + Tauri v2 (backend), TypeScript + Solid.js + CodeMirror 6 (frontend), the
`typst` crate for compilation and `typst query` for metadata, and a Tinymist
sidecar for language-server features.

## Security and privacy

InkyCap is local-first and collects nothing. To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Licence

InkyCap is released under the Québec Free and Open-Source Licence, Permissive
(**LiLiQ-P 1.1**). See [LICENSE](LICENSE) (English) and [LICENSE.fr](LICENSE.fr)
(French).
