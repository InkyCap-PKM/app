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

Open the manual folder here (for example `documentation/manual/InkyCap-Documentation/`)
in InkyCap as an ordinary notebox (Settings → Overview → Manage noteboxes → Add).
Because it is outside the config dir it is a normal, writable notebox, so edits
save to these files directly and the app's book export works from it. The
`.inkycap/` working folder the app creates there is ignored by git and skipped
when the manual is embedded (see `docs_manual::extract_manual`); only the
`.inkycap/collections/*.collection` files are kept, since they hold the
"Export as book" settings used to produce the PDF manuals.

The copy the Help window opens (under the config dir) is read-only: edits made
there are never saved, so do not edit the manual through Help → InkyCap
Documentation.

Any external editor works too; the committed source here is canonical.

## Producing the PDF manuals

Each manual folder carries a collection in `.inkycap/collections/` whose
"Export as book" settings produce the single-file PDF published on
inkycap.org. Open the manual folder as a notebox, open that collection, and
choose Export → Export as book. The book is ordered by file path, keeps the
Index page as its opening page, and places the table of contents right after it.

Adding a locale: add the notebox folder here, then a match arm in
`docs_manual::embedded_manual` and the locale → folder mapping in
`docs_notebox_dir_name` (`src-tauri/src/commands/notebox.rs`).
