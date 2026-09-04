# Contributing to InkyCap

Thank you for your interest in improving InkyCap. This guide covers the dev
environment, the conventions that matter, and the workflow. The short version:
read [`CLAUDE.md`](CLAUDE.md) and prefer the choice that
is correct for the long term over the one that looks finished sooner.

## Ground rules

InkyCap is built to be picked up by future contributors who have not seen any of
its history. Two principles govern almost every decision:

- **Typst-first.** Before writing any new feature, conversion, or workflow, ask:
  *can Typst do this natively?* The document model is Typst; code that reaches
  for Typst directly stays correct as Typst evolves, while code that
  reimplements parsing, metadata extraction, citation formatting, or layout
  drifts. The strict order of preference (built-in Typst, then the
  `inkycap-notebox` package, then thin Rust glue, then custom code as a last
  resort) is in [`CLAUDE.md`](CLAUDE.md). If you reach for the last resort,
  leave a comment naming what you considered and why it did not work.
- **No stopgaps.** Prefer the design that minimizes total rework, even if
  the current task looks less complete on its own.

[`CLAUDE.md`](CLAUDE.md) is the normative reference for engineering standards. It
overrides convenience when the two conflict. This file is the practical
on-ramp; that file is the law.

## Development environment

See [README.md](README.md) for full setup. In brief:

```sh
npm install
./scripts/download-tinymist.sh
npm run tauri dev
git config core.hooksPath .githooks   # once, enables the rustfmt pre-commit hook
```

The architecture map in
[documentation/developer/architecture.md](documentation/developer/architecture.md)
explains how the pieces fit together and where each responsibility lives. Read it
before making structural changes.

## Important Conventions

These conventions are enforced by tests or CI.

- **Path safety across IPC.** Every path crossing Rust to the frontend goes
  through `to_frontend_string`; the frontend compares paths through
  `normalizePath` / `pathEquals` / `pathStartsWith`. `path.display().to_string()`
  is grep-banned by `src-tauri/tests/path_safety.rs`.
- **UTF-8 safety.** Never build a string by casting bytes `as char`. Slice by
  ASCII byte boundaries or iterate `char_indices()`. Grep-banned by
  `src-tauri/tests/utf8_safety.rs`.
- **The `NoteboxStorage` seam.** All notebox file I/O goes through the trait,
  never `std::fs` directly.
- **Internationalization.** Every user-facing string flows through the locale
  seam in `src/lib/i18n.ts`; strings live in `src/locales/*.json`. CI fails on
  bare JSX text (`src/lib/i18n-coverage.test.ts`) and on locale key/placeholder
  drift (`npm run i18n:check`). Backend errors localize through the
  `{ code, message, detail }` envelope, not by matching English text.
- **UI tokens, never literals.** Radii, spacing, colours, z-indexes, and motion
  come from the token scales in `src/styles/themes.css`. Menus/popups use
  `--popup-*`, dialogs use `--modal-*`. Buttons use `.btn`, icon buttons use
  `.ui-icon-btn`, chips use `.badge`. Details in
  [documentation/developer/ui-styling.md](documentation/developer/ui-styling.md).
- **No all-caps UI text.** Never `text-transform: uppercase` or `small-caps`.
  Distinguish labels with weight, spacing, and colour.
- **CM6 editable widgets** follow a specific recipe (atomic wrap, focus routing,
  dispatch on blur). Read the CM6 widget section of `CLAUDE.md` and use
  `VerseWidget` as the reference, or you will reintroduce the reverse-typing bug.
- **Canadian English** default spellings in user-facing text and docs.

## Tests and gates

Run these before opening a pull request. CI (`.forgejo/workflows/ci.yml`) runs
the same gates server-side:

```sh
cargo fmt --check --manifest-path src-tauri/Cargo.toml   # formatting
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml         # Rust unit + integration
npx tsc --noEmit                                         # frontend typecheck
npm test                                                 # Vitest
npm run i18n:check                                       # locale parity
```

Tests are also documentation. Cover load-bearing invariants at the unit level:
source ↔ visual round-trip identity, `#note(...)` property preservation (byte
for byte for untouched fields), and `typst query` label stability.

## Pull request workflow

- Branch from `main`. Keep changes focused; one logical change per PR.
- New features land as composable units (a CodeMirror extension, a notebox
  command, an event-bus subscriber), not edits scattered through unrelated
  modules.
- Update documentation in the **same** change that alters behaviour. If you
  change a subsystem, update its doc under `documentation/developer/`.
- Make sure every gate above passes.
- Write a clear PR description: what changed, why, and how you verified it.

## Branching and releases

InkyCap is trunk-based: a single long-lived branch, `main`, with no separate
`develop` branch. The rules that keep that workable:

- **`main` stays green.** Every commit on `main` should build and pass the gates
  above. Land work through pull requests so CI runs before merge; reserve direct
  commits to `main` for trivial, obviously-safe fixes.
- **Work happens on short-lived branches.** Branch from `main`, keep the branch
  to one logical change, open a PR, merge when green, then delete the branch.
  This applies to maintainers too, not only outside contributors.
- **Releases are tags, not branches.** A release is a `vYY.MM.RELEASE` tag on
  `main` (e.g. `v26.6.4`) that triggers the release pipeline. The last version
  component selects the channel: **even = stable, odd = beta/development**. So
  `main` can carry unreleased work freely; users only ever receive what is
  tagged and published. The runbook is
  [documentation/developer/releasing.md](documentation/developer/releasing.md).
- **Maintenance branches are created only when needed.** If a shipped release
  needs a fix while `main` has already moved on, branch `release/YY.MM.x` from
  the release tag, fix and tag the patch there, then bring the fix back to
  `main`. There is no standing release branch to maintain.

## Reporting bugs and proposing features

Open an issue on the [Codeberg tracker](https://codeberg.org/InkyCap/app/issues).
For bugs, include your platform, the InkyCap version, and the smallest steps that
reproduce the problem. For security issues, do **not** open a public issue; see
[SECURITY.md](SECURITY.md).

## Translations

Adding or updating a language is a JSON file plus one metadata entry, no code
required. See
[documentation/developer/CONTRIBUTING-translations.md](documentation/developer/CONTRIBUTING-translations.md).

## Questions

For development questions not tied to a specific bug, reach the maintainers at
`dev@inkycap.org`.
