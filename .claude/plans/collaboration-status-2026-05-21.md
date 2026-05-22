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
cd src-tauri && cargo test --lib                  # full lib: 533 pass, 0 fail
cd src-tauri && cargo test --lib collab           # 77 engine + command tests
cd src-tauri && cargo test --test contributors_book   # 3 real-Typst book-compile tests
cd src-tauri && cargo test --lib typst_pipeline::contributors   # 8 byline/CRediT tests
npx tsc --noEmit                                   # frontend typecheck (clean)
npm run tauri dev                                  # run the app (only way to test the async commands/UI)
```
As of 2026-05-22 all of the above are green — including the two
`creation_rules` daily-note tests (the long-standing `daily` vs `Daily`
assertion mismatch is fixed).

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

## DONE — Bibliography merge on apply (2026-05-22)

`merge_bibtex` (union-by-key via `biblatex`) existed but was never wired in,
and — the real gap — **`versions.bibliography` was never populated**, so the
review couldn't even detect bib changes. Now end-to-end:

- New `bibliography::refresh_bib_versions(&mut BibVersions, bibtex, handle)`
  — pure, unit-tested: rebuilds the sidecar's bib index from the `.bib`'s
  current entries (refresh hashes, attribute new keys to `handle`, preserve
  `added_by` for persisting keys, drop removed keys). Malformed `.bib` ⇒
  no-op (don't discard tracking).
- `collab_enable` and `collab_package` call it (from
  `collaboration.bibliography_file` ∥ `bibliography_file`), so the index is
  populated at enable and refreshed before each package — making bib
  additions/conflicts detectable on the receiver.
- `collab_review_apply` now union-merges the staged incoming `.bib` into the
  local one (`merge_bibtex` with empty `choices` ⇒ additions taken,
  same-key/divergent-content conflicts **kept local** — no per-key UI yet),
  writes the merged `.bib`, rebuilds `local.bibliography` from the merged
  hashes (preserving `added_by`: local → incoming → "peer"), and reports
  `bib_added`. If the receiver's collection had no bib, it **adopts** the
  sender's relpath and persists `bibliography_file` into the `.collection`.
- `ApplyReport.bib_added` (Rust + TS) surfaced in the apply toast.

### Per-key bibliography conflict UI (2026-05-22)

Divergent same-key bib entries are now resolvable per key instead of always
kept-local:

- `collab_review_apply` gained a `bib_decisions: Vec<BibDecision { key,
  take_incoming }>` parameter, mapped to a `HashMap<String, ConflictChoice>`
  and threaded into `merge_bibtex` (keys absent ⇒ keep local).
- Frontend: `BibDecision` type; `collabReviewApply` takes an optional
  `bibDecisions` (defaults `[]`); CollabPanel renders each `bib_conflicts`
  key as a row with a **Keep mine / Take theirs** select (defaulting to keep
  mine) and sends the choices on Apply.
- Apply is now enabled whenever the review has *any* content (note items,
  bib conflicts, or bib additions) — previously it required note items, so a
  bib-only package couldn't be applied. The "Incoming changes — N" header is
  hidden when there are no note items, and resume/import "nothing to review"
  uses one shared `reviewHasContent` check.

**Bibliography is now feature-complete for the package loop** except
Zotero→shared-bib materialization (next).

## DONE — ContributorsEditor + multi-author byline + CRediT (2026-05-22)

Replaced the single `author` field in Book Metadata with a contributors
table (the long-wanted byline feature; also the collab roster).

- **`typst_pipeline/contributors.rs`** (new) — owns the role vocabularies
  (14 NISO CRediT roles by canonical URL; CSL/Hayagriva biblio roles),
  `credit_label` resolution, `document_author_names` (PDF/docx author
  derived from the roster's bibliographic authors, falling back to all
  contributors then the legacy `author`), and the Rust→Typst call builders
  `byline_call` / `credit_statement_call`. `typst_array` gives single-element
  arrays a trailing comma (the `("x")`-is-a-string gotcha). Unit-tested (8).
- **`lib.typ`** — `#contributors-byline(roster)` (groups by role: authors →
  "by …", others → "Edited by …" etc. via `_byline-prefix`) and
  `#credit-statement(roster)`. Typst-first: Rust emits data + one call.
