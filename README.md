<p align="center">
  <img src="design-assets/inkycap-logo.png" alt="InkyCap" width="120">
</p>

<h1 align="center">InkyCap</h1>

<p align="center">
  A personal knowledge management (PKM) application for writing, academic, and research note-taking. InkyCap builds upon Typst markup, principles of reciprocal linking, portable metadata, and long-term, local-first ownership of your work. More at https://inkycap.org
</p>

---

> **Where this project lives.** InkyCap is developed on
> **[Codeberg](https://codeberg.org/InkyCap/app)**. That is where the issue
> tracker, pull requests and releases are. The
> [GitHub repository](https://github.com/InkyCap-PKM/app) is a read-only mirror
> that exists only to build the macOS and Windows installers, since Codeberg
> has no runners for those platforms. **Issues and pull requests opened on
> GitHub will not be seen.** Please use Codeberg.

---

InkyCap is an experimental project from a person that cares about knowledge management. In spite of making my best efforts to continue it, I am not a professional developer and there are no guarantees here. **If you are interested in this project please contact me, I would be happy to explore collaboration** (especially if you have some expertise or know-how with the open technologies underpinning it). 

InkyCap is a desktop knowledge-management and writing tool whose documents are plain text [Typst](https://typst.app) files. It provides organizational flexibility, discoverability, and advanced recall functionality for notes. Notes are not trapped in a proprietary format; they are real Typst source, which compiles anywhere, and their metadata is queryable with the `typst` command-line tool, with or without InkyCap. InkyCap is currently available in English / Français.

## Why InkyCap

- **Reciprocal note-linking.** Wikilinks and automatic backlinks are the centre
  of the navigation model, not an add-on.
- **Portable, typed metadata.** Note properties are typed arguments to a Typst
  `#note(...)` call, queryable by any Typst tool through the bundled
  `inkycap-notebox` package. Your structure travels with your files.
- **Three editor modes.** Source (full Typst), visual (write-what-you-mean convenience over
  live Typst markup), and reading (the rendered document).
- **First-class bibliography.** Native Typst BibTeX/Hayagriva citations and a
  dedicated References sidebar, with Zotero integration.
- **The Mycelial View.** A graph that surfaces *emergent concepts* (recurring ideas you have not yet
  named a page for) and *latent links* (notes you mention
  but never linked), using corpus statistics. It's goal is to help you identify where your interests want to grow.
- **Local-first and private.** No telemetry, no analytics, no remote logging, no built-in generative artificial intelligence consumption.
  Your notebox never leaves your device unless you decide to synchronize it or manually share your files.
- **Collaboration when you want it.** Optional whole-notebox git sync with a
  simplified, merge-first model that does not block writing on a conflict.
- **Open formats in and out.** Import from regular Markdown or an Obsidian-flavoured vault; export to PDF
  (including PDF/A and PDF/UA), HTML, Markdown, and ODT/DOCX/LaTeX via Pandoc.

## Status

InkyCap was introduced June 2026 and is in active development. The feature set is broad and fairly stable but expect some rough edges. It is not a commercial project, rather a labour-of-love. **Issues and contributions are welcome, especially from human developers with expertise in the open technologies underpinning InkyCap**.  

Mostly developed on a Linux system (Ubuntu), it has also been partially tested and seems to work reasonably well on Windows. In theory, there is evidence it works on a Mac but I do not have one to try it.

## Installing

Pre-built packages are published on the
[releases page](https://codeberg.org/InkyCap/app/releases). Pick the artifact for your platform:

- **Linux:** `.deb` / `.rpm` / Flatpak (download and install from the Flatpak file, not currently available on FlatHub).
- **Windows:** the `*-setup.exe` installer.
- **macOS:** the `.app` bundle. (macOS builds would be nice to include but I don't have access to a Mac so need help from someone else. Feel free to build from the source yourself). 

InkyCap has an in-app update-checker (Settings, Overview) that lets you request whether there is a new version available but you must download and install updates yourself (they are not automatic). See
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
npm run tauri dev    # launch the app with hot reload

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
- **Subsystem info:**
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
- **User documentation:** is available within the application. F1, then click the InkyCap icon at the top. Depending your app language setting (English / Français) the documentation will appear in that language. It is also visible on the [InkyCap website](https://inkycap.org/documentation/user-manual) (although it might not be as up-to-date on the site).

## Contributing

Contributions are welcome! Please read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Translations have their own short
guide: [CONTRIBUTING-translations.md](documentation/developer/CONTRIBUTING-translations.md).

## Technology

Rust + Tauri v2 (backend), TypeScript + Solid.js + CodeMirror 6 (frontend), the
`typst` crate for compilation and `typst query` for metadata, and a Tinymist
sidecar for language-server features.

## Security and privacy

InkyCap is local-first and does not transmit information about your use, setup, or your data itself. I maintain and improve InkyCap on a best-effort, voluntary basis. To report a vulnerability, see [SECURITY.md](SECURITY.md). 

## Position on AI authorship of InkyCap's source code
One reason among many that I started InkyCap was as an early experiment to experience how coding with generative artificial intelligence (gen AI) might work. Thus, much but not all of InkyCap's development is accomplished with the assistance of gen AI. This does not mean that I passively accept all the code produced. My approach involves directing the research, planning, organization, testing (I do a lot of testing), and revision of the development. The project is gated by automated formatting, linting, type, and test suites. Nevertheless, I do not claim total expertise and it's possible that I will overlook something or make errors. I continually question and critique all aspects of AI usage in the project and the broader systemic context. I would value more contributors with expertise that want to improve InkyCap. I also recognize that some people might provide useful contributions through the use of gen AI tools and I request that these be equally conscientiously considered and tested. The code is original to this project and released under the permissive, open source LiLiQ-P 1.1 licence; copyright is held by the author. InkyCap itself contains no gen AI. 

## Licence

InkyCap is released under the Québec Free and Open-Source Licence, Permissive
(**LiLiQ-P 1.1**). See [LICENSE](https://codeberg.org/InkyCap/app/src/branch/main/LICENSE) (English) and [LICENSE.fr](https://codeberg.org/InkyCap/app/src/branch/main/LICENSE.fr) (French). This is similar to many other open source licences and is approved by both the Open Source Initiative and Free Software Foundation. It essentially gives you rights to see, copy, modify, redistribute the code. 
