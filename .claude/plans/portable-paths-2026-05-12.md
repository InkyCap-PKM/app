# Portable paths for attachments, bibliographies, and merged export

**Status:** All four phases implemented 2026-05-12.
**Started:** 2026-05-12

## Why this exists

InkyCap notes routinely contain calls like `image("daisy.png")`, `read("data.csv")`,
`bibliography("refs.bib")`, and `embed("pdf.pdf")`. Today those arguments are
resolved by Typst against the **note's own folder** in single-note compiles,
which is correct and intuitive. But three workflows break that assumption:

1. **Merged collection export** inlines many notes into one synthetic Typst
   document. The synthetic main's location — not each source note's — is the
   anchor for every relative path. Result: notes in subfolders break, notes
   referencing assets adjacent to themselves break.
2. **Moving a note** changes the directory the relative path is anchored
   against. The reference silently breaks.
3. **Changing the configured `attachment_folder`** (e.g. from `"assets"` to
   `"media"`) makes every existing `image("/assets/...")` reference stale,
   and the assets themselves are still in the old folder.

The portable form across all three is a **vault-root-absolute Typst path**:
`image("/assets/daisy.png")`. The leading slash means "project root" which
Typst resolves to the vault root. This form is location-agnostic, survives
sync, survives note moves, and works inside merged export.

The plan is to make this the InkyCap-blessed form everywhere we write a path,
and to migrate existing fragile paths transparently.

## Settled design decisions

- **Canonical form:** vault-root-absolute Typst paths (`/path/from/vault/root`).
- **Path-bearing Typst calls in scope:** `image`, `read`, `embed`, `bibliography`.
  Custom user-authored functions that take a path argument are out of scope —
  we don't know about them.
- **AST tooling:** `typst::syntax` directly. No regex rewriting. Already a
  dependency of the compile pipeline. Per CLAUDE.md's Typst-first principle.
- **`attachment_folder` stays user-global.** No per-vault override. The user
  is expected to be consistent across vaults; if they need a different
  convention per vault they can switch the setting (with the cascade from
  Phase C handling the move).
- **When a relative path can't be rebased (target doesn't exist):** leave the
  call unchanged, log a warning. Don't abort the operation. A missing target
  is a pre-existing user problem, not InkyCap's to escalate.
- **No `attachment()` helper in `inkycap-vault`.** Considered, rejected: it
  would require scaffolding the user's `attachment_folder` setting into the
  vault package at vault-open time, which leaks config into the package.
  Emit plain `image("/assets/daisy.png")` instead. Revisit if a second use
  case ever appears.
- **Bibliography paths get the same treatment as image paths.** Per-note
  `#bibliography(...)` calls are rebased identically. The global
  `settings.citations.bibliography_path` is separate, already absolute, and
  not at risk.

## Phases

### Phase D — Merged-export path rebasing (DONE 2026-05-12)

**Scope:** at the moment a note's content is inlined into the merged-export
synthetic main, walk its AST and rewrite *relative* `image` / `read` /
`embed` / `bibliography` arguments to vault-root-absolute paths anchored at
the note's own folder. Absolute paths stay untouched. The rewrite is
in-memory; source files are not touched.

**Why first:** smallest blast radius, fixes the bug that surfaced when
collections moved into `.inkycap/collections/`, and proves out the
`typst::syntax`-based rewriter that B/C/D all need.

