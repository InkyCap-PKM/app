---
title: "Collaboration (package-handoff) — Implementation Status & Resume Guide"
revised: "2026-05-21"
description: "Authoritative resume doc: what's built, how it works, what's left. Read this first to continue the collaboration project."
---
# Collaboration via Packaging — Status & Resume Guide

**Read this first to resume.** Companion docs: the design plan
[collaboration-via-packaging-2026-05-21.md](collaboration-via-packaging-2026-05-21.md)
(the original vision) and the memory note
`project_collaboration_via_packaging.md` (auto-loaded summary + pointer here).

## What this feature is

An alternative to git: collaborators **exchange zip "packages"** of a
collection (any transport). Each note carries a stable `collabid`
identity; a per-collection sidecar (`versions.json`) holds a **vector
clock** per note. On import, comparing incoming vs local clocks
classifies every note as added / modified / deleted / conflict, presented
in a review the user accepts/rejects before anything touches the working
notebox. Chosen over git because it needs no dependency, no network, and
fits the academic turn-taking workflow. Tradeoffs accepted: no history,
2-way (not 3-way) diffs, detection-not-resolution.

## Status: end-to-end loop WORKS, validated in-app

The user has successfully: enabled collaboration, packaged, imported into
another notebox (incl. creating the collection on import), reviewed,
applied, round-tripped edits, and had attachments travel. All backend
logic is unit-tested; the async command + UI layers are validated by
running the app.

## Build / test / verify

```
cd src-tauri && cargo build --lib                 # backend compiles
cd src-tauri && cargo test --lib collab           # 76 engine + command tests
cd src-tauri && cargo test --lib commands::collab::tests   # reconcile, bump, move-follow, sanitize
cd src-tauri && cargo test --lib storage::local   # 3 atomic-write tests
npx tsc --noEmit                                   # frontend typecheck
npm run tauri dev                                  # run the app (only way to test the async commands/UI)
```
As of 2026-05-21 all of the above are green.

## Architecture map

**Engine (pure logic, fully unit-tested) — `src-tauri/src/collab/`:**
- `clock.rs` — `VectorClock` (transparent BTreeMap), `compare()` partial
  order (Equal/Dominates/DominatedBy/Concurrent), `merge()` cell-wise max,
  `Tombstone`.
- `versions.rs` — `versions.json` schema (`VersionsFile`, `NoteVersion`
  {clock,path,hash,tombstone}, `BibVersions`), load/save, `record_edit`
  (bump+hash), `record_delete` (tombstone).
- `identity.rs` — `seed_handle` (name→filename-safe), `unique_handle`,
  `make_collabid(zid,handle)` / `birth_author(collabid)` (collabid =
  `<zid>-<handle>`, zid hyphens stripped so first-`-` split is
  unambiguous), `LocalIdentity` + `me.json` load/save.
- `review.rs` — `compute_review(local, incoming) -> ReviewResult`
  {note_items, note_auto_merges, bib_conflicts, bib_auto_merges};
  `ChangeKind` = Added/Modified/Deleted/Conflict; full decision matrix
  (incl. tombstone vs edit, hash-equal auto-merge/skip).
- `bibliography.rs` — `merge_bibtex` union-by-key via `biblatex`
  to_biblatex_string; `ConflictChoice`. **Built but NOT wired into apply.**
- `package.rs` — `write_package`/`read_package` (zip: `manifest.json` +
  `versions.json` + `files/<notebox-relpath>`), `read_manifest`,
  `read_packaged_file`, `PackageManifest`, `StagedPackage`. Zip-slip
  guard, optional AES.
