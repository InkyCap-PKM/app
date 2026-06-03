# Audit-fixes — resume handoff

**Branch:** `audit-fixes` (off `main`). **State:** uncommitted working-tree changes (69 files), all gates green. **Do NOT discard the working tree** — those changes *are* the work.

This branch implements the InkyCap code-audit report (perf, correctness, maintainability, security). 17 of 19 report items are DONE + verified. **2 large refactors remain** (this doc's purpose).

## First thing in the new session — confirm the green baseline

```bash
git checkout audit-fixes          # if not already on it; the changes are uncommitted on disk
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests 2>&1 | grep -cE "^warning: [a-z]"   # expect 0
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3                                       # expect all pass (629 lib + integration)
npx tsc --noEmit                                                                                      # expect clean
npm run test 2>&1 | tail -4                                                                           # expect 82 pass
npm run i18n:check 2>&1 | tail -2                                                                     # expect healthy (~1961 keys)
```

The work is NOT committed (per the project's commit-only-when-asked rule). Consider asking the user whether to commit the verified work before starting the two refactors, so it isn't at risk.

---

## DONE (verified) — do not redo

- **P1 — indexing O(N²)→O(changed).** `search/engine.rs`: incremental `remove_doc` via `doc_words` reverse-map + `free_ids` slot reuse (was: scan every posting list per save; `docs` grew unbounded). New `SearchEngine` fields `doc_words`, `free_ids`; `DocEntry` derives `Default` (tombstone). New tests `remove_doc_prunes_empty_postings_and_frees_slot`, `and_not_excludes_without_materializing_complement`. Watcher coalescing: `commands/notebox.rs` dispatcher drains a 200ms window (`dispatch_watcher_batch` + `spawn_batch_reindex`) → one batched reindex; `state.rs` split into `reindex_note_inner`/`remove_from_indices_inner` + `resolve_all_backlinks` + new batched `reindex_notes` (one backlink resolve per batch).
- **find_phrase / Not** in `search/engine.rs`: doc-local position maps; `evaluate_and_not` avoids materializing the notebox-scale complement for `term -term`.
- **P2/P2b — blocking I/O.** `commands/files.rs` `read_media_bytes` (drop root lock + `tokio::fs::read`); `link_infos_for` helper stats off-lock in `spawn_blocking` (get_backlinks/get_forward_links); `commands/file_ops.rs` paste/copy → `tokio::fs::read`; `commands/mycelial.rs` snapshot forward-links before the read loop; `commands/notebox.rs` `seed_notebox_from_source_blocking` + `move_notebox` rename via `spawn_blocking`.
- **P3.** `table-widget.ts` `eq()` now compares `columns`/`rowSizes`/`align` element-wise (`arraysEqual`). `lsp/cm6-lsp.ts` doc-sync is now a per-view `ViewPlugin` w/ `destroy()` (was module-global timer → split-pane bug); completion source pushes current doc directly.
- **P4.** `word-count.ts` (300ms debounce) + `heading-tracker.ts` (gated on outline-pane-open + 150ms debounce, `rescanHeadings` export, rescan effect in `RightPanel.tsx`).
- **P5 — CI.** `.forgejo/workflows/ci.yml` now: rustfmt + clippy `-D warnings` + `cargo test` + frontend (tsc/i18n/vitest). Clippy driven to **0** (mechanical fixes across ~16 files; 2 crate-wide allows in `lib.rs`: `too_many_arguments`, `type_complexity`, with justifying comment).
- **P6.** `pathEquals` wrapping in `LeftSidebar.tsx` (tab↔tree compares) + `ReferencesPanel.tsx`; `scanner/walker.rs` `file.folder` now via `to_frontend_string` (closed the multi-line `.display().to_string()` grep-test gap).
- **Corpus stats persistence.** `corpus_stats/mod.rs` `PersistedCorpusStats::{save_borrowed,load_from_file}` + `indexed_paths`/`contains_doc`; `state.rs` load-then-incrementally-reconcile (mirrors search index) + `corpus_stats_path` + `maybe_save_corpus_stats` + `last_corpus_save`. Was: full O(corpus) rebuild every open.
- **Zotero cache.** `typst_pipeline/zotero.rs` mtime+size cache (`read_entries` wraps `read_entries_uncached`).
- **Compile/query instrumentation.** `compiler.rs` `CompileTimer` on the 4 compile fns; `query.rs` `QueryTimer` (Drop) on `compile_and_query`. `debug` level, file-name only (privacy).
- **Leaks.** `RightPanel.tsx` async-`listen` disposed-guard; `StatusBar.tsx` shared `armDismiss` + `onCleanup`; `MycelialView.tsx` `clearTimeout(hoverTimeout)`.
- **i18n/logs.** `widgets.ts` stragglers → `widget.*` keys (en.json +5); `console.log`→`console.debug` (no paths) in `stores/lsp.ts`, `lsp/client.ts`.
- **Visual-plugin.** Hoisted invariant `syntaxTree(state)` out of the angle-bracket loop; documented the async-parser-settled full-rebuild branch (the doc-change path is already incremental — the audit's premise that newline hits the full rebuild was inaccurate).
- **Security/deps.** `scripts/download-tinymist.sh` pinned SHA-256 per target (real hashes from the v0.14.16 release `sha256.sum`) + fail-closed verify. `package.json` `overrides: { nanoid: ^3.3.8 }` (now 3.3.12, `npm audit` 0 vulns). `tauri.conf.json` + `capabilities/default.json` `$schema` off the nickelpack fork (config → `schema.tauri.app/config/2`, capability → `../gen/schemas/desktop-schema.json`). `Cargo.toml` serde_yaml unmaintained note.
- **Low items.** `collections.rs` precompute sort direction (no per-cmp `to_uppercase` alloc); `style_injection.rs` `sanitize_typst_string` now escapes (not strips); `search/engine.rs` `compile_bounded_regex` (size/dfa caps) on the 4 user-pattern sites; doc comments on `attachment_migration`/`journal_scroll`/`mycelial` commands.

---

## REMAINING — the two big refactors

### 1. SettingsPanel god-file split  (LOW risk, fully verifiable — do this first)

`src/components/SettingsPanel.tsx` is 3308 lines but **already decomposed into per-tab functions** — the split is mostly moving each into its own file:

`LanguageSettingsSection`, `EditorSettingsSection`, `AppearanceSettingsSection`, `FileSettingsSection`, `CitationsSettingsSection`, `ExportSettingsSection`, `BackupSettingsSection`, `BehaviourSettingsSection`, `ExtensionsSettingsSection` (each a top-level `function` in the file).

**Approach:** create `src/components/settings/`. Move each `*SettingsSection` into its own file there; SettingsPanel.tsx becomes a thin tab host (`<Show when={activeTab()===...}>` + imports). Watch for **module-level shared helpers used by several sections** — e.g. the import-mapping helpers near line 44 (`buildMappingTargets`/`loadMappingTargets`/`collectPaths`) and any shared constants — extract those to `settings/shared.ts`. The `resetTabSettings`/`tabHasResettableGroups` helpers (≈144) and the tab list stay with the host.

**Verify:** `npx tsc --noEmit` (catches every missing import), `npm run build`, `npm run test`, `npm run i18n:check`. No GUI validation needed — settings are simple forms and tsc covers the wiring. (`LeftSidebar.tsx` 2414 and `RightPanel.tsx` 2261 are also oversized but lower priority; assess after.)

### 2. File-tree virtualization  (HIGH value — needs IN-APP validation)

Only the **file tree** needs it. **SearchPanel is already paginated** (`PAGE_SIZE = 500`) — do NOT virtualize it.

- Render today: `LeftSidebar.tsx` ~L1476 `<For each={filteredFileTree()}>` → **recursive** `TreeNode` (defined ~L2018, recurses into children ~L2221). On a 3000-note notebox that's 3000+ live DOM rows.
- Existing infra to build on: `flattenVisibleTree()` (~L327) returns `{node, parentPath}[]`; `filteredFileTree()` memo; `visibleFileTree`. Sort/filter are already memoized — the bottleneck is pure DOM volume.

**Approach:** convert to a flat, windowed list. Render only the visible slice of the flattened list; each row = a **non-recursive** `TreeNode` with depth-based indent (descendants are already separate flat rows). This requires refactoring `TreeNode` to stop rendering its own children and instead indent by depth. Suggested dep: **`@solid-primitives/virtual`** (same org as `@solid-primitives/i18n`, already a dependency — narrow, vetted) or `@tanstack/solid-virtual`. Rows are fixed height (`.sidebar-item`).

**Must preserve / validate in-app (`npm run tauri:dev`, on a large notebox):**
- Drag-and-drop between rows **and drag auto-scroll** near edges; the container's drop-to-notebox-root handler (~L1460).
- **Reveal-in-tree** (`revealPath` effect, ~L2093) must `scrollToIndex` the virtualizer, not rely on the row being mounted.
- **Keyboard nav** (F6 region cycle, arrow roving, the `flattenVisibleTree` cursor logic ~L353) must scroll the focused row into view.
- Expand/collapse recomputes the flat list correctly.

**Why a fresh session + you at the keyboard:** tsc/Vitest cannot verify drag-drop/scroll/keyboard. Shipping this blind risks regressing working UX — implement, then smoke-test interactively before declaring done.

---

## After both: final gates + summary
`cargo test` (full) · `npm run build` · `npm run test` · `npx tsc --noEmit` · `npm run i18n:check`, then summarize. The original audit report (full findings) is in this session's history; the per-item status is the DONE list above.