- **`book_wrapper.rs`** — `BookExportOptions` gained `contributors` +
  `include_credit_statement`; `#set document(author:)` is derived from the
  roster; the title page renders the byline (falling back to the legacy
  author line) and, when enabled + roles present, a CRediT statement on its
  own page.
- **Commands:** `contributor_catalogs()` (frontend dropdowns share the
  backend vocab — one source of truth) and `collab_seed_handle(name, taken)`
  (mints a frozen handle for editing-collaborator rows, reusing
  `identity::seed_handle`/`unique_handle`).
- **Frontend:** `ContributorsEditor.tsx` (name, biblio-role select, CRediT
  multi-select disclosure, collaborator checkbox + handle), wired into
  `CollectionBookEditor` replacing the Author field; `include_credit_statement`
  toggle; `contributors-editor__*` CSS.
- **Author handling (per user):** no separate Author input — the document
  author flows from the roster. The stored `author` field is preserved as a
  fallback only.
- **UI polish (2026-05-22, after user feedback):** the editor is backed by a
  `createStore` array with per-cell `setRows(i, key, val)` updates — a `<For>`
  over a freshly-mapped array recreated every input each keystroke and stole
  focus (the reported "cursor leaves the field" bug). The biblio-role picker
  uses the app `<Dropdown>` (native `<select>` ignores the theme under
  WebKitGTK); a single app-wide `accent-color: var(--accent)` rule on
  `.app-shell input[type=checkbox|radio]` tints all native checkboxes teal
  instead of the desktop's orange; row controls share one metric (default
  Dropdown + inputs + buttons all at `4px 8px` / `--text-md`).
- **Wire-shape gotcha (fixed):** `Contributor.credit_roles` is
  `skip_serializing_if = "Vec::is_empty"`, so an empty roster row arrives at
  the frontend with `credit_roles` **omitted** (`undefined`, not `[]`) — the
  editor's `[...c.credit_roles]` crashed the whole Book Metadata tab
  ("Spread syntax requires …iterable"). The editor now normalizes on init
  (coerce to `[]`); the TS type stays optimistic but the boundary is safe.
- **Tests:** `tests/contributors_book.rs` (new) compiles real merged books
  through Typst (catches `lib.typ` syntax errors; no external tooling, always
  runs): a mixed-role roster + CRediT, and a single-chapter spaced/paren-stem
  book (the regression below). The veraPDF test's `BookExportOptions` literal
  was updated for the new fields.

## DONE — Two pre-existing book-export bugs (2026-05-22)

Both surfaced while testing the contributors byline (book export is how you
see it) and blocked any real export; both are the single-element-array Typst
gotcha, fixed in `build_book_source` / `lib.typ`:

1. **"unclosed label" cascade on real note names.** Chapter anchors were
   emitted as `<chap-{stem}>` *markup-label* syntax. Note stems routinely
   contain spaces/parens ("Information Technology and Libraries (ITAL)"),
   illegal in literal labels → the whole merged compile derailed. Fix: a new
   `chapter-anchor(stem)` in `lib.typ` builds the anchor with the `label()`
   *function* (`_make-label`), which accepts any string — matching what the
   merged-mode `wikilink` already links to (`_make-label("chap-" + name)`).
   `book_wrapper` now emits `#chapter-anchor("<stem>")` + a separate heading.
2. **Single-chapter crash.** `chapters: ("alpha")` parsed as a string;
   `set-merged-context` asserts an array. Fix: trailing comma for the
   one-element case.

## DONE — Book export names the failing note (2a, 2026-05-22)

Book export used to fail with a bare, position-less Typst message
("expected expression; …") that gave no hint which of N notes was at fault.
Now it names them:

- `compiler.compile_pdf_diagnostics(...)` — a sibling of `compile_pdf` that
  returns the structured `Vec<TypstDiagnostic>` (with source offsets) on
  failure instead of a flattened string. `compile_pdf` is untouched, so
  every other caller's `CompileError` contract is unchanged.
