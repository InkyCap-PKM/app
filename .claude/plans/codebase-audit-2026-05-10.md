# Codebase Audit — 2026-05-10

Cross-session plan tracking findings from the full-codebase audit on
2026-05-10. Items are grouped by axis. Mark `[x]` when done; add a
one-line note with the commit/PR or rationale on close. New findings
from later passes can be appended at the bottom under "Later additions".

## Top 5 (start here)

- [x] **SEC-1 — Restrict `copy_path_to_attachments` to trusted sources.**
  Done 2026-05-10. `AppState.drop_allowlist` (single-use, 60s TTL) is
  populated from `RunEvent::WindowEvent::DragDrop` in
  [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)'s run-loop
  callback. The command in
  [commands/file_ops.rs:323](../../src-tauri/src/commands/file_ops.rs#L323)
  rejects any path not on the allowlist. **Two earlier API attempts
  failed silently** before landing on the right hook —
  `WebviewWindow::on_window_event` (variant exists but never fires) and
  `WebviewWindow::on_webview_event` (variant exists but never fires).
  The empirically-verified hook on Tauri 2.10 + webkit2gtk Linux is
  the run-loop `RunEvent::WindowEvent::DragDrop`. **Important:** if you
  change the listener path again, soft-fail the gate first
  (`eprintln!` warning instead of returning `InvalidPath`) so you can
  diagnose with the terminal before flipping back to hard rejection.

  The drag-drop work also produced UX/path fixes that ride alongside
  SEC-1 (and would otherwise leave the feature unusable):
  - `tauri-drag-drop.ts` and the DOM `drag-drop.ts` now clamp the
    insertion point past every protected range
    (`pushOutOfProtected`-style loop using `protectedRangesField`) so
    drops near the top of the doc never tear `#import` / `#note(...)`
    / `#bibliography(...)` prelude.
  - Markup is now `#image("/assets/foo.png")` for images (leading
    slash → Typst project-root-relative; works in compiler + reading
    view + export) and `#wikilink("foo.pdf")` for non-images.
    `#embed()` was wrong — it's reserved for note transclusion.
  - `copy_path_to_attachments` and `copy_to_attachments` now return
    the **vault-root-relative path** (e.g. `assets/foo.png`) instead
    of the basename. `resolve_embed_path` was extended to handle path-
    style targets directly via `validate_vault_path`, falling back to
    filename search for bare names.

- [x] **SEC-2 — Tighten Tauri asset-protocol scope.** Done 2026-05-10.
  Static config now starts with `allow: []`. The runtime
  `allow_directory(vault_root, true)` call already in
  [commands/vault.rs:42-56](../../src-tauri/src/commands/vault.rs#L42)
  is now load-bearing. Note: scope is additive across vault opens in
  one session — acceptable for our threat model (only ever grants
  legitimately-opened vaults), already documented at the call site.

- [x] **PERF-1 — De-quadratic the link indexer.** Done 2026-05-10.
  Introduced `StemIndex` (lowercase stem → paths). Both
  `resolve_and_build_backlinks` and `resolve_note_links` now build the
  index once per call and resolve via O(1) lookup. Tests passing.

- [x] **LEGACY-1 — Remove `migrate_legacy()` and `_legacy_*` fields.**
  Done 2026-05-10. Removed `_legacy_template_path`, `_legacy_filename_template`
  fields, `migrate_legacy()` method, migration call in `load_rules()`, legacy
  test, and the `template_folder` migration in `settings.rs`.

- [x] **LEGACY-2 — Remove legacy `#import` rewrite logic.**
  Done 2026-05-10. Removed `migrate_vault_imports()`, `walk_typ_files()`, the
  call in `state.rs::open_vault_fast()`, and three migration tests from
  `vault_package.rs`.

- [x] **MAINT-1 — Split `commands/export.rs` (3089 lines).**
  Done 2026-05-10. Split into `commands/export/` directory module with
  7 submodules: `pdf.rs` (814), `helpers.rs` (553), `pandoc.rs` (547),
  `mod.rs` (543 — re-exports + tests), `site.rs` (260), `assets.rs`
  (156), `html.rs` (136), `csv.rs` (96). All 46 tests + external
  verapdf test pass. `lib.rs` updated to use full submodule paths for
  Tauri command registration.

- [x] **PERF-2 / MAINT-2 — Incrementalize `visual-plugin.ts` (2762 lines).**
  Done 2026-05-10. Split into 8 files: visual-plugin.ts (1323, core engine),
  visual-theme.ts (827), visual-protected.ts (268), visual-tables.ts (187),
  visual-colors.ts (116), visual-widgets.ts (92), click-anchor.ts (83),
  visual-links.ts (79). Cursor-only moves now use `rebuildDirtyLines` which
  constrains `buildDecorations` to dirty line ranges via `onlyRanges` param,
  merging results with kept decorations from the existing RangeSet. Factory
  functions break circular deps between extracted modules and `visualField`.

## Code reuse / duplication

- [x] **DUP-1 — Finish migrating `style_injection.rs` into
  `inkycap-vault`'s `apply-vault-defaults`.** Done 2026-05-10. Hybrid
  approach: text/font/monospace/par/heading delegate to `apply-vault-defaults`
  / `apply-collection-style` in lib.typ via `#show: fn.with(...)`. Page
  geometry stays as direct `#set page(...)` — confirmed via end-to-end test
  that `set page` inside a show-rule wrapper is a no-op for document layout.
  File shrinks but stays (still houses string builders, font parser, splicer).
- [x] **DUP-2 — Extract `prepare_bibliography` helper.**
  Done 2026-05-10. Extracted the resolve→inject→visibility bibliography
  chain into `prepare_bibliography()`. Replaced 6 call sites in export.rs.
  Style cascade left inline — too many variants across callers.
- [x] **DUP-3 — Single source for canonical/legacy `#import` matching.**
  Already resolved: all four sites use `crate::vault_package::is_vault_import_line()`.
- [x] **DUP-4 — Wrap `PathBuf::from(&path)` in `sanitize_vault_arg(&path)?`.**
  Done 2026-05-10. Added `sanitize_vault_arg()` to `storage/path.rs` —
  rejects null bytes, `..` traversal, and absolute paths at the command
  boundary. Applied across 30 sites in 10 command modules (files,
  file_ops, typst, collections, properties, composer, bibliography,
  flow, journal_scroll). Skipped: `copy_path_to_attachments` (absolute
  OS paths, SEC-1 allowlist), `show_in_explorer`/`open_file_externally`
  (absolute paths from frontend), export commands (paths from file
  dialogs or internally constructed).
- [x] **DUP-5 — Drop or reuse `renderMarkdownSimple`.**
  Resolved by SEC-3: function was rewritten to DOM construction, eliminating
  the innerHTML concern. No separate action needed.

## Maintainability

- [x] **MAINT-3 — Split `book_wrapper.rs` (1326 lines).**
  Won't fix: cohesive single-responsibility module (merged book assembly).
  Sub-concerns are tightly coupled and don't serve different callers.
  Revisit if a second distinct responsibility is added.
- [x] **MAINT-4 — Split `CollectionTable.tsx` (1743 lines).**
  Won't fix: cohesive single-responsibility component (interactive table).
  Internal concerns (cells, headers, editing) share state heavily and
  would produce a cluster of cross-dependent files worse than one long file.
  PERF-4 (virtualization audit) is independent and still open.
- [x] **MAINT-5 — Introduce a `log` facade.** Done 2026-05-10. Added `log`
  + `env_logger` crates. Converted 40 `eprintln!` calls across 11 files to
  `log::error!`/`warn!`/`info!`/`debug!` with appropriate levels.
  Initialized `env_logger` in `lib.rs::run()` (default filter: `warn`).
- [x] **MAINT-6 — Add `///` doc comments to all `#[tauri::command]`
  exports.** Done 2026-05-10. Added doc comments to 25 commands across
  8 files (bookmarks, collections, export, file_ops, files, properties,
  system_color, vault). All commands now have intent-stating doc comments.

## Unused / legacy code (do before repo reset)

- [x] **LEGACY-1 — Remove `migrate_legacy()` and `_legacy_*` fields.**
  Done 2026-05-10. See Top 5 section.
- [x] **LEGACY-2 — Remove legacy `#import` rewrite logic.**
  Done 2026-05-10. See Top 5 section.
- [x] **LEGACY-3 — Run `cargo machete` and `cargo udeps`.**
  Done 2026-05-10. `unicase` and `uuid` were unused — removed. `bincode`,
  `flate2`, `which` confirmed used (search index, recovery snapshots,
  Pandoc detection).
- [x] **LEGACY-4 — Verify `mermaid` (npm) is reachable.**
  Done 2026-05-10. `mermaid` was initialized with `startOnLoad: false` in
  index.tsx but never called. Removed from package.json and index.tsx.

## Performance

- [~] **PERF-3 — Replace sync `std::fs` calls in async Tauri commands
  with `tokio::fs`.** Partially done 2026-05-10. Fixed
  `commands/markdown.rs` lines 176, 199, 225 (direct
  `std::fs::write`/`create_dir_all` inside `pub async fn`). The
  export.rs sites at 2502/2539 live inside a sync `pub fn`
  (`resolve_template_path_with_root`) called from many places — making
  them async cascades widely. system_color.rs:145 is inside a sync
  `#[tauri::command] fn`, runs on Tauri's worker pool, not the runtime
  — not actually blocking. Low priority remainder; revisit if profiling
  shows runtime stalls during export.
- [~] **PERF-4 — Confirm `CollectionTable.tsx` virtualizes large
  collections.** Audited 2026-05-10. **No virtualization exists.** All
  rows render via `<For each={d().rows}>` with per-cell `InlineCell`
  components (signals + event handlers). Data loads all-at-once via
  `getCollectionData` (no pagination). For 500+ rows × 8 cols =
  4000+ DOM nodes with interactive state each. Remediation: add
  `@tanstack/solid-virtual` or equivalent when collection sizes are
  better understood from real usage. Not blocking v0.1 — early
  collections will be small.
- [x] **PERF-5 — Incremental decoration rebuild on doc change.**
  Done 2026-05-10. Extracted `rebuildRanges()` from `rebuildDirtyLines()`
  as shared merge-and-rebuild logic. Added `rebuildDocChange()` which
  maps existing decorations through `tr.changes`, computes dirty line
  ranges from `iterChangedRanges()` + cursor position, and rebuilds
  only affected ranges (falls back to full rebuild if >50% dirty).
  The `docChanged` path in `visualField.update` now uses incremental
  rebuild instead of full `buildDecorations()`. Tree-identity-only
  changes (deferred parser completion) still trigger full rebuild.

## Security / privacy

(SEC-1 and SEC-2 in Top 5.)

- [x] **SEC-3 — Stop using `innerHTML` for LSP hover content.**
  Done 2026-05-10. Replaced `renderMarkdownSimple` with DOM construction
  using `textContent` for all user-visible strings. Fenced code blocks,
  bold/italic/inline-code all built via `createElement`/`createTextNode`.
- [x] **SEC-4 — Strip control chars from Pandoc `--metadata` values.**
  Done 2026-05-10. Metadata values are now filtered to remove control
  characters (preserving spaces) before passing to `--metadata` args.
- [x] **SEC-5 — Audit static `*.innerHTML = "…"` sites.**
  Done 2026-05-10. All sites confirmed static-only. Added `// static-only`
  comments to SVG icon literals in widgets.ts and table-widget.ts.
  Converted table-widget menu item from innerHTML interpolation to DOM
  construction with `createTextNode` for labels.

## Conventions for this plan

- When closing an item, replace `[ ]` with `[x]` and append a
  one-liner: commit hash, PR link, or rationale (e.g. "won't fix:
  …").
- If a new finding emerges in a later session, append it under
  "Later additions" with date and axis tag, then promote into the
  appropriate section once it's been triaged.
- Severity is implicit in placement (Top 5 = highest impact). Re-rank
  by moving items between sections if priorities change.

## Later additions

### 2026-05-10 — drag-drop UX follow-ups (surfaced by SEC-1 testing)

These came out of in-app testing of SEC-1. None block the security
work, but they're the remaining sharp edges in the attachment-drop
flow. Tackle as a single session — they share context.

- [x] **DD-1 — Path portability across vault moves and portable export.**
  Done 2026-05-10. `export_self_contained_typ` now extracts image paths,
  copies referenced assets alongside the output `.typ` (preserving dir
  structure), and rewrites vault-root-relative paths to output-relative.

- [x] **DD-2 — Visual editor `ImageWidget` honors `alt` / `width` /
  `height` arguments.** Done 2026-05-10. `ImageBlockWidget` constructor
  accepts alt/width/height; extracted via `extractNamedStringArg` (alt)
  and `extractNamedBareArg` (width/height) in visual-plugin.ts.
  `typstLengthToCss()` maps Typst lengths to CSS.

- [x] **DD-3 — File tree refreshes after attachment copy.**
  Done 2026-05-10. `write_to_attachments` now emits `vault:file-created`
  directly via `AppHandle::emit` (the file watcher only tracks .typ/.collection).

- [x] **DD-4 — Clicking an image in the file tree opens externally.**
  Done 2026-05-10. `openFile` detects binary extensions and calls
  `open_file_externally` (new Tauri command using xdg-open/open/cmd).

- [x] **DD-5 — Drag from file tree into editor.**
  Done 2026-05-10. TreeNode items have `draggable` + `onDragStart`
  setting `application/x-inkycap-vault-path` with vault-relative path.
  DOM drag-drop handler checks this MIME type first and calls
  `insertAttachment` directly (no copy — file is already in vault).
  Bypasses SEC-1 allowlist since no filesystem copy is needed.

### 2026-05-10 — bug fixes from drag-drop testing

- [x] **BUG-1 — "Mark decorations may not be empty" crash on app load.**
  Done 2026-05-10. CM6 throws when `Decoration.mark()` gets
  `from === to`. Added `pushMark()` guard in `visual-plugin.ts` that
  skips empty-range marks. Applied to: Strong, Emph, Raw inline, Math
  inline, TermMarker, escaped chars, inline quotes. Also guarded
  `source-raw-highlight.ts`.

- [x] **BUG-2 — Prelude protection: `#note()` paren matching was naive.**
  Done 2026-05-10. Both `computeProtectedRanges` (visual plugin) and
  `findPreludeEnd` (Tauri drag handler) used `line.includes(")")` to
  detect the end of `#note(...)`. Array values like
  `collection: ("Foo",),` contain `)` characters that closed the
  protected range prematurely. Fixed with proper paren-depth tracking.
  Also fixed `protectedChangeFilter` boundary bug: pure insertions at
  `r.from` slipped through because the overlap check used strict
  `toA > r.from`.

- [x] **BUG-3 — Tauri drag position always mapped to top of document.**
  Done 2026-05-10. Tauri's `onDragDropEvent` reports physical-pixel
  coordinates in window space (including GTK header bar), which don't
  map to CM6's `posAtCoords` (viewport/client space). Fix: DOM
  `dragover` events fire during external drags with correct
  `clientX`/`clientY` even on Linux/webkit2gtk (only `dataTransfer`
  is blocked). The CM6 drag-drop plugin now tracks these coordinates
  via `getLastDragPos()`, and the Tauri handler reads them first.

- [x] **BUG-4 — Non-image/non-note drops inserted wikilinks.**
  Done 2026-05-10. Dragging a PDF etc. no longer creates a `#wikilink()`.
  Both drag handlers return `null` for unsupported file types — file is
  copied to `assets/` but no markup is inserted.

### Remaining: non-image/non-note attachment references

- [x] **DD-6 — Markup for non-image attachments (PDF, ZIP, etc.).**
  Done 2026-05-10. Non-image/non-note files dropped into the editor
  now insert `#link("/assets/file.pdf")[file.pdf]` — Typst's native
  link function with vault-root-relative path and filename as display
  text. Updated both `tauri-drag-drop.ts` and `drag-drop.ts`.
  `attachmentMarkup()` return type changed from `string | null` to
  `string` (no longer returns null for unknown types). Per the
  Typst-first principle, `#link()` is the native answer — no custom
  `#attachment()` function needed.
