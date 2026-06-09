# InkyCap architecture

> **Audience:** developers picking up InkyCap for the first time.
> **Status:** living reference. Update it in the same change that moves the code.

This document is the map. It explains how the pieces fit together so you can
find the right module quickly and understand *why* a given responsibility lives
where it does. For the rules you must follow while editing, read
[`CLAUDE.md`](../../CLAUDE.md) at the repo root, the normative source for
the Typst-first principle, UTF-8/path-safety invariants, i18n, and the UI token
system. This file describes the structure; `CLAUDE.md` governs the conduct.

---

## 1. The shape in one paragraph

InkyCap is a **Tauri v2** desktop app. The **backend is Rust** (`src-tauri/`)
and owns the filesystem, the Typst compiler, all indexes, and git
collaboration. The **frontend is TypeScript + Solid.js** (`src/`) with a
**CodeMirror 6** editor at its centre. The two halves talk only through
**Tauri commands** (typed IPC). The document model is **Typst source on disk**.
InkyCap never invents its own note format; it stores `.typ` files and asks Typst
itself (via compilation and `typst query`) what they mean. Everything else (backlinks, tags, properties,
collections, the mycelial graph) is an *index* derived from that source of
truth.

```
┌──────────────────────────── Tauri webview ──────────────────────────────┐
│  Solid.js UI (src/components, src/stores)                               │
│  CodeMirror 6 editor (src/editor) - source / visual / reading modes     │
│         │  typed calls only, via src/lib/ipc.ts                         │
└─────────┼───────────────────────────────────────────────────────────────┘
          │  Tauri IPC  (invoke ↔ #[tauri::command])
┌─────────┼───────────────────────────────────────────────────────────────┐
│  Rust backend (src-tauri/src)                                           │
│   commands/  →  state.rs (AppState + per-window NoteboxSession)          │
│        │                                                                 │
│   storage (NoteboxStorage trait) ── typst_pipeline (compile + query)     │
│   scanner ── link_index ── search ── corpus_stats ── cache               │
│   git ── markdown ── backup ── events (AppEvent bus)                     │
│        │                                                                 │
│   inkycap-notebox Typst package (bundled, written into every notebox)    │
└─────────────────────────────────────────────────────────────────────────┘
          │  reads/writes
   ┌──────┴───────┐
   │  notebox/    │   plain .typ files + a documented .inkycap/ directory
   └──────────────┘
```

---

## 2. The document model: Typst as source of truth

A **notebox** is a directory of Typst (`.typ`) files plus a reserved
`.inkycap/` subdirectory. Notes are not a bespoke format; they are real Typst
documents that compile in any Typst environment. The metadata layer is a small
Typst package, **`inkycap-notebox`** (top-level [`inkycap-notebox/`](../../inkycap-notebox/),
`lib.typ` is the entry point), bundled into the binary and written into every
notebox at `.inkycap/packages/inkycap-notebox/<version>/`. Notes auto-import it:

```typst
#import "/.inkycap/packages/inkycap-notebox/<version>/lib.typ": *
#note(title: "…", tags: ("a", "b"))
= Heading
Body with a #wikilink("Other Note") and a #tag("idea").
```

The package defines the primitives (`note`, `tag`, `wikilink`, `link-ref`,
`embed`, `callout`, `verse`, `set-notebox`) and the stable query labels
(`<inkycap-note>`, `<inkycap-tag>`, `<inkycap-link>`, …). InkyCap extracts
metadata by running **`typst query`** against those labels rather than parsing
note text itself. This is the **Typst-first principle** in action: the
extraction stays correct as Typst evolves because Typst does the parsing.

**Why this matters for a contributor:** before writing a parser, a metadata
extractor, a TOC builder, a citation formatter, or any Typst-syntax string
builder in Rust or TypeScript, stop. Typst almost certainly does it already.
See `CLAUDE.md`'s Typst-first section for the order of preference.

---

## 3. Backend (`src-tauri/src`)

### 3.1 Entry points