**Implementation summary:**
- New module: `src-tauri/src/typst_pipeline/path_rebase.rs`
  - `rebase_relative_paths(source, note_dir, vault_root) -> String` — AST
    walk that finds path-bearing function calls, rewrites string-literal
    relative arguments to absolute paths anchored at `note_dir` relative
    to `vault_root`. Returns rewritten source.
  - Recognized function names (matched on the call's *callee identifier*):
    `image`, `read`, `embed`, `bibliography`. Case-sensitive, exact match.
  - Handles `#image(...)` and `image(...)` (Typst markup-mode and code-mode
    invocations). Argument must be a string literal; non-literal args
    (variable interpolation, computed strings) are left untouched.
  - Already-absolute paths (leading `/`) are left untouched.
  - Paths that escape the vault (e.g. `../../outside.png` after rebasing)
    are left untouched and logged.
- Wired in `src-tauri/src/commands/export/pdf.rs` at the inlining step:
  before each note's content is pushed onto the merged document, run it
  through `rebase_relative_paths` with the note's directory.
- Synthetic main location still at vault root (already fixed in the prior
  session — kept). Combined with per-note rebasing, this handles both
  notes-at-root and notes-in-subfolders.

**Tests:** unit tests on `path_rebase.rs` covering:
- Relative `image()` in a note at vault root → unchanged effectively (path
  is the same).
- Relative `image()` in `notes/sub/foo.typ` → rewritten with `/notes/sub/`
  prefix.
- Absolute `image("/assets/x.png")` → unchanged.
- Non-literal `image(my_var)` → unchanged.
- Multiple call sites in one document, mixed relative/absolute.
- Both `#image(...)` markup form and `image(...)` code-mode form.
- Bibliography rebase, read rebase, embed rebase.

### Phase A — UI-inserted attachments land in the configured folder (DONE 2026-05-12)

**Implementation summary:**
- Drag-drop and paste-image (`src/editor/typst-decorations/drag-drop.ts`,
  `src/lib/tauri-drag-drop.ts`) already emitted vault-root-absolute paths
  via `attachmentMarkup` — verified, no change needed.
- Command palette "Image" and "Embed" entries now drive the existing
  `pickAndUploadToAttachments()` flow instead of inserting an empty-path
  template. New shared helper: `src/lib/attachment-insert.ts` exposing
  `pickAndInsertAttachments(view, from, to, "image" | "embed")`. Wired
  into both:
  - `src/lib/commands.ts` (global command palette) via
    `insertAttachmentViaPicker`, special-casing ids `image`/`embed`.
  - `src/editor/typst-decorations/command-palette.ts` (slash popup)
    via a new `pickAttachment?: "image" | "embed"` field on
    `PaletteItem`; `acceptItem` short-circuits to the picker.
- Markdown vault import (`src-tauri/src/markdown/vault_import.rs`):
  after `markdown_to_typst()` produces the .typ content, run it through
  `path_rebase::rebase_relative_paths` anchored at the note's own
  relative directory. Markdown `![](images/foo.png)` in a note at
  `notes/foo.md` now imports as `#image("/notes/images/foo.png")` —
  stable across moves and merged export.
- Clipboard-paste markdown (`paste_markdown_as_typst`) intentionally
  left alone: in-memory conversion has no source directory, so any
  relative URLs in the clipboard markdown are hand-typed-equivalent
  and fall under the plan's explicit "out of scope" clause.
- CLAUDE.md gained the principle (under Critical Principles): "Path
  arguments in note source are vault-root-absolute."

**Tests:**
- `vault_import::tests::import_rebases_relative_image_paths_to_vault_root_absolute`
  — end-to-end import covers the rebase invariant.
- Existing `path_rebase` test suite (15 tests) continues to pass and
  doubles as the contract for the shared rewriter.

### Phase A — UI-inserted attachments (original scope, kept for reference)

**Scope:** every code path that writes a file reference into note source
must copy the file into `<vault>/<settings.files.attachment_folder>/` and
emit `image("/<attachment_folder>/<filename>")` (or `embed(...)`, etc.)
with the leading slash.

**Surfaces to audit (search before coding):**
- Drag-and-drop into the visual / source editor.
- Paste-image-from-clipboard.
- The "/" command palette image / file / embed entries.
- The visual editor's image-block widget insert flow.
- Markdown import (`src-tauri/src/markdown/`) — images already in the
  imported tree need to be moved into the attachment folder and references
  rewritten on import.
- Any "insert attachment" or "attach file" Tauri command.

**Choices to make:**
- Filename collision policy: append `-1`, `-2`, ... before the extension.
  Match the convention used for collection name collisions in the prior
  session.
- File size cap on auto-copy: probably none. The user is choosing to
  attach a file; we don't gate.
- Should the source file be moved or copied? Copy. The original may live
  outside the vault and the user expects it to stay there.

**Out of scope:** anything in the editor that lets the user hand-type a
relative path is left alone. We're only standardizing what *we* emit.

### Phase B — Note-move cascade for relative paths (DONE 2026-05-12)

**Implementation summary:**
- New helper `rebase_paths_for_note_move(old_vault_path, storage)` in
  `src-tauri/src/commands/file_ops.rs`. Reads the note's source, runs
  `path_rebase::rebase_relative_paths` anchored at the note's CURRENT
  (pre-move) parent directory, writes back if any rewrite applied. A
  no-op when no relative path arguments exist or all are already
  absolute.
- Called *before* the filesystem rename in:
  - `rename_and_update_links` (file case only, `!is_dir`) — runs
    after `rewrite_backlinks_for_rename`. For same-folder renames
    this is pure canonicalization; for follow-up moves it makes the
    references survive.
  - `move_file` — runs unconditionally, since changing the parent
    folder is the actual breakage scenario this phase fixes.
- `rename_file` (the no-link-updates variant) and folder renames are
  intentionally NOT wired:
  - The no-update variant respects the user's opt-out from automatic
    content modification, and a same-folder rename doesn't break
    relative paths anyway.
  - Folder renames carry assets alongside the notes, so relative
    paths continue to resolve under the renamed folder. Rebasing
    there with the OLD anchor would point at vacated paths.
- No wikilink rewrite on move: wikilinks target notes by stem, and a
  move doesn't change the stem.

**Tests** (in `commands::file_ops::tests`):
- `rebase_paths_for_note_move_rewrites_relative_image` — note at
  `notes/foo.typ` with `#image("daisy.png")` becomes
  `#image("/notes/daisy.png")` after the helper runs.
- `rebase_paths_for_note_move_no_op_when_already_absolute` — note
  whose paths are already absolute is not touched (content
  identical on disk).
- The existing 15-test `path_rebase` suite continues to pass and
  is the contract for the underlying rewriter.

### Phase B — Note-move cascade (original scope, kept for reference)

**Scope:** when the user renames or moves a note, parse the note's source
with `typst::syntax`, find every relative path in `image` / `read` /
`embed` / `bibliography` calls, and rewrite each to a vault-root-absolute
path computed from the note's **old** location. After the rewrite,
subsequent moves are no-ops because the paths are absolute.

**Hooks:** piggyback on the existing wikilink-rename plumbing (gated by
`settings.files.auto_update_links_on_rename`). Same trigger, same dirty-
write path, additional rewrite pass.

**Reuse:** the `path_rebase` module from Phase D is exactly the rewriter
needed here. The difference is when it's called and what file is being
written back: D operates on inlined content in memory, B operates on the
note source on disk before the move completes.

**Edge cases:**
- The relative path's target moves with the note (e.g. note and its asset
  are in the same folder, both being moved together). After rebasing,
  the absolute path still points to the new location because we rewrite
  using the *old* anchor and the asset moves alongside. **Verify with a
  test.**
