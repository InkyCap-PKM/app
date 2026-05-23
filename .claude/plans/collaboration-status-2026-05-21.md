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

## DONE — `#review` / `#review-reject` primitives + rejection log (2026-05-22)

Reviewer annotations are now Typst-native, and a Reject decision records a
durable, human-readable audit trail. Typst-first throughout (rendering in
`lib.typ`; Rust emits data + one call).

- **`lib.typ`** — two new exported functions in `inkycap-notebox/0.2.0/lib.typ`:
  - `#review(body, by: none, on: none)` — content-bracket reviewer comment;
    emits `<inkycap-review>` (dict `by`, `on`), renders a violet annotation
    block (callout-shaped). `on` normalized via `_fmt-date`.
  - `#review-reject(target, reason, by: none, on: none)` — emits
    `<inkycap-review-reject>` (dict `target`, `reason`, `by`, `on`), renders a
    red dated log entry. The header doc-comment now lists **six** query labels.
- **`typst_pipeline/review.rs`** (new) — `review_reject_call(...)` (single-call
  builder, reuses `book_wrapper::typst_escape`), `rejection_log_title(name)`,
  and `append_to_rejection_log(existing, entry, name)` (creates the note with
  a `#note(title:)` header + `= Rejected changes` on first use — deliberately
  **no** `collection` property so the log never packages back; appends newest
  last otherwise). `#review` is authored entirely frontend-side, so no Rust
  builder for it. 6 unit tests.
- **`commands/collab.rs`** — `ReviewDecision` gained `reason: Option<String>`
  (`#[serde(default)]`). `collab_review_apply`'s Reject branch collects
  `(target, reason)` (target = note filename stem, receiver's copy preferred);
  after the loop, when any rejections exist, it loads the `me.json` handle +
  today's date, reads/creates `<import_folder>/<name> — Rejected Changes.typ`,
  appends one `#review-reject(...)` per reject (single read/append/write), and
  `reindex_note`s it so it appears without a restart. Best-effort placement in
  the import folder (same path the accept branch uses, so parent dirs are
  created). Fully-qualified `crate::typst_pipeline::review::` calls to avoid
  collision with the imported `collab::review` engine module.
- **Frontend** — `ReviewDecision.reason?` (types.ts; ipc passes it through
  unchanged); `CollabPanel` reveals a per-item rationale input when a row is
  set to Reject and sends it on Apply (`.collab-panel__reject-reason` CSS).
  `#review` authoring: a "Review comment" `/`-palette entry (`#review[…]`,
  `expandOnInsert`) + a `ReviewBlockWidget` (visual editor) mirroring
  `CalloutBlockWidget` — registered everywhere `callout` is (the pill-above-
  element branch + `case "review"` in visual-plugin.ts, `ALWAYS_EXPAND_PILLS`,
  `BLOCK_FUNC_NAMES` in block-layer.ts, `REVIEW_COLOR` mirroring lib.typ's
  `_review-color`). Default-case pill would have worked but goes blank when the
  cursor leaves; the block widget keeps the comment visually distinct, matching
  the reading view.
- **Tests:** `tests/review_primitives.rs` (new, real-Typst, always runs) — both
  primitives compile to PDF + a `compile_and_query` round-trip. Full lib suite
  **539 pass / 0 fail** (was 533, +6 review.rs); `tsc` clean; full backend build
  clean. **Not yet validated in-app** (the reject→log write + reveal UI need a
  running app like every other collab async command/UI).

**Deferred (clean follow-up, no consumer yet):** scanner indexing of
`<inkycap-review>` into `QueryResult` + a Reviews aggregation panel.

### Review-diff workflow — right-panel Review tab (2026-05-22, after user feedback)

The inline review list showed only the change *kind* + path — no way to see
*what* changed. Added a proper in-context diff workflow (user-directed: not
inline, a right-panel tab; no stopgaps).

- **Backend** `collab_review_detail(collection_path, collabid) -> ReviewDetail
  { collabid, local_path, local_content, incoming_content }` — read-only; reads
  the staged incoming file + the receiver's local copy (located by
  `collabid_path_map`, so moves are followed). `local_path` is an absolute
  frontend string so the caller can open it as a tab. Registered in lib.rs.
- **Shared store** `src/stores/collab.ts` (new) — hoists the review session
  (`review`, `decisions`, `reasons`, `bibChoices`) out of CollabPanel plus
  `activeReview` (which collection) and `currentReviewCollabid` (the note in
  the diff; **also gates the Review tab's visibility**). `loadReview` /
  `clearReview` / `setDecision` / `setReason` / `setBibChoice` /
  `setAllDecisions` / `stepReview`. CollabPanel now reads/writes this; Apply
  still lives only in CollabPanel.
- **Right-panel Review tab** — `"review"` added to `RightPanelTab` (layout.ts,
  + `setRightCollapsed`). New `src/components/ReviewPanel.tsx`: a **read-only
  `@codemirror/merge` `unifiedMergeView`** (chosen over two-pane — the panel is
  narrow) reusing the editor's Typst highlighting via the new
  `readOnlyTypstExtensions()` export in typst-editor.ts; original = local
  (mine), doc = incoming (theirs). Decision buttons (Accept/Reject/Skip) +
  reject reason + Prev/Next nav, all writing to the store. On detail load it
  opens the local note in a tab for context (Added notes have none → diff shows
  full incoming, labelled "New note"). The Review **tab is contextual**: a
  `message-square-check` button shown only while `currentReviewCollabid != null`
  (a session is active), auto-focused/reverted by an effect mirroring
  `scroll-context` — never shown for ordinary notes. Lives outside the
  file-tab `<Show>` so it works for Added notes; the file-tab/mycelial content
  blocks yield when `activePanel === "review"`.
- **CollabPanel** — each review row gained a **Review** button
  (`message-square-check`) → `openReview(collabid)` (sets the session pointer +
  un-collapses the panel); the active row is highlighted.
- **Dependency:** `@codemirror/merge` ^6.12.1 (official `@codemirror/*`,
  read-only display only — the apply path still copies staged bytes verbatim,
  so Typst markup is untouched). `npm install` pruned 310 *extraneous*
  node_modules entries (lockfile only grew by the one package — nothing real
  removed).
- **Verification:** tsc clean, `cargo build` (full), 539 lib + 77 collab + 2
  review_primitives tests green, `npm run build` (vite bundle) succeeds.

#### Refinements after first in-app test (2026-05-22)
User feedback drove four fixes (all frontend):
1. **Decision buttons felt inert / reject had no submit.** Apply was stranded
   in Collaboration settings. Moved apply into a shared store action
   `applyReview()` (builds decisions+bib lists, ipc, toast, `bumpPropertyVersion`,
   `clearReview`) used by BOTH CollabPanel and a new **"Apply all decisions"**
   button in ReviewPanel — so the review is drivable entirely from the panel.
   Accept/Skip now **auto-advance** to the next note (Reject stays so the reason
   can be typed; reason saves live with an "applied when you apply" hint).
2. **"Reviewing" status badge** (`message-square-check` + "Reviewing", accent
   colour) in the editor header centre when the open note is the one under
   review — driven by a new `currentReviewPath` store signal set by
   ReviewPanel; compared with `pathEquals`. Mirrors the scroll-status pattern.
3. **Review button clobbered the active (collection) tab** — `openTab`
   navigates in-place without `forceNewTab`. Added `forceNewTab: true` (the
   existing-path check still runs first, so revisits/steps reuse a tab rather
   than duplicate); the collection view is preserved.
4. **Closing the collection tab stranded the review** — fixed structurally by
   #1 (Apply now lives in the panel; the session is a global store
   independent of any tab/CollabPanel mount) + #3 (collection tab preserved).
   The right-panel review content already renders independent of the file tab.