- `apply.rs` — `resolve_destination` (filename-collision suffixing —
  CURRENTLY used; see Issue #2, will change).
- `attachments.rs` — `resolve_attachment_relpath(note_relpath, raw)` →
  notebox-relative path (strips leading `/`, resolves relative, rejects
  URL/empty/escape).
- `mod.rs` — `collection_id` (16-hex of fwd-slash relative path),
  `content_hash` (sha256:…), `collab_dir`/`versions_path`.

**Shared infra:**
- `src-tauri/src/storage/zip_archive.rs` — `ZipBuilder` + read helpers
  (`open`/`list_entries`/`read_entry_to_writer`/`read_entry_bytes`),
  optional AES. Backup (`backup/archive.rs`, `backup/restore.rs`)
  refactored onto it. (Also fixed pre-existing broken backup integration
  tests.)
- `NoteboxStorage::write_file` + `write_file_bytes` (binary, atomic) —
  `storage/local.rs` `atomic_write` (tmp + fsync + rename) takes `&[u8]`.

**Commands — `src-tauri/src/commands/collab.rs`** (registered in
`commands/mod.rs` + `lib.rs`):
- `collab_set_identity` / `collab_get_identity` — me.json handle.
- `collab_enable(collection_path, handle)` — requires a filter; calls
  `sync_membership` (stamp collabid + record members), seeds versions.json,
  pins handle, sets `collaboration.enabled` in `.collection`.
- `collab_status` — enabled / handle / live note count.
- `collab_package(collection_path, output_path)` — REQUIRES handle;
  `sync_membership` (pick up new members) → `bump_local_edits` (lazy
  hash-based edit capture) → save → write zip (members + .collection +
  shared .bib + referenced attachments).
- `collab_import(collection_path, package_path)` — into existing
  collection; `stage_and_review`.
- `collab_import_package(package_path)` — into NEW collection: peek
  manifest, create bundled `.collection` if absent, stage + review;
  returns `ImportPackageResult{collection_path,collection_name,created,review}`.
- `collab_pending_review(collection_path)` — recompute staged review
  (resume after reopen).
- `collab_review_apply(collection_path, decisions[])` — accept writes via
  atomic NoteboxStorage + `reindex_note`; tombstone-accept deletes +
  `remove_from_indices`; copies staged attachments missing locally; merges
  clocks; saves versions.

**Key shared helpers in commands/collab.rs:**
- `sync_membership` — filter-eval current members, stamp collabid on new,
  record untracked. Used by enable + package. Does NOT handle membership
  shrink.
- `bump_local_edits` — for each live tracked note whose file hash ≠
  recorded hash, bump clock[handle] + update hash. Lazy edit detection
  (no per-save hook). Used by package + import.
- `reconcile_local` — drop sidecar entries whose file is missing on disk
  (so a locally-deleted note re-offers as Added; keeps tombstones).

**Frontend:**
- `src/lib/types.ts` — `CollectionCollaboration`, `Contributor`,
  `BookExportConfig.contributors`, ChangeKind/ReviewItem/ReviewResult/
  CollabStatus/CollabEnableReport/PackageReport/ApplyReport/DecisionAction/
  ReviewDecision/ImportPackageResult.
- `src/lib/ipc.ts` — wrappers for all 9 collab commands.
- `src/components/CollabPanel.tsx` — the **Collaboration tab** in
  Collection Settings (CollectionTable's CollectionMetadataEditor,
  SettingsTab gained "collab"): handle field (saves on blur), Enable,
  Package…/Import… buttons, inline review list w/ per-item Accept/Reject/
  Skip + bulk Set-all + Apply; resumes pending review on mount.
- `src/components/LeftSidebar.tsx` — global "Import package" (PackageOpen
  icon) in Collections header → `collabImportPackage` → opens collection.
- `src/stores/notebox.ts` — listens `notebox:index-updated` → debounced
  `bumpPropertyVersion` (collection-view refresh; Issue #1 fix).
- `src/styles/layout.css` — `.collab-panel__*`.
- `gitcollection` property repurposed → `collabid` in `property_types.rs`
  + `RightPanel.tsx`.

## Key mechanisms & gotchas (non-obvious)

1. **Edits captured lazily by content hash, NOT a per-save hook.**
   `bump_local_edits` runs at package + import. Packaging REQUIRES a
   pinned handle (errors otherwise) — edits must be attributed.
2. **`collabid` = identity; survives same-second cross-machine ZID
   collisions by construction** (different birth-author handle).
3. **Membership is filter-determined** via `evaluate_filter_group` against
   `property_index`. Collaborative collections currently work with the
   default `collection.contains("<name>")` filter.
4. **Apply must reindex** (`reindex_note`/`remove_from_indices`) — without
   it the collection filter (evaluated against property_index) wouldn't
   see applied notes until restart.
5. **`notebox:index-updated`** fires after backend reindex → frontend
   bumps propertyVersion → collection views refetch (race-free).
6. State is on disk (`.inkycap/collab/<id>/{versions.json, me.json,
   incoming/}`), no AppState fields.

## DONE — Issue #2: storage location decoupled from identity (2026-05-22)

**Goal (achieved):** collaborators organize their own file trees; a note's
location is purely local. Fixed (a) apply replicating the sender's folder
structure and (b) the latent duplicate bug (an edit to a receiver-relocated
note wrote to the sender's path, creating a duplicate).

**Two user decisions settled at start:**
1. **New-note placement → per-collection setting.** `CollectionCollaboration`
   gained an `import_folder` field (notebox-root-relative, local-only, never
   travels in a package). Unset → defaults to `Collaboration/<name>` at apply
   time. Set via the new `collab_set_import_folder` command.
2. **Membership model → the `collection` property is the ONLY source of
   truth.** The user spotted that stamping a property *and* keeping an
   arbitrary filter creates two competing membership truths that drift.
   Resolution: at `collab_enable` we stamp `collection:("<name>")` on every
   current member and **replace** the filter with the canonical
   `collection.contains("<name>")` form (+ the standard `file.name !=
   this.file.name` / `file.ext == "typ"` guards). Membership is then managed
   by toggling the property (existing add-to-collection UX), not by editing
   the filter — which is **locked in the UI** while collaborative.

**What was built:**
- `collab/apply.rs::place_incoming(existing_local_path, incoming_path,
  import_folder, birth_author, is_taken)` — pure placement decision: update
  in place at the receiver's own path when the note exists (located by
  collabid), else land under `import_folder` by filename with birth-author
  suffixing only on collision with a *different* note. Unit-tested (incl. the
  duplicate-bug regression guard).
- `commands/collab.rs`:
  - `collabid_path_map(state, root)` — authoritative `collabid → current
    relpath` map from the live property_index (follows moves).
  - `sync_membership` now takes `collection_name` and stamps BOTH `collabid`
    and the `collection` property (one read+write per note; collection-stamp
    is idempotent at package time since the canonical filter already requires
    it).
  - `collab_enable` canonicalizes the filter (`canonical_membership_filter`)
    after stamping; constructs `CollectionCollaboration` with
    `..Default::default()`.
  - `reconcile_local(local, root, collabid_paths)` — retains a note if
    tombstoned OR collabid-in-index OR file-at-recorded-path exists (the last
    covers the pre-reindex window); refreshes recorded path from the index so
    a *moved* note isn't dropped + re-added.
  - `bump_local_edits(local, root, handle, collabid_paths)` — follows a note
    to its current path before hashing, refreshes the recorded path, then
    detects edits. So an edit to a moved note is captured at the right file.
  - `collab_review_apply` — placement via `place_incoming` + `collabid_path_map`
    for both new/edit (write to receiver's path or import folder) and delete
    (delete the receiver's own copy, not the sender's path). Reads the
    `.collection` for `import_folder`.
  - helpers: `prop_string_list`, `collection_membership_name` (file stem),
    `canonical_membership_filter`, `sanitize_relfolder` (drops `..`/abs/root
    components — trust boundary on the hand-editable `import_folder`),
    `import_folder_for`.
- Frontend: `CollectionCollaboration.import_folder` type; `collabSetImportFolder`
  ipc; CollabPanel import-folder input (saved on blur, placeholder shows the
  `Collaboration/<name>` default) + a membership-explanation hint; the
  collection-table **Filter button is disabled while collaborative** with an
  explanatory tooltip (`isCollaborative()` off `collectionFile().collaboration.enabled`).

**Tests:** `cargo test --lib collab` → 73 green (was 67; +4 `place_incoming`,
+`bump_follows_a_moved_note`, +`reconcile_keeps_indexed…`, +`sanitize_relfolder`).
`tsc --noEmit` clean. (Full `cargo test --lib`: 517 pass, 2 FAIL in
`creation_rules::tests` — PRE-EXISTING + unrelated: default rule folder is
`Daily/{{date:YYYY}}` but the tests assert lowercase `daily`; that file is
untouched by this work.)

Defense-in-depth option not taken: re-canonicalizing the filter at package
time (the UI lock + enable canonicalization keep it canonical today).

## DONE — Membership shrink (2026-05-22)

A note removed from a collaborative collection (its `collection` property
cleared) used to stay tracked in `versions.json` and keep getting packaged.
Fixed: `collab_package` now ships a **member-only view**.

- `sync_membership` returns `member_collabids` (the collabids of current
  filter matches).
- New pure `package_versions_view(local, members)` — retains live entries
  for current members **plus all tombstones**, drops live non-members.
  Unit-tested.
- `collab_package` builds that view and packages only its files; the
  on-disk sidecar still tracks everything, so re-adding a note to the
  collection resumes from its existing history.
- **No receiver-side change needed.** A dropped member is simply absent
  from the package's `versions.json`; `review::classify_note`'s "absence is
  not deletion" rule (`(Some(loc), None) => Skip`) leaves the receiver's
  copy untouched. This is deliberately distinct from *deleting* a note,
  which records a tombstone that **does** propagate (next section).

## DONE — File-delete → tombstone propagation (2026-05-22)

Deleting a note in the app now records a tombstone in every collaborative
collection that tracks it, so the delete travels to collaborators (instead
of the note re-appearing as `Added` on their next import).

- New `tombstone_in_sidecars(root, collabid)` — pure, unit-tested: scans
  every `.inkycap/collab/<id>/` sidecar, and for each that tracks the
  collabid *live*, calls `record_delete` with that collection's own pinned
  `me.json` handle (a note can be in several collaborative collections).
  Sidecars with no pinned identity are skipped (can't attribute the delete).
- `record_note_deletion(state, note_path)` — reads the note's `collabid`
  from the live property index, then delegates to `tombstone_in_sidecars`.
- Hooked into `commands/file_ops.rs` `delete_file` + `delete_folder`,
  **before** `remove_from_indices` (collabid must still be in the index),
  **best-effort** (a collab hiccup never blocks the user's delete; logged).
- Receiver side already handled by Issue #2's apply: the tombstone shows as
  a `Deleted` review item; accepting deletes the receiver's own copy (found
  by collabid) and carries the tombstone forward.

**Design choice — eager hook on the explicit delete commands, not lazy
"file is missing" detection.** A tombstone means "the user deleted this", so
it fires only on a deliberate in-app Delete — no rename/move ambiguity, no
spurious tombstone from a momentarily-unreadable file, and no need for a
tombstone-revive path. **Known limitation:** deletions performed *outside*
the app don't tombstone; those fall back to the pre-existing reconcile
behaviour (the note re-offers as `Added`). Not a regression; revisit only if
external-delete propagation is wanted (would need index-gated lazy
detection in `reconcile_local` with a handle, which `collab_pending_review`
doesn't currently load).

## Other remaining work (deferred, roughly prioritized)

1. **Bibliography merge on apply** — `bibliography::merge_bibtex` exists
   but apply doesn't call it; bib conflicts are shown but kept-local only.
   Wire union-by-key merge into apply + update versions.bibliography.
2. **Zotero → shared `.bib` materialization on enable** — collaborative
   collections should disable Zotero-live and accumulate cited entries
   into the shared `.bib`.
3. **ContributorsEditor.tsx** — Book Metadata multi-author + CRediT roles
   table (the user wanted this independently). Replaces the single
   `author` field. `Contributor` struct + types already exist;
   bibliographic role vocab (CSL/Hayagriva) + 14 CRediT role IDs; mint a
   frozen handle for editing-collaborator rows. Render byline + CRediT
   statement Typst-natively in book export.
4. **`#review` / `#review-reject` Typst primitives + rejection log** —
   reviewer annotations as Typst metadata (`<inkycap-review>` labels);
   reject decision appends to a per-collection rejection log note.
5. **Polish:** command-palette entries (Git:/Collab: actions),
   status-bar badge for pending reviews, a right-panel ReviewPanel
   (review is inline in the collab tab today), conflict resolution UI
   beyond accept-takes-theirs, attachment hash-compare (currently
   skip-if-present so an updated attachment won't re-propagate).

## Repo state

All work is **uncommitted** (single working tree, branch `typst-pivot`).
New files: `src-tauri/src/collab/` (mod, clock, versions, identity, review,
bibliography, package, apply, attachments), `src-tauri/src/commands/collab.rs`,
`src-tauri/src/storage/zip_archive.rs`, `src/components/CollabPanel.tsx`,
the two `.claude/plans/collaboration-*.md`. Modified: backup archive/
restore, collection_parser/model, commands/mod, lib, property_types,
storage local/mod/traits, path_rebase, backup tests, CollectionTable,
LeftSidebar, RightPanel, ipc, types, notebox store, layout.css, and (Issue #2
+ shrink + delete-tombstone, 2026-05-22) `commands/file_ops.rs` (delete hook).
The atomic-write change to `storage/local.rs` predates collaboration (a
standalone improvement). No commits made — commit when the user asks.
