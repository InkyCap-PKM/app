# Bundled user manual

These are the **source** noteboxes for InkyCap's in-app user manual — the
documentation window opened from Help → "InkyCap Documentation" (and `F1`).

- `InkyCap-Documentation/` — English (base manual, universal fallback)
- `InkyCap-Documentation-fr-CA/` — French (Québec)

Each is a normal InkyCap notebox (Typst-native notes that dogfood `#wikilink`,
`#callout`, etc.) **minus its `.inkycap/` working directory** — that scaffold is
recreated on open by `crate::notebox_package::scaffold`, so it must not be
committed here.

## How they reach the app

They are embedded into the binary at compile time by
[`src-tauri/src/docs_manual.rs`](../../src-tauri/src/docs_manual.rs) via
`include_dir!`. On open, `open_documentation_notebox` seeds a **writable working
copy** under the per-platform config dir (e.g.
`~/.config/inkycap/InkyCap-Documentation/`) and opens it read-only/ephemeral —
in-app edits never persist. The working copy is refreshed whenever the embedded
content changes (a SHA-256 fingerprint stored at `.inkycap/.docs-version` gates
re-seeding), so an app update — or a developer rebuild — always ships the
matching manual.

## Editing the manual

Edit the `.typ` notes here directly (any editor), then rebuild. To preview live
inside InkyCap, point an external editor at the config-dir working copy — the
file watcher reloads changes; just remember those edits are ephemeral and the
committed source here is canonical.

Adding a locale: add the notebox folder here, then a match arm in
`docs_manual::embedded_manual` and the locale → folder mapping in
`docs_notebox_dir_name` (`src-tauri/src/commands/notebox.rs`).