tsc clean, `npm run build` succeeds. **Re-test #4 in-app to confirm.**

#### Reworked to whole-file immediate-apply review (2026-05-22, after 2nd in-app test)
User considered per-change (hunk) merge but **decided against it** (too complex
— "could've used git"); settled on **whole-file** review with an **immediate**
per-note apply and a persistent review-mode display. Net changes:

- **Backend (`collab_review_apply`):** Reject now **resolves** — it folds the
  incoming clock into the local entry (creating a content-less entry for a
  declined Added note) and keeps local content, so a rejected note no longer
  re-offers. Applies to both the per-note and batch paths. (`NoteVersion` /
  `VectorClock` imported.)
- **Store (`stores/collab.ts`):** added `reviewItemsById` (full set, survives
  apply), `reviewModeByPath` (normalized local path → collabid; the per-note
  review-mode set), `mergedCollabids`, `applyNote(collabid, action)` (immediate
  single-note apply via `collabReviewApply` with a one-item list; drops the
  note from the pending list but keeps it in review-mode display, marked
  Merged), `enterReviewMode`/`reviewModeCollabidForPath`/`isMerged`/
  `endReviewModeFor`. `applyReview` (batch) + `setAllDecisions` kept for the
  Collaboration-settings path. `stepReview` removed.
- **ReviewPanel:** removed Skip, Prev/Next, and the in-panel Apply-all.
  Accept/Reject apply **immediately** (whole file); after a decision the note
  stays in review display ("Merged — keep editing…"), the diff stays frozen
  (fetched once), and an optional reject-reason textarea feeds the rejection
  log. **"End Review Mode"** (neutral, full-width) closes the note tab and
  reopens the collection. Header reads **"Changes proposed by …"**. On accept
  it fires `inkycap:note-property-changed` for the note path so the open editor
  reloads to the merged content.
- **RightPanel:** an active-tab-follow effect sets `currentReviewCollabid` from
  the active note's review-mode membership (reopening a note re-enters review
  mode; ordinary notes show no Review tab; an Added-note review with no tab is
  kept until ended).
- **Editor header:** the centred badge reads **"Reviewing"**, flips to
  **"Merged"** (green) with a brief pulse once the decision is applied, keyed
  off `reviewModeCollabidForPath(path)` + `isMerged`.
- **Tab strip (`MainContent`):** a `message-square-check` icon marks file tabs
  whose note is in review mode.
- **CollabPanel:** "Package…" → **"Package export…"**; Set-all buttons dropped
  "all" (now Accept/Reject/Skip under the "Set all:" label); per-row Review +
  decision grouped in `.collab-panel__review-controls` (right-aligned).
- **CSS:** single primary action — Accept is the only green button, with a
  hover that keeps light text (the base toolbar-btn hover set a dark colour →
  unreadable on the green fill); Reject/End Review Mode are neutral outline;
  added the Merged pulse + merged-note box.

Verified: tsc clean, `cargo build` (full), 77 collab tests green,
`npm run build` (vite) succeeds. **All UI/async — needs in-app validation**
(esp. the editor reload-on-accept and the reopen→review-mode persistence).

## DONE — Collaboration surfaced in the right panel + tri-state lifecycle (2026-05-23)

Per user feedback that collaboration was "too buried" inside Collection
Settings, it was moved out and given a clearer lifecycle. **Uncommitted at
this handoff** (compiles; `tsc`/`npm run build` clean; full lib 539 + collab
77 tests green; partially validated in-app by the user).

- **Moved out of Collection Settings → right-panel surface for Collection
  Views.** New `src/components/CollaborationSection.tsx` renders in
  `RightPanel` whenever a `collection` tab is active (gated to not collide
  with the Review tab, which shows on the reviewed note's *file* tab):
  handshake icon + "Collaboration" heading, the question "Enable collaboration
  for this collection?", and the lifecycle pill. The old `"collab"` tab in
  `CollectionMetadataEditor` (CollectionTable) is **removed**.
- **Three-way Disable / Pause / Enable pill** (replaces the on/off enable
  button + disabled-fallback). Default **Disable**.
  - Backend: `collab_enable` **replaced** by `collab_set_state(collection_path,
    target: CollabState, handle: Option<String>)` (`CollabState` =
    `disabled|paused|enabled`, snake_case serde). `collab_status` gained a
    `state` field. Registered in `lib.rs` (replacing `collab_enable`).
  - **Disabled** = no sidecar (pristine; the default). **Paused** = sidecar on
    disk but `enabled=false` (history kept, filter unlocked, lossless resume).
    **Enabled** = active. Paused-vs-Disabled is told apart by sidecar presence
    (both have `enabled=false`).
  - Refactor: `setup_collaboration(state, path, handle, target_enabled, fresh)`
    — `fresh` seeds a new `VersionsFile`, else loads the existing one (resume)
    and folds in edits made while paused via `bump_local_edits`; preserves
    `import_folder`. `resolve_handle(root, id, provided)` = provided ∥ pinned
    `me.json` ∥ error. Disable target tears down the sidecar dir
    (`remove_dir_all`) and clears the flag — note `collabid`/`collection`
    stamps are left on notes, so re-enable reuses identities.
  - Frontend handle resolution (CollaborationSection): pinned → global setting
    → `promptText` dialog (seeded from global author name). Disable shows a
    destructive `ask()` confirm. After any transition, `bumpPropertyVersion()`
    so CollectionTable's `collectionFile` resource (now keyed on
    `propertyVersion()`) refetches and the filter-lock (`isCollaborative`)
    stays in sync.