- [`main.rs`](../../src-tauri/src/main.rs) is the Tauri builder: registers plugins
  (shell, dialog, updater, process), initializes `AppState`, restores window
  geometry, and installs the command handler.
- [`lib.rs`](../../src-tauri/src/lib.rs) declares every module and the full
  `invoke_handler` list of commands. **This is the index of what the backend
  exposes.** Two crate-wide clippy allows (`too_many_arguments`,
  `type_complexity`) live here for inherent domain shape.

### 3.2 State model: global vs. per-window

State lives in [`state.rs`](../../src-tauri/src/state.rs) and is split in two:

- **`AppState`**: process-global. Holds the shared metadata cache and the
  session map `sessions: HashMap<window_label, Arc<NoteboxSession>>`. There is
  **one session per window**, keyed by the Tauri window label (`"main"`, and
  one per extra window).
- **`NoteboxSession`**: everything tied to one open notebox in one window: the
  `notebox_root`, the `NoteboxStorage` impl, the `TypstCompiler`, and the
  indexes (`LinkIndex`, `PropertyIndex`, `SearchEngine`, `CorpusStats`), plus
  the file watcher and per-notebox settings.

A command resolves its session from the window that called it:

```rust
let session = state.session(&window.label()).await?;
let root = session.notebox_root.read().await.clone()
    .ok_or(InkyCapError::NoNoteboxOpen)?;
```

Two windows cannot share one notebox session. Index locks are acquired in a
fixed order to avoid deadlocks: follow the ordering documented in `state.rs`.

### 3.3 The architectural seams

These are the stable interfaces named in `CLAUDE.md`. New backends and features
attach here rather than threading through callers:

| Seam | Where | What it hides |
|---|---|---|
| **`NoteboxStorage`** trait | `storage/` | All file I/O. The only sanctioned way to read/write/rename/delete notebox files. A future sync or encrypted backend implements this trait; callers don't change. **Never call `std::fs` directly on notebox content.** |
| **Event bus** (`AppEvent`) | `events/` | Significant state changes (file created/changed/renamed, index rebuilt, git progress). Emitted to a specific window via Tauri's `emit_to`. The seam a plugin host would subscribe to. |
| **`LinkIndex`** | `link_index/` | Forward links and backlinks. Wikilink strings come from `typst query` (Typst's job); resolving them to file paths is InkyCap's job and lives here. |
| **Extension enums** | `creation_rules/`, `property_types.rs`, … | Shapes defined as enums *before* a runtime plugin loader exists, so future variants slot in additively. |

### 3.4 Path discipline across IPC (a load-bearing invariant)

Every path that crosses Rust → frontend must go through
`crate::storage::to_frontend_string` (in `storage/path.rs`). Raw
`path.display().to_string()` leaks OS-native shape (Windows `\\?\` UNC prefixes,
backslash separators) and the frontend then mis-compares it against paths from
other sources. The integration test `src-tauri/tests/path_safety.rs` greps for
`.display().to_string()` and fails CI if it reappears. On the frontend, mixed
path comparisons run through `normalizePath` / `pathEquals` / `pathStartsWith`
in [`src/lib/paths.ts`](../../src/lib/paths.ts). The same kind of grep-gate
(`src-tauri/tests/utf8_safety.rs`) forbids `as char` byte-casting that would
shred multi-byte text. Read the Rust coding-standards section of `CLAUDE.md`
before touching string or path transforms.

### 3.5 Module tour

The backend is organized by responsibility, one concern per top-level module:

| Module | Responsibility |
|---|---|
| `commands/` | The IPC surface: one submodule per feature area (notebox, files, collections, search, git, export, markdown, backup, mycelial, …). All async, all returning `Result<T, InkyCapError>`. |
| `storage/` | `NoteboxStorage` trait + `LocalNoteboxStorage` filesystem impl + `to_frontend_string` path normalization. |
| `typst_pipeline/` | The Typst engine wrapper: the `World` impl over notebox storage, the compiler (SVG/PDF/HTML + query), diagnostics, error-tolerant recovery, font resolution, `path_rebase.rs` (AST path rewriter), package fetch/vendor, book assembly, style injection. |
| `scanner/` | Walks the notebox, runs `typst query` per note, builds the `PropertyIndex`. |
| `link_index/` | Forward/back link graph; resolves wikilink strings to paths. |
| `search/` | Full-text inverted index + `text_projection.rs` (Typst-AST → prose tokens, excluding `#note(...)` metadata and imports). |
| `corpus_stats/` | TF-IDF / PMI / cosine statistics behind the Mycelial View. |
| `cache/` | On-disk metadata cache reconciled against file mtimes (best-effort; absent ≠ error). |
| `watcher/` | Filesystem change notifications (`notify`), debounced into reindex events. |
| `git/` | Whole-notebox git collaboration: libgit2 backend, merge-first sync, hunk review, structured settings merge, credentials, offline package mode. |
| `markdown/` | Markdown ↔ Typst import/export, frontmatter parsing + property mapping. |
| `backup/` | ZIP (optionally AES-256) archive build, schedule, retention, restore. |
| `models/` | Serde types crossing IPC (`NoteMetadata`, `NoteboxInfo`, collection rows, …). |
| `events/` | The `AppEvent` enum and emission helpers. |
| `collection_parser/` | Parser for collection filter expressions. |
| `creation_rules/`, `scaffolds/` | Templates and rules for new notes. |
| `notebox_package.rs` | Embeds `inkycap-notebox`, defines the query labels and on-disk format version, scaffolds `.inkycap/`. |
| `notebox_settings.rs` | Per-notebox `settings.json` (travels with the notebox) and per-machine `local.json` (git config, last-sync state, never travels). |
| `errors.rs` | `InkyCapError`: the localizable `{ code, message, detail }` IPC error envelope. |

For the precise file-by-file breakdown, read `lib.rs` top-to-bottom; it lists
every module and command in one place.

### 3.6 The Typst compile loop (the hot path)

Each session holds one long-lived `TypstCompiler` so Typst's `comemo`
memoization stays warm across edits; the first compile of a notebox pays a
one-time font/world warm-up, subsequent incremental compiles are fast. The
compiler exposes SVG (preview), PDF, HTML, and `query`. The `World` impl routes
*all* file access through the notebox's `LocalNoteboxStorage`, sandboxed to the
notebox root, so a malicious `#read(...)` cannot escape the notebox.

Performance is a first-class concern here: incremental compilation, debounced
edits, and cached query results are the *default*, not an optimization. See the
Performance directives in `CLAUDE.md`.

---

## 4. Frontend (`src`)

### 4.1 Layout

| Directory | Responsibility |
|---|---|
| `components/` | Solid.js components: panels, dialogs, sidebars, the views. |
| `editor/` | The CodeMirror 6 editor. `typst-decorations/` holds one extension per feature; `lsp/` is the Tinymist client. |
| `stores/` | Solid signal-based state (notebox, editor, tabs, panes, settings, theme, git, mycelial, locale, …). |
| `lib/` | Cross-cutting utilities: `ipc.ts` (typed command wrappers), `i18n.ts` (the locale seam), `errors.ts`, `paths.ts`, the command registry, event listeners. |
| `locales/` | Flat `<code>.json` translation dictionaries; `en.json` is the source of truth. |
| `styles/` | `themes.css` (the token system) + component CSS. |

### 4.2 IPC and errors

The frontend **never calls raw `invoke()`**: every backend command has a typed
wrapper in [`src/lib/ipc.ts`](../../src/lib/ipc.ts). Backend errors arrive as the
`{ code, message, detail }` envelope; resolve them for display with
`errorText()` and branch on `errorCode()` from
[`src/lib/errors.ts`](../../src/lib/errors.ts); never match on localized text,
never `String(err)` at a display site.

### 4.3 The editor: a decoration layer, not a round-trip

The visual editor is **Tier 1**: a CodeMirror 6 decoration layer over Typst
source. The buffer is *always* Typst; there is no ProseMirror parse/serialize
step, and a hybrid is explicitly out of scope. The three modes (source / visual
/ reading) are different *views* of the same `.typ` text:

- **Source**: full Typst, no decorations.
- **Visual**: WYSIWYM: decorations hide function markup behind the universal
  `#` pill, render wikilinks/tags/images as widgets, and let direct formatting
  (`*bold*`, `_italic_`, `= heading`, `- list`) read naturally. It recognizes
  *Typst's own* syntax: Markdown shortcuts like `**bold**` are **not**
  aliases. See [`visual-editor/pill-system.md`](visual-editor/pill-system.md).
- **Reading**: the compiled Typst, rendered.

Round-trip identity (source ↔ visual) and `#note(...)` property preservation are
**load-bearing invariants** with unit tests. Embedded-editable widgets (verse,
tables) follow a specific CM6 recipe; read the CM6 widget section of
`CLAUDE.md` before building one, or you will reintroduce the reverse-typing bug.

### 4.4 i18n

Every user-facing string flows through the locale seam in
[`src/lib/i18n.ts`](../../src/lib/i18n.ts). Components use the reactive
`useI18n()`; CM6 extensions, stores, and the command registry use the static
`t()` and refresh off `localeVersion()`. Strings live in `src/locales/*.json`,
keyed by dotted feature-area IDs. CI fails on bare JSX text via
`src/lib/i18n-coverage.test.ts`; `npm run i18n:check` enforces key/placeholder
parity. Adding a language is a JSON file plus a `LOCALE_META` entry; see
[`CONTRIBUTING-translations.md`](CONTRIBUTING-translations.md).

---

## 5. The `.inkycap/` notebox directory

Everything InkyCap adds to a notebox lives under `.inkycap/`, so the rest of the
directory stays clean Typst that any tool can read:

```
notebox/
├── My Note.typ                 # plain Typst, auto-imports the package
├── Assets/                     # attachments (configurable folder name)
└── .inkycap/
    ├── packages/
    │   └── inkycap-notebox/<version>/lib.typ   # the bundled metadata package
    ├── settings.json           # per-notebox settings (TRAVELS with the notebox)
    ├── local.json              # per-machine state: git config, last-sync, last
    │                           #   active file (NEVER travels, gitignored)
    ├── collections/*.collection
    ├── property-types.json     # custom property schema
    ├── mycelial-stopwords.txt  # user-excluded terms (mycelial view)
    └── dictionary.txt          # user force-included terms / spell allowlist
```

Caches (search index, corpus stats) live in the OS cache directory keyed by a
hash of the notebox root, **not** inside the notebox; they are rebuildable and
should never sync.

The split between `settings.json` (shared) and `local.json` (per-machine) is
deliberate and load-bearing for collaboration: anything device-specific (which
remote you sync to, your last cursor) stays in `local.json` so it never causes
merge churn. See [`subsystems/collaboration-git.md`](subsystems/collaboration-git.md).

---

## 6. Where to read next

- **Conventions you must follow:** [`CLAUDE.md`](../../CLAUDE.md) and
  [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
- **Subsystem deep-dives:**
  [Mycelial View](subsystems/mycelial-view.md) ·
  [Journal Scroll](subsystems/journal-scroll.md) ·
  [Collections](subsystems/collections.md) ·
  [Agenda](subsystems/agenda.md) ·
  [Bibliography & Zotero](subsystems/bibliography-zotero.md) ·
  [Collaboration / git](subsystems/collaboration-git.md) ·
  [Import, export & backup](subsystems/import-export-backup.md).
- **The editor:** [visual-editor/pill-system.md](visual-editor/pill-system.md).
- **Extending without forking:** [extending/README.md](extending/README.md).
- **UI design system:** [ui-styling.md](ui-styling.md).
- **Shipping a build:** [releasing.md](releasing.md).