- Symlinks inside the vault: out of scope, treat like a regular file.

### Phase C — Attachment-folder cascade on settings change (DONE 2026-05-12)

**Implementation summary:**
- AST sibling rewriter in `src-tauri/src/typst_pipeline/path_rebase.rs`:
  - `replace_absolute_prefix(source, old_segment, new_segment)`: rewrites
    path-bearing calls whose string argument starts with
    `/<old_segment>/` so the prefix becomes `/<new_segment>/`.
    Recognized callees are the same four as `rebase_relative_paths`.
    Refuses segments containing `/` (caller bug).
  - `count_absolute_prefix_matches(source, segment)`: cheap read-only
    counter used by the preview command.
- New command module `src-tauri/src/commands/attachment_migration.rs`
  exposes two Tauri commands:
  - `preview_attachment_folder_migration(new_folder)` → counts files
    in the current folder, walks `.typ` notes and counts those whose
    source references `/<current>/...`, reports `target_exists` and
    `target_is_nonempty`. Pure read-only.
  - `migrate_attachment_folder(new_folder)`:
    1. Validates `new_folder` (single segment, no separators).
    2. Pre-flight collision check; non-empty target refuses with
       `InvalidPath`. Empty target dir is removed before the rename.
    3. Atomic `tokio::fs::rename` of the old folder to the new name.
    4. Walks every `.typ` note in the vault, cheap byte-level
       pre-filter (`content.contains("/<old>/")`) before AST parse,
       then `replace_absolute_prefix`, write-back, reindex.
    5. Persists `settings.files.attachment_folder = new_folder`
       *last*, so a mid-flight rewrite failure leaves the setting
       pointing at the (now empty) old name — the user can re-run
       the migration after diagnosing.
- Registered both commands in `src-tauri/src/lib.rs` next to the
  attachment-copy commands.