- **`CollabPanel` slimmed to the enabled-body** (import folder, handle
  override, package/import, review list). Now takes `status` + `collectionFile`
  + `onChanged` props from CollaborationSection (no more own enable button /
  disabled fallback / `onSaved`).
- **Global identity in Settings › Overview › Collaboration** — new
  `CollaborationSettings { author_name, handle }` on the user-global
  `UserSettings` (Rust `settings.rs` + TS `types.ts`/`settings.ts` DEFAULTS).
  Optional; handle pre-fills enabling (overridable per collection), author name
  pre-fills the **first** Book Metadata contributor and is reused as the handle
  when "you" (name matches) become a collaborator (`ContributorsEditor`).
- **Two Reviewing-mode tweaks (from a screenshot):** (a) reject-reason field
  moved **below** Accept/Reject (above End Review Mode) in `ReviewPanel`;
  (b) the Mycelial (BrainCircuit) + Journal-Scroll pill buttons are **hidden**
  in the editor header while a note is in review mode (`TypstEditor`, gated on
  `reviewModeCollabidForPath(props.path)`).
- **CSS:** `.collab-section*` + `.collab-state-pill*` (segmented control
  mirroring `.editor-header__mode-toggle`, active segment accent-filled) in
  `layout.css`.
- Files touched: `src-tauri/src/{settings.rs, lib.rs, commands/collab.rs}`;
  `src/lib/{types.ts, ipc.ts}`, `src/stores/settings.ts`,
  `src/components/{CollaborationSection.tsx (new), CollabPanel.tsx, RightPanel.tsx,
  CollectionTable.tsx, SettingsPanel.tsx, ReviewPanel.tsx, TypstEditor.tsx,
  ContributorsEditor.tsx}`, `src/styles/layout.css`.

**Validate the rest in-app, then commit** (alongside the still-uncommitted
`#review` primitives + review-diff workflow from the prior session, and the
earlier CollabPanel hint-wording tweaks).

## OPEN QUESTION — collaboration direction (package vs git vs CRDT) (2026-05-23)

The user has a "shadow of doubt" about the real-world utility of the
package-handoff model and is **actively reconsidering direction** (no decision
yet). Analysis done this session, for whoever resumes:

- **The review/apply/membership/UI/Typst-primitives layer is transport-agnostic
  and is the durable asset.** The vector-clock-over-zip half (`clock.rs`,
  `versions.rs`, `package.rs`, the clock-based decision matrix in `review.rs`)
  is one transport.
- **Git plan** (`.claude/plans/hi-i-would-like-declarative-otter.md`) = a
  *transport* swap behind the same review UI: ~50% reuse (review panel,
  `@codemirror/merge` diff, `ReviewResult`/`ChangeKind`, `#review`/
  `#review-reject` (DONE, plan lists as TODO), bib merge, ContributorsEditor,
  atomic writes, `collection_id` hashing). **Crucially, the Issue-#2
  property-based membership decision dissolves the plan's hardest part** — the
  §2.3 "syndication home" rule, the `gitcollection` property (already
  repurposed to `collabid`), the §2.6 filter-drift delete footgun. New cost is
  dominated by `git2`+`keyring`, auth (SSH/PAT), the mirror-worktree, and the
  §2.8 external-sync-coexistence tar pit.
