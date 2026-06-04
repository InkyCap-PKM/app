# Third-party licenses

InkyCap is built on open-source and free-culture work. This folder holds the
full licence text for every component InkyCap **redistributes** — fonts and
dictionaries bundled in the app, native libraries compiled into the binary, and
the front-end libraries shipped in the web bundle. It is bundled into the
distribution (see `bundle.resources` in `../tauri.conf.json`) so the licences
travel with every copy of the app, and it is the source of truth behind the
in-app **Settings → Sources** tab (`src/components/settings/SourcesSettingsSection.tsx`).

Each licence text is named by its SPDX identifier. Components that share a
licence point at the same file.

| Component | Role | Licence | File |
|-----------|------|---------|------|
| Inter | UI / sans font | OFL-1.1 | `OFL-1.1.txt` |
| JuliaMono | monospace / code font | OFL-1.1 | `OFL-1.1.txt` |
| Junicode | serif font | OFL-1.1 | `OFL-1.1.txt` |
| iA Writer Duospace | duospace writing font | OFL-1.1 | `OFL-1.1.txt` |
| Libertinus Serif | Typst default text font (via `typst-assets`) | OFL-1.1 | `OFL-1.1.txt` |
| New Computer Modern | Typst default math/text font (via `typst-assets`) | GPL-3.0 + font exception | `GPL-3.0-or-later.txt`, `NOTE-newcomputermodern.txt` |
| DejaVu Sans Mono | Typst default mono font (via `typst-assets`) | Bitstream Vera | `Bitstream-Vera.txt` |
| Typst | document model + compiler | Apache-2.0 | `Apache-2.0.txt` |
| Tinymist | Typst language server (sidecar binary) | Apache-2.0 | `Apache-2.0.txt` |
| typst-assets | bundled Typst default fonts/data | Apache-2.0 | `Apache-2.0.txt` |
| codemirror-lang-typst | Typst syntax for CodeMirror | Apache-2.0 | `Apache-2.0.txt` |
| CodeMirror | code editor | MIT | `MIT.txt` |
| Solid.js | UI framework | MIT | `MIT.txt` |
| @solid-primitives/i18n | locale seam | MIT | `MIT.txt` |
| KaTeX | math rendering | MIT | `MIT.txt` |
| Lucide | UI icons | ISC | `ISC.txt` |
| Tauri | application framework | MIT / Apache-2.0 | `MIT.txt`, `Apache-2.0.txt` |
| Hunspell | spellcheck engine | MPL-1.1 / GPL-2.0 / LGPL-2.1 | `MPL-1.1.txt`, `GPL-2.0-or-later.txt`, `LGPL-2.1-or-later.txt` |
| hunspell-asm | WASM build of Hunspell | MIT | `MIT.txt` |
| English dictionaries (Marco A.G. Pinto) | en_CA/US/GB spellcheck | LGPL-3.0 | `LGPL-3.0-or-later.txt` (also `../assets/dictionaries/LICENSE_en.txt`) |
| French dictionary (Dicollecte / Olivier R.) | fr spellcheck | MPL-2.0 | `MPL-2.0.txt` (also `../assets/dictionaries/LICENSE_fr.txt`) |
| Hayagriva | bibliography formatting | MIT / Apache-2.0 | `MIT.txt`, `Apache-2.0.txt` |
| biblatex | BibTeX parsing | MIT / Apache-2.0 | `MIT.txt`, `Apache-2.0.txt` |
| pulldown-cmark | Markdown import/export | MIT | `MIT.txt` |
| libgit2 (via `git2`) | git sync transport | GPL-2.0 + linking exception | `GPL-2.0-or-later.txt`, `NOTE-libgit2.txt` |
| OpenSSL (vendored) | TLS for git | Apache-2.0 | `Apache-2.0.txt` |
| SQLite (via `rusqlite`) | index/cache database | Public Domain | `NOTE-sqlite.txt` |
| stopwords-iso | Mycelial View stopword lists | MIT | `MIT.txt` |

Licence texts are the verbatim SPDX reference copies
(<https://github.com/spdx/license-list-data>). When adding a redistributed
component, add its row here, drop in any new SPDX licence text, and add an entry
to the Sources tab data.

## Exhaustive notices (auto-generated)

The table above is the curated, human-facing list — the same components shown
in **Settings → Sources**. Alongside it, two machine-generated files reproduce
the copyright/licence text of **every** dependency InkyCap distributes, as
MIT/BSD/ISC/Apache attribution clauses require:

| File | Covers | How it is built |
|------|--------|-----------------|
| `THIRD-PARTY-rust.txt` | every crate compiled into the binary (normal + build deps, transitive, all platform targets; dev-only excluded) | `cargo metadata --offline` + each crate's bundled `LICENSE*` |
| `THIRD-PARTY-js.txt` | every npm production dependency in the front-end bundle (`npm ls --omit=dev`) | each package's `package.json` + bundled `LICENSE*` |

Regenerate both after changing dependencies:

```sh
npm run licenses:gen
```

The generator is `scripts/gen-third-party-licenses.mjs` — fully offline (it
reads the resolved dependency graph and the licence files already on disk, no
network or extra tooling). A component that ships no licence file of its own
falls back to its declared SPDX identifier (whose full text is in this folder)
plus its authors/repository. Both files are committed so they travel with every
build; they are regenerated, not hand-edited.

Each file is laid out in two parts to avoid repetition: **Part 1** lists every
component with its metadata and a `License texts: #n` reference, and **Part 2**
prints each *unique* licence text once (numbered, with the list of components
that share it). Identical texts — most crates ship the byte-identical Apache-2.0
LICENSE — appear a single time; MIT/BSD texts, which each carry their own
copyright line, stay distinct so that per-component attribution is preserved.

## Techniques & conventions (no licence required)

These are methods and interaction patterns InkyCap implements itself — credited
in the Sources tab, but they carry no licence obligation:

- **TF-IDF** and **Pointwise Mutual Information (PMI)** — the computational-
  linguistics techniques behind the Mycelial View's emergent-concept detection.
- **F6 landmark cycling** — the keyboard navigation convention from the
  [W3C WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/).