- Frontend wiring:
  - `previewAttachmentFolderMigration` / `migrateAttachmentFolder` +
    `AttachmentMigrationPreview` / `AttachmentMigrationResult` types
    in `src/lib/ipc.ts`.
  - New `src/components/AttachmentFolderField.tsx` — replaces the
    `SettingPathText` for the attachment-folder field with a row
    that shows the current folder (read-only `<code>`) and a
    "Rename folder…" button. Clicking opens a modal that:
    - Provides a text input for the new folder name.
    - Fires `previewAttachmentFolderMigration` on a 300ms debounce
      as the user types.
    - Renders "<n> file(s) will move, <m> note(s) will be updated"
      live.
    - Disables Apply when the draft is invalid, identical to
      current, or the target is non-empty.
    - On Apply, invokes `migrateAttachmentFolder`, re-syncs the
      frontend settings store via `initSettings()`, and toasts
      success / warnings (errors per note) / errors (top-level
      failure).
  - Wired into `FileSettingsSection` in `SettingsPanel.tsx`.
  - Tiny scoped CSS additions in `src/styles/layout.css` for the
    row layout and preview block — reuses the existing `.app-modal`
    styles otherwise.

**Tests:**
- 10 new `path_rebase` unit tests for `replace_absolute_prefix` and
  `count_absolute_prefix_matches` covering: basic rewrite, nested
  paths, relative-paths-untouched, other-folders-untouched, all
  four path-bearing callees, segment-with-slash refusal, multibyte
  filenames, no-op when segments are equal, and pre-filter counts.
- 26 `path_rebase` tests total now (was 15 pre-Phase C).
- Full `cargo test --lib` passes: 331 tests.

### Phase C — Attachment-folder cascade (original scope, kept for reference)

**Scope:** when `settings.files.attachment_folder` changes from old → new:
1. Pre-flight check: confirm new folder is empty or doesn't exist; abort
   with a clear error on collision.
2. Move every file under `<vault>/<old>/` to `<vault>/<new>/`.
3. Across every note in the vault, rewrite every path-bearing call whose
   argument starts with `/<old>/` to `/<new>/`. Limited to the four
   recognized function names from Phase D.
4. Confirmation modal before running. Show preview counts: "<n> files
   will move, <m> notes will update".

**Transactional behavior:** filesystem moves happen first, then rewrites.
If a rewrite fails mid-vault, log the failed notes loudly; partial moves
are not rolled back (rolling back would be more dangerous than the
half-state). Document this in the confirmation modal: "If something goes
wrong, your assets are in <new> and some notes may still reference <old>".

**Trigger:** settings panel "Files & Links" tab, the `attachment_folder`
input. Confirmation modal intercepts the save.

**Open question for that session:** what to do about user-authored notes
that hand-wrote `image("/old/x.png")` for an unrelated reason (the user
*meant* `/old/`, not the attachment folder). Probably: rewrite anything
matching `/<old>/`, full stop, and document the behavior. The user
who needs a folder literally named after the old attachment folder is
vanishingly rare.

## Cross-cutting

### Reusable rewriter

`path_rebase.rs` from Phase D is the load-bearing module. Phases B and C
both consume it. Keep its API narrow:

```rust
pub fn rebase_relative_paths(
    source: &str,
    note_dir: &Path,         // directory the relative paths are anchored to
    vault_root: &Path,       // for sanity-checking the rebased result
) -> String;
```

For Phase C the API needs a sibling function:
```rust
pub fn replace_absolute_prefix(
    source: &str,
    old_prefix: &str,  // e.g. "/assets/"
    new_prefix: &str,  // e.g. "/media/"
) -> String;
```

Same AST walk, different rewrite rule.

### CLAUDE.md update

After Phase A lands, CLAUDE.md should grow a short principle:

> **Path arguments in note source are vault-root-absolute.** Any code that
> emits an `image`, `read`, `embed`, or `bibliography` call into a note
> writes a path starting with `/`. Relative paths are tolerated for
> hand-authored content but never emitted by InkyCap. Path-bearing calls
> are rebased to absolute on note move and on merged export inlining.

### Risks

- **`typst::syntax` API changes between Typst versions.** Pin behavior
  through tests; the rebase module's tests double as a contract.
- **Performance on huge vaults during Phase C.** Parsing every note's
  AST is non-trivial. If this turns out to be slow, add a fast-path
  byte search for `/<old>/` first and only parse notes that match.
- **The rebaser might miss exotic call forms** like `image.with(...)` or
  paths constructed via concatenation. Document this as a known
  limitation; the rewriter only handles the common form
  `<funcname>(<string-literal>, ...)`.