- **Automerge / CRDT** = a *philosophy* swap, poor fit: inverts the source of
  truth (CRDT becomes canonical, `.typ` becomes a projection — breaks "Typst is
  the source of truth" + plain-files-on-disk + external-tool interop), and
  auto-merge is the **opposite** of the review-before-apply model the user
  values (would force fighting the library to reintroduce a review gate).
  Least reuse of the three. Best for real-time apps that own their doc model;
  user's workflow is academic turn-taking, where its benefit is lowest and its
  cost is paid in full.
- **DiffMate** (the other candidate) = a Next.js *viewer* web app, no license,
  no per-change approval — not incorporable. The per-hunk approval idea it
  prompted is reachable by flipping `@codemirror/merge`'s `mergeControls: true`
  in `ReviewPanel` (currently `false`) + a hunk-aware apply path — but the user
  previously evaluated per-hunk and **chose whole-file** ("too complex").
- Recommendation given: don't rip out the working package version; if git is
  chosen, do it as a *second transport* (the de-risked plan). The user is
  giving it more thought; their judgement is experience-based (Word / Google
  Docs), so a literal dry-run isn't decisive for them.

## DONE — Idea 1: commentary on ANY decision + generalized review log (2026-05-23)

The rejection-only log is now a general **review log** capturing accept-with-
comment, reject-with-rationale, and bare comments alike. **Uncommitted at this
handoff** (compiles; `tsc`/`npm run build` clean; full lib **540** + collab 77 +
review_primitives 2 tests green). Needs in-app validation, then commit.

- **Typst (`inkycap-notebox/0.2.0/lib.typ`):** `#review-reject(target, reason,…)`
  **replaced** by `#review-decision(target, action, note: "", by:, on:)` —
  `action` ∈ `"accepted"|"rejected"|"commented"`, coloured green/red/violet via
  new `_decision-color`/`_decision-label`. Emits `<inkycap-review-decision>`
  (dict `target, action, note, by, on`) — the sixth query label is renamed from
  `<inkycap-review-reject>`. `#review[…]` (inline reviewer comment) is unchanged.
  The optional `note` renders on its own line only when present (a bare accept
  is a one-line row).
- **Rust glue (`typst_pipeline/review.rs`):** new `ReviewAction` enum (`as_typ`),
  `review_decision_call(...)`, `review_log_title` ("<name> — Review Log"),
  `append_to_review_log` (header: `= Review log`, no `collection` prop so it
  never packages back). Tests rewritten (7, +`action_strings_match_lib_typ_switch`
  pins the enum strings to lib.typ's switch).
- **Apply (`commands/collab.rs`):** `ReviewDecision.reason` → `comment`. The loop
  collects `(target, ReviewAction, comment)` log entries — **reject always logs**
  (with/without comment), **accept logs only when commented** (both the delete
  and write branches), **skip never logs**. New shared `append_review_log(...)`
  helper (DRY: used by apply + the new comment command; re-acquires storage,
  safe — `get_storage` clones an Arc under a brief read lock). New
  `collab_review_comment(collection_path, target, comment)` command (bare comment
  → `commented` entry, no apply; registered in `lib.rs`). Stale module doc-comment
  ("not yet wired") corrected.
- **Frontend:** `ReviewDecision.reason` → `comment` (types.ts); `collabReviewComment`
  ipc wrapper; collab store `reasons`/`setReason` → `comments`/`setComment`,
  `applyNote`/`applyReview` send `comment` on **any** decision, new `commentOnly`
  store action. **ReviewPanel:** comment textarea now always shown (not reject-
  only), "Add comment only" button (records without deciding, keeps note pending),
  relabelled "review log". **CollabPanel** (batch path): comment input shown for
  accept **and** reject (not skip), placeholder adapts. New
  `.review-panel__comment-btn` CSS.
- **`tests/review_primitives.rs`:** note now exercises all three
  `#review-decision` actions (accepted bare, rejected w/ note, commented w/ note)
  through the real Typst compiler — covers every `_decision-color`/`_decision-label`
  branch.

Files: `inkycap-notebox/0.2.0/lib.typ`,
`src-tauri/src/{typst_pipeline/review.rs, commands/collab.rs, lib.rs}`,
`src-tauri/tests/review_primitives.rs`; `src/lib/{types,ipc}.ts`,
`src/stores/collab.ts`, `src/components/{ReviewPanel,CollabPanel}.tsx`,
`src/styles/layout.css`.

**Note for Idea 2:** the generalized review log + `ReviewAction::Commented` are
the reuse hook for inline-suggestion accept/reject logging (sequencing step 2).

### UI refinements after first in-app test of the collab panel (2026-05-23)
- **New reusable `HelpButton` component** (`src/components/HelpButton.tsx` +
  `.help-button*` CSS) — a circled `?` that opens a dismissible help popover
  (Portal + viewport-clamped positioning mirroring `DatePicker`; outside-click /
  Esc / ✕ dismiss; `--popup-*` tokens). Built to be reused anywhere inline
  explanatory text would clutter the UI. In CollabPanel it **replaces** the three
  always-on hint paragraphs (packaging explanation, import folder, your handle)
  so the panel is terse and the detail is one click away.
- **Removed the review "Cancel" button** (CollabPanel) — closing the tab / not
  hitting Apply already abandons the review; Cancel was redundant. (`clearReview`
  is still used internally by `applyReview`.)
- **Disable confirm:** the requested "warn + let them cancel" on switching to
  Disable already exists (`CollaborationSection.setTo` → destructive `ask()`); no
  change needed.
- **ReviewPanel buttons (2nd in-app test):** Accept is no longer a green filled
  button — Accept/Reject now share the neutral base style (the green fill's light
  text was hard to read; the user wanted two equal choices). This supersedes the
  earlier "Accept is the only green button" decision. "Add comment only" → "Add
  Comment".
- **Themed dropdowns:** the CollabPanel review-decision (`Accept/Reject/Skip`) and
  bib-conflict (`Keep mine/Take theirs`) native `<select>`s → the app `<Dropdown>`
  (native selects render an unthemed OS-native popup under WebKitGTK).

## MERGED-IN — Review Commentary + Inline `#suggestion` Pills (captured 2026-05-23)

Two related ideas the user raised after the right-panel / tri-state work. **Nothing
built yet.** Folded in here from `project_collab_inline_suggestions.md`; full design
detail (forks, sequencing, prior art) lives in the companion plan
[collaboration-inline-suggestions-2026-05-23.md](collaboration-inline-suggestions-2026-05-23.md).
Both layer **on top of any transport** (package today; git/CRDT debate above) — a
comment or a suggestion is just Typst content that rides any delivery mechanism, so
neither is blocked by the direction decision.

**Context to reuse:** `#review(body, by:, on:)` / `#review-reject(target, reason,
by:, on:)` primitives + `<inkycap-review>`/`<inkycap-review-reject>` labels in
`lib.typ`; `typst_pipeline/review.rs` (call builders + `append_to_rejection_log`);
the rejection-log note; `FuncPillWidget` + content-bracket pill pattern; `--popup-*`
tokens + context-menu infra; `note_rewriter` AST source transforms (cf.
`path_rebase.rs`); `@codemirror/merge` whole-file ReviewPanel (the model these
augment).

### Idea 1 — Commentary on ANY decision (not just rejection) — SMALL, do first

Today only **rejections** get a stored note (`#review-reject` → rejection log).
Expand so a reviewer can attach commentary on **accept** too, or leave a bare comment
without deciding. **Cheap** because `#review[...]` already exists and already travels
back in the package — it's mostly a UI-flow gap on the accept path. Two shapes to
choose between: (a) generalize the rejection log into a **review/decisions log**
recording accept-with-comment / reject-with-rationale / bare comment alike (Typst-
native cousin of git's `decisions.yaml`); or (b) lighter — any decision optionally
carries a comment recorded as a `#review[...]` near the note or in the log. Reuses
everything; ship regardless of Idea 2's fate.

### Idea 2 — Inline `#suggestion` pills = Typst-native suggesting mode — BIG

Build change-tracking **into each note** as Typst markup instead of (or alongside)
the diff/merge view: a primitive wraps a proposed span → renders as a pill; click =
see/add a threaded message in a popup; right-click = Accept (unwrap/keep) / Reject
(delete + log). ≈ CriticMarkup / Google Docs Suggesting / Word Track Changes, stored
in the document. **May be the real resolution to the package-vs-git-vs-CRDT doubt:**
the distinctive thing isn't the transport, it's that the review model becomes *inline
intent* rather than whole-file diffs — more aligned with Typst-first identity than
git or zip-diff. It does NOT discard membership/identity/packaging (still needed to
deliver files + know who's who); it changes the *unit of review*.

Design decisions to settle (the hard parts):
1. **~3 pill variants**, not one: **insert** (accept→unwrap, reject→delete), **delete**
   (struck; accept→remove, reject→keep), **replace** (= delete+insert).
2. **Manual vs automatic — the big fork.** Manual (`/suggestion` palette / wrap a
   selection) fits the pill system today → **realistic v1**. Automatic "suggesting
   mode" (intercept every keystroke, Google-Docs-style) is a substantial CM6 feature
   with the full edge-case tax (nested/overlapping suggestions, two reviewers on one
   span, mode toggle) → **defer**.
3. **Complements diff-review; doesn't fully replace it.** A `#suggestion` *is* a diff;
   the clean design has the review UI **recognize suggestion markup specially**
   (resolvable in-context, not raw "added text"). Diff+transport stays the safety net
   for edits made without a suggestion wrapper.
4. **Thread storage = Typst-native, byte-fidelity round-trip** in the function args
   (`#suggestion(kind:, by:, on:, status:, thread:((by:,text:,on:),…))[content]`),
   same discipline as the `#note(...)` property round-trip.
5. **Accept/reject = source transform** of the `.typ` via `note_rewriter`; rejection
   note flows into the (Idea-1-generalized) review log.
6. **Rendering in `lib.typ`** (Typst-first): insert = underline/colour, delete =
   strike, replace = struck-old + colour-new; reading view + visual pill mirror.

**OPEN QUESTION before building Idea 2:** do suggestions **replace** the whole-file
diff review for prose, or **live alongside** it? → SETTLED 2026-05-23: **alongside**.

**Recommended sequencing:** Idea 1 first (small, independent, generalize the log),
then Idea 2 as *manual* suggestions; defer automatic suggesting mode.

### Idea 2 — DECISIONS SETTLED (2026-05-23)
- **Storage = Typst-native `#suggestion(...)`**, NOT literal CriticMarkup in the
  `.typ`. CriticMarkup isn't valid Typst (would break compiles-anywhere +
  source-of-truth + need a compile-path preprocessor); the toolkit is
  Python/Markdown (not embeddable); "won't be published" is handled by
  resolve-before-export, not by the storage format.
- **CriticMarkup is the UX layer, three ways (all wanted):** (1) the *visual
  rendering idiom* — insert = green underline, delete = red strike, replace =
  both; (2) a `{++ ++}`/`{-- --}`/`{~~ ~> ~~}` *typing shortcut* in the visual
  editor that expands to `#suggestion(...)`, like `[[ ]]` → `#wikilink`; (3) a
  *markdown import/export mapping* `#suggestion` ↔ CriticMarkup. Note the elegant
  full mapping: CriticMarkup comment `{>> <<}` → existing `#review[…]`, highlight
  `{== ==}` → existing `#highlight[…]`; only ins/del/sub need `#suggestion`.
- **Accept/reject = AST source transform** (`note_rewriter`/`path_rebase`-style):
  accept-insert→unwrap to text, reject-insert→remove; accept-delete→remove,
  reject-delete→unwrap; replace symmetric. Published output is clean Typst.
- **Threads:** v1 carries creator attribution (`by`/`on`); multi-message reply
  threads deferred to a follow-up (byte-fidelity arg write-back is the hard part).

### Idea 2 — BUILD PHASES
- **Phase A — Typst foundation (backend, fully testable): DONE 2026-05-23
  (uncommitted).** `#suggestion(body, kind:, old:, by:, on:)` in
  `inkycap-notebox/0.2.0/lib.typ` — insert = green underline, delete = red
  strike, replace = struck-old + underlined-new; emits `<inkycap-suggestion>`
  (dict kind/by/on; the **seventh** query label). New
  `src-tauri/src/typst_pipeline/suggestion.rs`: `SuggestionKind` enum +
  `suggestion_call(...)` builder; `resolve_suggestion_at(source, offset, accept)`
  + `resolve_all_suggestions(source, accept)` + `count_suggestions` — AST source
  transforms (`typst::syntax`, same discipline as `note_rewriter`/`path_rebase`)
  that **unwrap** a call to clean Typst (accept-insert→keep, reject-insert→drop;
  accept-delete→drop, reject-delete→keep; replace symmetric). Resolution by the
  call's hash-extended span containing a byte offset. Registered in
  `typst_pipeline/mod.rs`. Tests: 12 unit (`suggestion.rs`, incl. multibyte +
  inline-markup body round-trip) + 2 real-Typst (`tests/suggestion_primitive.rs`,
  all three kinds compile + query round-trip). Full lib **552** green.
  **No Tauri command yet** — deferred to Phase B so its shape (pure-source vs
  disk-path) matches the editor's actual need (no consumer = no guess).
- **Phase B — Visual editor: DONE 2026-05-23 (uncommitted; tsc + vite clean).**
  - `SuggestionWidget` (`widgets.ts`) — renders the marks (insert green-underline,
    delete red-strike, replace both); click opens a small Accept/Reject menu
    (portalled, `anchorPanelMenu`, `--popup-*`). Accept/reject =
    `applyCallTransform(view, from, () => resolution)` unwrapping to clean Typst;
    the TS resolution table mirrors Rust `resolution_text` (lock-step, commented).
  - `visual-plugin.ts` — `"suggestion"` added to `INTERACTIVE_FUNCS` (cursor-
    adjacent reveals raw source for editing; widget otherwise); `case "suggestion"`
    parses kind/by/on + body + `old`; new extract helpers `extractBracketAfter`,
    `extractNamedBracket`, `extractBodyBracket` (string-aware: the trailing body
    `[…]` is found *after* the balanced `(…)`, so `old: […]` isn't mistaken for it).
  - CSS: marks in `visual-theme.ts` (`.cm-suggestion-ins/-del`, colours match
    lib.typ #16a34a/#dc2626); menu in `layout.css` (`.cm-suggestion-menu*`).
  - `command-palette.ts` — 3 InkyCap entries (Suggest insertion/deletion/
    replacement).
  - `markdown-shortcuts.ts` — CriticMarkup typing shortcuts completed by `}`:
    `{++ ++}`/`{-- --}`/`{~~ ~> ~~}` → `#suggestion`; **and** `{>> <<}` → `#review`,
    `{== ==}` → `#highlight` (the full CriticMarkup input vocabulary; `{` isn't
    auto-paired so the trigger is clean).
  - **Folded into Phase C (user wants it):** comment field in the Accept/Reject
    menu. **Dropped (user: not needed):** selection-toolbar "suggest" buttons.
  - Also DONE: shortcut hints on the existing Highlight (`{==…==}`) and Review
    comment (`{>>…<<}`) palette entries advertise the new CriticMarkup triggers.
- **Phase C — Interop + review integration:**
  - **md↔CriticMarkup mapping: DONE 2026-05-23 (uncommitted; 558 lib green).**
    `typst_to_md.rs`: `#suggestion` insert/delete/replace → `{++ ++}`/`{-- --}`/
    `{~~ ~> ~~}`, `#review[…]` → `{>> <<}` (attribution dropped — the mark
    survives). `md_to_typst.rs`: the reverse + `{== ==}` → `#highlight`, run
    **before** the bare `==…==` pass (the braced form embeds it); dialect-
    agnostic. `#highlight` export kept as `<mark>` (existing round-trip
    undisturbed); `{== ==}` accepted additively on import. 6 new tests.
  - **Comment field (C4): DONE 2026-05-23 (uncommitted; tsc+vite clean).** The
    Accept/Reject menu (`SuggestionWidget`) gained an optional comment textarea;
    on resolve, a non-empty comment is left as an inline `#review[…]` at the
    suggestion's site (user's choice — local, Typst-native, no collection
    context, travels with the note). `replacement(accept, comment)` appends the
    review note to the clean-Typst resolution. Menu CSS reworked (header +
    textarea + Accept/Reject row).
  - **Review-UI-recognizes-suggestions (C5): settled = nothing extra.** With the
    alongside design, suggestions ride as note content, show in the whole-file
    diff, and resolve inline in the editor after accept — no special review-UI
    handling needed. (A per-note suggestion-count badge was offered + declined.)

**⇒ Idea 2 (MANUAL inline suggestions) is FEATURE-COMPLETE (Phases A+B+C),
uncommitted. Still deferred by design: AUTOMATIC "suggesting mode" (intercept
every keystroke) and multi-message reply threads on a suggestion.**

## DONE — Annotations rename + search integration (2026-05-23, uncommitted)

Supersedes a first attempt at a left-sidebar "Reviews" aggregation pane (built,
then **fully reverted**). Two reasons it was redone: (1) query-metadata markers
can't carry an annotation's rich body text or its source line, so they're the
wrong foundation for *finding text within a comment*; (2) the user wanted
annotation discovery to live in **Search**, not a separate sidebar pane — and
wanted the term **"Review" reserved for the collaboration change-review
workflow**, with the comment primitive renamed to **annotation**.

Full lib **560** pass / 0 fail; review/suggestion-primitive + utf8/path-safety
integration tests + tsc + vite all green. **Needs in-app validation, then
commit.**

### Part A — full rename `#review` → `#annotation`

Scope settled with the user: rename the comment primitive everywhere; **keep**
`#review-decision` and the whole collaboration review/diff workflow named
"review" (it genuinely *is* reviewing incoming changes). Annotations =
`#annotation` comments + `#suggestion` marks.

- **`inkycap-notebox/0.2.0/lib.typ`** — `#review`→`#annotation`,
  `<inkycap-review>`→`<inkycap-annotation>`, rendered heading "Review"→
  "Annotation", `_review-color`→`_annotation-color`, `_review-attribution`→
  `_attribution`, `_review-{accept,reject}-color`→`_decision-{accept,reject}-color`.
  `#review-decision` + `<inkycap-review-decision>` **unchanged**.
- **Editor** — command palette "Review comment"→**"Annotation"** (inserts
  `#annotation[`, cursorOffset 12); `ReviewBlockWidget`→`AnnotationBlockWidget`,
  `REVIEW_COLOR`→`ANNOTATION_COLOR`, "Review"→"Annotation" heading;
  `ALWAYS_EXPAND_PILLS` / `BLOCK_FUNC_NAMES` / visual-plugin case + import
  `review`→`annotation`; markdown-shortcuts `{>>…<<}`→`#annotation`; the
  suggestion accept/reject menu leaves an inline `#annotation[…]`.
- **md interop** — `typst_to_md` `ANNOTATION_RE` (`#annotation[…]`→`{>>…<<}`),
  `md_to_typst` (`{>>…<<}`→`#annotation[…]`); tests updated.
- **`typst_pipeline/review.rs`** doc + `tests/review_primitives.rs` updated
  (note authors `#annotation[…]` + `#annotation(by:,on:)[…]`, still exercises
  `#review-decision`).
- **Existing-note migration** — the package scaffolds **version-lessly** to
  `<notebox>/.inkycap/notebox.typ` via `write_if_changed` on *every* notebox
  open (`notebox_package.rs`), so the renamed `lib.typ` auto-propagates and any
  surviving `#review[…]` note would fail to compile. Migrated the two real
  occurrences: `InkyCap-Professional` and `Inky2` `Publishers/CAUT Journal.typ`
  (`#review[`→`#annotation[`). (The `#review-reject(…)` lines in old
  "Rejected Changes" logs are a *different*, already-removed primitive from the
  earlier `#review-reject`→`#review-decision` change — left untouched.)

### Part B — annotation search (toggle next to Regex + `annotation:` syntax)

The search engine already indexes annotation body text incidentally (its AST
walk descends into `#annotation`/`#suggestion` content). Added scoping on top:

- **`search/text_projection.rs`** — `TextProjection` gains `annotation_lines`
  (Vec<usize>, sorted+deduped: the source lines an `#annotation`/`#suggestion`
  call spans) and `annotation_text` (lowercased body via `collect_text_within`
  over those FuncCalls — excludes `kind:`/markup keywords). Body still emits
  ordinary searchable tokens too. New `handle_func_call` arm for
  `annotation`/`suggestion`.
- **`search/engine.rs`** — `DocEntry` gains `annotation_lines` +
  `annotation_text` (both `#[serde(default)]`; the index persists via **bincode**
  with no version field, so adding fields changes the layout → old blob fails to
  deserialize → `load_from_file` returns None → **automatic full rebuild**, no
  version bump, no data loss). `find_filter` handles `FilterKind::Annotation`
  (substring match on `annotation_text`; bare `annotation:` = any annotation;
  navigation lands on the matching annotation line, mirroring `tag:`).
  `collect_ranked_results` + `search_paginated` gain `annotations_only` — when
  set, result lines are restricted to `annotation_lines` (mirrors the
  import-line skip). `search()` is **unchanged** (passes `false`), so the dozen
  test callers + `commands/files.rs` are untouched.
- **`search/query.rs`** — `FilterKind::Annotation` + `"annotation"` in
  `from_prefix` / `to_prefix` (Display) / the tokenizer `PREFIXES` list.
- **`commands/search.rs`** — `notebox_search` gains `annotations_only`; an empty
  query + the flag synthesizes a bare `annotation:` filter → **browse every
  annotation** in the notebox.
- **Frontend** — `stores/search.ts` `annotationsOnly` signal; `lib/ipc.ts`
  `noteboxSearch` 6th param; `SearchPanel.tsx` — a `MessagesSquare` **Annotations
  toggle** beside the Regex toggle in the search settings (re-runs on click;
  empty query allowed while on), and an `annotation:` entry in `FILTER_HINTS`.
- **Tests** — engine `annotation_filter_and_scope` (filter match + bare-filter +
  `annotations_only` line restriction) and projection
  `annotation_and_suggestion_lines_and_body_recorded`.

### Kept from the reverted pane attempt
- `NoteMetadata::display_title()` — a reusable title helper the Agenda command
  was refactored onto (de-duplicated its private `note_title`).
- `markdown/md_to_typst.rs:279` `// utf8-safe:` annotation — the pre-existing
  `as char` (from commit `71c0cce`) is guarded by `is_ascii()`, so it's
  genuinely safe; the annotation un-breaks the `utf8_safety` CI grep.

### Deferred follow-ups
- A per-annotation result decoration (the result rows show the raw
  `#annotation[…]` source line, like every other search hit).
- Jump-to-exact-offset within the annotation (today lands on the line).
- A standalone "browse annotations" affordance beyond `annotation:` + the toggle.

## DONE — Zotero → shared `.bib` materialization (2026-05-24, uncommitted)

On enable (and re-synced at package), a collaborative collection now materializes
a **collection-owned `.bib` of just the entries its member notes cite**, pulled
from the active citation source — file **or** Zotero (so a Zotero-live source,
which can't travel in a package, is captured into a real `.bib`). lib **561**
green; needs in-app validation.

- Path: `.inkycap/collab/<collection-name>.bib` — **name-based** (not id-based)
  so both collaborators derive the same path and the import merge writes to a
  matching location; lives *beside* (not inside) the id-keyed sidecar dir, so it
  survives a Disable→Enable cycle. Hidden under `.inkycap/` (excluded from the
  note browser + search).
- **Additive union** — `materialize_shared_bib` merges the cited subset into the
  *existing* collection `.bib` via `merge_bibtex(existing, cited_subset, {})`, so
  entries collaborators contributed on a prior import are **never dropped** when
  re-materializing at enable/package. A malformed existing file is left
  untouched rather than clobbered.
- New code: `collab::bibliography::filter_bibtex_to_keys` (deterministic
  biblatex re-serialize; +unit test); `commands::bibliography::load_source_bibtex`
  (file → original `.bib` text for full fidelity, Zotero → `export_entries_to_bibtex`);
  `commands::collab::{shared_bib_relpath, materialize_shared_bib}`.
- Wiring: `setup_collaboration` replaces the old "point at `base.bibliography_file`"
  block — materializes, points `collaboration.bibliography_file` at the result,
  indexes it via `refresh_bib_versions`; falls back to the prior pointer when
  there are no citations. `collab_package` re-materializes before the bib refresh;
  `bib_rel` feeds both the sidecar refresh and the package bundle + manifest.
  Members resolved with `evaluate_filter_group` (the original filter at enable,
  the canonical one at package).
- Cited keys come from `typst_pipeline::bibliography::extract_citations` over each
  member note's source.
- **Deferred (separate concern):** per-note citation *rendering* still uses the
  notebox settings `bibliography_path`, not the collection's shared `.bib`. Wiring
  notes to resolve citations against the shared bib *while collaborative* (so the
  doc's "only source allowed while collaborative" holds at render time) is a
  larger change (augment is notebox-global, a note can be in many collections).

## DONE — Collab UX polish (2026-05-24, uncommitted)

- **Status-bar pending-review badge** — `StatusBar.tsx` renders an accent chip
  "N to review" (`MessageSquareCheck`) when the active review session has
  pending `note_items`; click → `revealPendingReview()` opens the collection
  tab, points the right-panel diff at the first pending note, and un-collapses
  the panel. New `.status-bar__review-badge` CSS. **Scoped to the loaded
  session** — there's no cross-collection scan, so the badge reflects whatever
  review is currently staged in `stores/collab` (lights up after an import or
  when a collaborative collection with a staged review is opened). A global
  "pending across all collections" indicator would need a new backend scan of
  every sidecar's `incoming/`.
- **Command palette "Collaboration" category** (added to `CommandCategory` +
  `CATEGORY_ORDER`): "Package this collection" (guarded on an active collection
  tab → `packageCollection`), "Import collaboration package"
  (`importNewPackage` global flow), "Review pending changes"
  (`revealPendingReview`, toast when none).
- **DRY refactor** — the dialog→ipc→toast flows now live once in
  `stores/collab.ts` (`packageCollection`, `importPackageInto`,
  `importNewPackage`, plus `pendingReviewCount` / `revealPendingReview`).
  `CollabPanel.doPackage`/`doImport` and `LeftSidebar.importCollabPackage` were
  refactored to call them (LeftSidebar's duplicated dialog/ipc/openTab/toast +
  its now-unused `open` import removed).
- (Same session, search UX: tips panel moved below the options row +
  auto-dismiss on results scroll; the search box/controls stay pinned while
  only results scroll.)

## Other remaining work (deferred, roughly prioritized)

2. **Polish (remaining):** a right-panel ReviewPanel beyond the inline collab
   tab (largely superseded by the existing right-panel Review diff), conflict
   resolution UI beyond accept-takes-theirs.
   - *Attachment hash-compare — DONE 2026-05-22:* `collab_review_apply`
     byte-compares each incoming attachment against the local copy and writes
     when missing **or changed** (was skip-if-present, so updated attachments
2. **Polish:** command-palette entries (Git:/Collab: actions),
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

Branch `typst-pivot`, single working tree. The prior session's work
(Issue #2, membership shrink, file-delete→tombstone, bibliography
merge/conflict, ContributorsEditor + byline/CRediT, book-export fixes,
attachment hash-compare, the `creation_rules` test fix) is all **COMMITTED**.

**Uncommitted at this handoff (2026-05-22, second session):** the
`#review`/`#review-reject` primitives + rejection log, **and** the right-panel
review-diff workflow — see the two DONE sections above. Touches:
- backend: `inkycap-notebox/0.2.0/lib.typ`,
  `src-tauri/src/typst_pipeline/{mod,review}.rs`,
  `src-tauri/src/commands/collab.rs`, `src-tauri/src/lib.rs`,
  `src-tauri/tests/review_primitives.rs`;
- frontend: `src/lib/{types,ipc}.ts`, `src/stores/{collab,layout}.ts` (new
  collab store), `src/components/{CollabPanel,RightPanel}.tsx` +
  `src/components/ReviewPanel.tsx` (new), `src/editor/typst-editor.ts`
  (`readOnlyTypstExtensions`), `src/editor/typst-decorations/{command-palette,
  visual-plugin,widgets,block-layer}.ts`, `src/styles/layout.css`,
  `package.json` + `package-lock.json` (`@codemirror/merge`).

Full lib suite **539 pass / 0 fail**; `tsc` clean; `npm run build` (vite)
succeeds. Validate the reject→log write and the right-panel review-diff loop
in-app, then commit.

**Not an app change (user's data):** two notes in `Inky2/Publishers`
(`Journal of Academic Librarianship.typ`, `Information Technology and
Libraries (ITAL).typ`) were repaired in place (markdown `# Heading` jammed
mid-paragraph). The same corruption still exists in the
`InkyCap-Professional` notebox copies — left untouched.

## OUTSTANDING THREADS — master checklist (consolidated 2026-05-23)

Every not-yet-finished thread from this doc, pulled into one place so none are
lost. Grouped by kind. Items link to the section above with the detail.

### A. Open decisions (need the user)
- [ ] **Transport direction** — package (current) vs git-as-second-transport vs
  CRDT. No decision; re-confirm before building more *transport*. See "OPEN
  QUESTION — collaboration direction". (The inline-suggestions work below is
  transport-agnostic and may itself reframe this.)
- [x] **Idea 2: replace vs alongside diff review** — settled 2026-05-23:
  **live alongside** (suggestions = intent layer; `@codemirror/merge` = safety net).

### B. Validation debts (code committed in `1b0272a`, but flagged "needs in-app validation")
- [ ] `#review` / `#review-reject` reject→log write + the reject-reason reveal UI
  ("Not yet validated in-app").
- [ ] Whole-file immediate-apply review: **editor reload-on-accept** and
  **reopen→review-mode persistence** ("All UI/async — needs in-app validation").
- [ ] Closing the collection tab no longer stranding the review (refinement #4 —
  "Re-test #4 in-app to confirm").
- [ ] Tri-state Disable/Pause/Enable pill + right-panel move + global identity —
  "partially validated in-app; validate the rest".

### C. Unbuilt features (deferred, roughly prioritized)
- [x] **Idea 1 — commentary on ANY decision** (generalized review/decisions log)
  — DONE 2026-05-23 (uncommitted; see "DONE — Idea 1" section below). Needs
  in-app validation, then commit.
- [ ] **Idea 2 — inline `#suggestion` pills** (manual v1; automatic suggesting
  mode deferred). Lives alongside diff review.
- [x] **Zotero → shared `.bib` materialization on enable** — DONE 2026-05-24
  (uncommitted). Materializes the cited subset into `.inkycap/collab/<name>.bib`
  (additive union; file + Zotero sources) at enable + package. See "DONE — Zotero
  → shared `.bib` materialization" section. Deferred: notes rendering against the
  shared bib while collaborative.
- [ ] **Book export error-tolerance (option 2b)** — render *around* a broken note
  via `recovery` (2a already names the failing note).
- [x] **Annotation discovery** — DONE 2026-05-23 (uncommitted). Redone as a
  rename (`#review`→`#annotation`, "review" reserved for collaboration) + a
  Search integration ("Annotations" toggle beside Regex + `annotation:` syntax),
  *not* a sidebar pane (that first attempt was reverted). See "DONE —
  Annotations rename + search integration" below.
- [x] **Collab UX polish** — DONE 2026-05-24 (uncommitted): status-bar
  pending-review badge (`StatusBar.tsx`, click → `revealPendingReview`) +
  command-palette "Collaboration" category (Package / Import / Review). Shared
  package/import flows extracted into `stores/collab.ts` (`packageCollection`,
  `importPackageInto`, `importNewPackage`) and reused by CollabPanel +
  LeftSidebar (de-duped). Badge is scoped to the loaded review session (no
  cross-collection scan exists — a global "pending across all collections"
  indicator would need a new backend scan). See "DONE — Collab UX polish".
- [ ] **Conflict-resolution UI beyond accept-takes-theirs** — per-attachment review
  (today: binary divergence takes-incoming, no UI); richer bib/note conflict UX.

### D. Known limitations (consciously deferred — revisit only if wanted)
- [ ] **External (out-of-app) deletions don't tombstone** — fall back to reconcile
  (note re-offers as `Added`). Would need index-gated lazy detection with a handle.
- [ ] **Defense-in-depth not taken:** re-canonicalizing the membership filter at
  package time (UI lock + enable-time canonicalization keep it canonical today).

### E. Data hygiene (not app code)
- [ ] `InkyCap-Professional` notebox copies still have the markdown-`# Heading`-
  mid-paragraph corruption (the active `Inky2/Publishers` copies were repaired).

## ⮕ NEXT SESSION — start here

**Committed since this doc was first written:** all the previously-uncommitted
work (right-panel Collaboration move + tri-state Disable/Pause/Enable pill +
global identity settings + the two Reviewing tweaks + `#review` primitives +
review-diff workflow + CollabPanel hint-wording) landed in commit `1b0272a`
("collaboration interface improvements, sidebar usage, user settings"). Working
tree is clean.

**Current focus (2026-05-23 resume):** continue with the **Review Commentary +
Inline `#suggestion`** ideas now folded into the "MERGED-IN" section above
(from `project_collab_inline_suggestions.md`). These are **transport-agnostic**,
so they proceed without resolving the package-vs-git-vs-CRDT direction debate —
and Idea 2 may itself *be* the resolution (review = inline intent, not whole-file
diff). Recommended order: **Idea 1 (commentary on any decision) first**, then
Idea 2 as *manual* suggestions.

**Still pending if you instead resume transport work:** the **direction decision**
(see "OPEN QUESTION — collaboration direction" above) — keep the package model,
add git as a second transport behind the existing review UI, or stop. Re-confirm
before building more transport.

Alternative feature work on the package model, from "Other remaining work" below:
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
3. **Collab UX polish** (command palette, status-bar badge, right-panel
   ReviewPanel). Could also surface the deferred Reviews aggregation panel
   (index `<inkycap-review>` into `QueryResult` + a panel).

The user had not yet chosen when the session ended (they opted to start
fresh). Re-confirm their pick at the start of the next session.