- `book_wrapper::chapter_at_offset(source, offset)` maps a byte offset to the
  containing note by scanning the `#chapter-anchor("<stem>")` markers (now
  emitted via the shared `chapter_anchor_call` helper);
  `describe_book_diagnostics(source, diags)` groups errors by note,
  de-dupes, and yields e.g. *"compilation failed. In "Journal of Academic
  Librarianship": expected expression. In "Information Technology and
  Libraries (ITAL)": unclosed delimiter."* The book export command
  (`commands/export/pdf.rs`) clones the final source for offset-mapping and
  builds this message on failure. Unit-tested (chapter mapping + grouping).

Note: this reports note-content errors better; it does **not** make book
export error-*tolerant* (option 2b — render around a broken note via
`recovery`) — deferred unless wanted.

**Companion data fix (not code):** two notes in the user's `Inky2/Publishers`
notebox had a markdown `# Heading` jammed mid-paragraph (invalid Typst);
repaired in place. The same corruption exists in the `InkyCap-Professional`
copies (not the active notebox — left untouched).

## Other remaining work (deferred, roughly prioritized)

1. **Zotero → shared `.bib` materialization on enable** — collaborative
   collections should disable Zotero-live and accumulate cited entries
   into the shared `.bib`.
2. **`#review` / `#review-reject` Typst primitives + rejection log** —
   reviewer annotations as Typst metadata (`<inkycap-review>` labels);
   reject decision appends to a per-collection rejection log note.
3. **Polish:** command-palette entries (Git:/Collab: actions),
   status-bar badge for pending reviews, a right-panel ReviewPanel
   (review is inline in the collab tab today), conflict resolution UI
   beyond accept-takes-theirs.
   - *Attachment hash-compare — DONE 2026-05-22:* `collab_review_apply`
     byte-compares each incoming attachment against the local copy and writes
     when missing **or changed** (was skip-if-present, so updated attachments
     never propagated). Take-incoming on divergence (binary, no clock; no
     per-attachment review yet).
4. **Book export error-tolerance (option 2b)** — render *around* a broken
   note via the `recovery` module (single-note preview already does) so one
   bad note doesn't fail the whole book. Today export names *which* note
   failed (2a) but still aborts.

## Repo state (as of end of 2026-05-22 session)

Branch `typst-pivot`, single working tree. **Everything below is COMMITTED**
as of this session's end:
- Issue #2 (location decoupling), membership shrink, file-delete→tombstone.
- Bibliography merge on apply + per-key conflict UI.
- ContributorsEditor (multi-author byline + CRediT) + `lib.typ`
  `contributors-byline`/`credit-statement` + `typst_pipeline/contributors.rs`.
- Book-export fixes: chapter-anchor (unclosed-label), single-chapter array,
  "name the failing note" (2a).
- Attachment hash-compare.

**Uncommitted at handoff:** ONLY the `creation_rules` daily-note test fix
(`src-tauri/src/creation_rules/mod.rs` — `daily` → `Daily` in two assertions).
Commit it; the full lib suite is then 533 pass / 0 fail.

**Not an app change (user's data):** two notes in `Inky2/Publishers`
(`Journal of Academic Librarianship.typ`, `Information Technology and
Libraries (ITAL).typ`) were repaired in place (markdown `# Heading` jammed
mid-paragraph). The same corruption still exists in the
`InkyCap-Professional` notebox copies — left untouched.

## ⮕ NEXT SESSION — start here

The collaboration core + ContributorsEditor + bibliography (merge/conflict)
+ book-export fixes are all done and committed. Pick the next item from
"Other remaining work" above. **User was asked to choose between** (see that
list for detail):
1. **Book export error-tolerance (2b)** — recommended if continuing to test
   book export; builds on the 2a "name the note" reporting.
2. **Zotero → shared `.bib` materialization** — completes the bibliography
   arc; larger, and note the bib source is *notebox-wide* not per-collection,
   so "switch the collection off Zotero-live" doesn't map cleanly — design
   it as: at enable, materialize the collection's *cited* entries into a
   collection-owned `.bib` and point `collaboration.bibliography_file` at it
   (re-sync lazily at package, like `bump_local_edits`). The user's current
   journal notes may not use `@citations`, so it won't be immediately
   demonstrable for them.
3. **`#review` / `#review-reject` Typst primitives + rejection log.**
4. **Collab UX polish** (command palette, status-bar badge, right-panel
   ReviewPanel).

The user had not yet chosen when the session ended (they opted to start
fresh). Re-confirm their pick at the start of the next session.
