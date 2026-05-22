---
title: "InkyCap Collaboration via Packaging"
ZID: "20260521000000"
tags:
description: "Vector-clock package-handoff collaboration as an alternative to git integration"
revised: "2026-05-21"
aliases:
journalconnection: "[[2026-05-21]]"
---
# Collaboration via Packaging (vector-clock handoff)

## What this is, and how it differs from the git plan

This is an alternative to [git integration](hi-i-would-like-declarative-otter.md).
Instead of connecting a collection to a git remote, collaborators
**exchange zip packages** of a collection (by email, USB, a shared
folder, any external sync tool — InkyCap doesn't care which). Each note
carries a stable composite identity; a per-collection sidecar tracks a
**vector clock** (per-author edit counters). On import, comparing the
incoming clock against the local clock tells InkyCap, for every note,
whether the change is a clean fast-forward or a genuine concurrent edit
that needs review.

The two approaches share the **review UI** and the **filter-based
collection membership** model. They differ on everything underneath:

| Dimension | Git plan | Package-handoff plan |
|---|---|---|
| New dependencies | `git2`, `keyring` | none (reuses the backup zip writer) |
| Transport | any git remote, over the network | a file the user moves around however they like |
| Concurrency model | true concurrent, merge DAG | turn-taking; concurrent edits **detected** and hand-merged |
| History | full commit history | none (users keep their own backups) |
| Conflict diff | 3-way against common ancestor | 2-way (yours vs. theirs) |
| Identity | git author/committer | minted handle + composite `collabid` |
| Setup | remote URL, credentials, SSH/PAT | mark collection collaborative, name yourself |
| Non-InkyCap collaborators | can edit raw `.typ` outside the app | must use InkyCap (package format is ours) |
| Estimated size | thousands of lines | hundreds–low thousands |

The honest tradeoff: this is **detection, not resolution**. Vector clocks
tell you *that* two people edited the same note independently; they don't
merge it for you. The review UI shows both versions and the user decides.
There is no history and no three-way diff. For the academic
co-author / supervisor-reviews-student workflow this is acceptable; for a
3–5 person team editing concurrently, git is still the better tool.

## Goals

1. A collection can be marked **collaborative**. Doing so is the only
   switch the user flips; everything else follows.
2. **Package** a collaborative collection into a single portable file
   (zip) containing its member notes, attachments, the shared
   bibliography, the `.collection` file, and the version sidecar.
3. **Import** a received package and present incoming changes in a
   reviewable list: added / modified / deleted / conflict, each with a
   diff and accept / reject-with-rationale / accept-with-edits /
   annotate controls — before anything touches the working notebox.
4. **Multiple collaborators**, exchanging packages in any topology
   (A↔B, round-robin, hub-and-spoke). Edits propagate transitively.
5. A **contributors table** in Book Metadata: names, bibliographic
   roles, and CRediT roles, with the editing-collaborator subset
   carrying a stable identity used for versioning. This doubles as the
   long-wanted multi-author/byline feature.

## Non-goals

- Live concurrent editing / real-time sync / CRDT text merging.
- Version history or a log/timeline view.
- Three-way diff with a computed common ancestor.
- Editing by collaborators who don't use InkyCap.
- Network transport of any kind (the package is a file; moving it is the
  user's job).

## Constraints (inherited from CLAUDE.md)

- **Typst-first.** Identity (`collabid`), contributor roles, and review
  annotations are Typst-native metadata where possible. The contributors
  byline and CRediT statement render through the `inkycap-notebox`
  package, not a Rust string-builder.
- **NoteboxStorage is the only write seam.** Applying an accepted change
  writes through `NoteboxStorage` (now atomic — tmp + fsync + rename, see
  [`storage/local.rs`](../../src-tauri/src/storage/local.rs)). Reading
  files *into* a package reads through the trait; writing into the
  package staging area under `.inkycap/collab/` is direct (not user
  content).
- **Local-first, no telemetry.** Packages are produced and consumed
  locally. Nothing leaves the device except the file the user chooses to
  send.

---

## Core concepts

### 1. Collaborative collection

A boolean on the collection. When enabled, InkyCap performs a one-time
**migration** (see §"Enabling collaboration") and thereafter:

- disables Zotero-live bibliography for this collection (it must use a
  shared `.bib` file that can travel — see §Bibliography);
- requires every member note to have a `collabid` (mandatory ZID is the
  spine of identity);
- bumps the version clock on each meaningful save;
- surfaces package / import actions in the collection panel and command
  palette.

### 2. Composite note identity — `collabid`

ZID alone collides: it's a local timestamp, so two collaborators creating
a note in the same second get the same ZID. The durable identity is
therefore a **composite**: `<zid>-<birthAuthorHandle>`. Alice's
`20260521143000` and Bob's `20260521143000` are *different notes* because
they were born on different machines — collision is impossible by
construction, not by probability.

- Stored as a system property: `#note(collabid: "20260521143000-alice")`.
- Stamped **once**, when a note first enters a collaborative collection,
  using the current user's handle as the birth author. Never changes
  afterward, even when other collaborators edit the note.
- Repurposes the existing `gitcollection` slot in
  [`SYSTEM_PROPERTY_KEYS`](../../src-tauri/src/property_types.rs#L42)
  (added speculatively for the git plan; git isn't shipping, so the key
  is free). Type: `Text`, system-reserved.

**Filesystem collisions are then only cosmetic.** If Alice already has
`20260521143000.typ` on disk and imports Bob's note that wants the same
filename, the importer renames the *incoming* file by appending its birth
author: `20260521143000-bob.typ`. Deterministic (always the incoming
note's birth author), predictable, never destructive — the identities
were already distinct, so this is purely to satisfy the one-file-per-path
filesystem rule.

### 3. Vector clock — `versions.json`

Per collaborative collection, a sidecar at
`.inkycap/collab/<collection-id>/versions.json`. This is what travels in
the package and what the importer compares against. Shape:

```jsonc
{
  "schema": 1,
  "collection_id": "<stable hash of collection path>",
  "notes": {
    "20260521143000-alice": {
      "clock": { "alice": 3, "bob": 5 },   // author handle -> edit counter
      "path": "chapters/intro.typ",         // current path, for display + collision handling
      "hash": "sha256:…",                    // content hash of the note as of this clock
      "tombstone": null
    },
    "20260520090000-bob": {
      "clock": { "bob": 2 },
      "path": "chapters/old-draft.typ",
      "hash": null,
      "tombstone": { "by": "bob", "clock": { "bob": 2 } }  // deleted; see §Tombstones
    }
  },
  "bibliography": {
    "entries": {                             // see §Bibliography
      "smith2020": { "hash": "sha256:…", "added_by": "alice" }
    }
  }
}
```

**Clock comparison**, per note:

- *Incoming dominates* (every entry ≥ local, ≥1 strictly greater) →
  fast-forward. If `hash` differs → it's a real change to show as
  `modified`; if `hash` is identical → no-op (nothing to review).
- *Local dominates* → you're already ahead; skip.
- *Concurrent* (neither dominates): if hashes are equal → both made the
  same edit, auto-resolve by merging clocks (cell-wise max); if hashes
  differ → **conflict**, surface both versions in review.
- *collabid absent locally* → `added` (a note new to this machine).

The content hash earns its keep: it collapses no-op fast-forwards and
auto-resolves identical concurrent edits, so the review list only shows
things that actually differ.

### 4. Tombstones (deletes)

A delete has no content to clock-compare, so we don't drop the row — we
mark it. Deleting note X writes `tombstone: { by, clock }` into its
`versions.json` entry (and removes the file via `NoteboxStorage`). On
import:

- tombstone **dominates** the local clock → delete the file locally
  (after the same review gate; deletes are accept/reject too);
- tombstone **concurrent** with a local edit → a conflict review item:
  "alice deleted this note; you edited it — drop it or keep your
  version?".

Tombstones are retained in `versions.json` indefinitely (they're tiny).
This is the standard distributed-systems answer to delete/update
conflicts and is in scope for v1.

### 5. Identity handle — minted, seeded from name, frozen

The clock's author axis and `collabid`'s birth-author are a **handle**,
not the display name. Baking identity onto the literal name has two
failure modes: a name edit (spelling fix, added initial) would orphan all
that person's clock entries, and two people named "J. Smith" would share
one handle — reintroducing the collision we just eliminated.

So: when a contributor is marked an **editing collaborator**, InkyCap
mints a handle seeded from the name (`Joshua Chalifour` →
`joshua-chalifour`), shows it, lets the user edit it, and guarantees
uniqueness within the collection (`-2`, `-3`, … on collision). After
first use it is **frozen**; the display name can then change freely
without breaking version history.

Which collaborator *this machine's user* is, per collection, is pinned
locally (never shared) in `.inkycap/collab/<collection-id>/me.json`:
`{ "handle": "joshua-chalifour" }`. On importing a package for the first
time, if `me.json` is unset, InkyCap asks "I see collaborators alice and
bob — which are you?".

### 6. Contributors table (Book Metadata) — also the byline feature

Replaces the single `author` text field shown in the Book Metadata tab
today with a table of contributor rows. Each row carries two orthogonal
role vocabularies plus the collaborator flag:

- **Bibliographic role** — one of the CSL/Hayagriva contributor roles
  (`author`, `editor`, `translator`, `editor-translator`, `compiler`,
  `series-editor`, `illustrator`, `narrator`, `annotator`, `foreword`,
  `afterword`, `holder`, … + a custom free-text fallback). Drives the
  byline and how the name appears in citations; maps onto roles
  `hayagriva` already understands so the book-export title page renders
  it Typst-natively.
- **CRediT roles** — zero or more of the [14 NISO CRediT roles](https://credit.niso.org/)
  (Conceptualization, Data curation, Formal analysis, Funding
  acquisition, Investigation, Methodology, Project administration,
  Resources, Software, Supervision, Validation, Visualization, Writing –
  original draft, Writing – review & editing). Stored as canonical IDs
  (e.g. `https://credit.niso.org/contributor-roles/conceptualization/`)
  so they round-trip and can emit a proper contributions statement —
  increasingly required by journals.
- **`is_collaborator`** — when true, the row gets a frozen identity
  handle (§5) and participates in versioning. Non-collaborators (e.g. a
  funder credited only under "Funding acquisition" who never edits files)
  appear in the byline/CRediT statement but have no handle.

A person is commonly both axes at once: bibliographic `author` **and**
CRediT `Conceptualization, Writing – original draft`. UI: a `+` button
adds a row; each row has name, a bibliographic-role dropdown, a CRediT
multi-select, and the editing-collaborator checkbox (which reveals the
minted handle).

---

## Data shapes (Rust)

### `collection_parser/model.rs`

Extend `BookExportConfig` with a contributors list (keeping the legacy
single `author` for backward compatibility / simple cases):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Contributor {
    pub name: String,
    /// CSL/Hayagriva contributor role. e.g. "author", "editor", "translator".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub biblio_role: Option<String>,
    /// Canonical CRediT role IDs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credit_roles: Vec<String>,
    /// True when this contributor exchanges packages and edits notes.
    #[serde(default)]
    pub is_collaborator: bool,
    /// Frozen identity handle. Some(...) once the row is first used as a
    /// collaborator; None for pure-byline contributors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

// on BookExportConfig:
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub contributors: Vec<Contributor>,
```

Add a collaboration block to `CollectionFile`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CollectionCollaboration {
    /// When true, this collection participates in package collaboration.
    pub enabled: bool,
    /// Shared bibliography file (notebox-root-relative). Materialized on
    /// enable; the only bibliography source allowed while collaborative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bibliography_file: Option<String>,
}

// on CollectionFile:
#[serde(default, skip_serializing_if = "Option::is_none")]
pub collaboration: Option<CollectionCollaboration>,
```

The serializer already preserves untouched fields and skips `None`/empty,
so non-collaborative collections gain no YAML noise.

### `src-tauri/src/collab/` (new module)

```
collab/
  mod.rs            module root, CollectionId derivation (hash of path)
  identity.rs       handle minting + uniqueness, collabid stamping, me.json
  clock.rs          VectorClock type; compare() -> Dominates|DominatedBy|Equal|Concurrent; tombstones
  versions.rs       versions.json read / write / cell-wise-max merge
  package.rs        export (build zip) / import (unzip to staging) — reuses backup zip writer
  review.rs         diff incoming vs local versions.json -> Vec<ReviewItem>
  bibliography.rs   shared .bib union-by-key merge (hayagriva/biblatex)
```

`ReviewItem` (shared with the frontend):

```rust
pub enum ChangeKind { Added, Modified, Deleted, Conflict }

pub struct ReviewItem {
    pub collabid: String,
    pub path: String,            // destination path in the working notebox
    pub kind: ChangeKind,
    pub display_name: String,
    pub incoming_author: String, // handle that produced the incoming version
    // content payloads resolved lazily by a detail command, not in the list
}
```

---

## Workflows

### Enabling collaboration on a collection (one-time migration)

1. User toggles "Collaborative" in the collection panel and confirms.
2. For each member note (via the existing filter evaluator
   `get_collection_data` — the single source of truth for membership):
   stamp `collabid = <zid>-<myHandle>` if absent. If a note lacks a ZID,
   mint one first (ZID is mandatory for collaborative collections).
3. Materialize the bibliography: if the collection used Zotero-live,
   export the cited entries to a real `<collection>.bib` inside the
   collection and point `bibliography_file` at it; switch the collection
   off Zotero-live.
4. Create `.inkycap/collab/<collection-id>/` with an initial
   `versions.json` (every note at `{ myHandle: 1 }`, hashed) and prompt
   the user to confirm their identity row (mints/freezes their handle).

### Saving a note in a collaborative collection

Hook the existing save/reindex path
([`AppState::reindex_note`](../../src-tauri/src/state.rs#L534) or the
`write_file_content` command). On a content change whose new hash differs
from the stored hash: increment `versions.json[collabid].clock[myHandle]`
and update the stored hash. Bump only on real change (hash guard) so the
counter doesn't inflate on autosave no-ops.

### Packaging (export)

A command palette / collection-panel action. Builds a zip (reusing the
backup zip writer, factored into a shared helper):

- member notes (current filter match), by content;
- attachments referenced by those notes (rebased via the existing
  AST path rewriter where needed);
- the shared `.bib`;
- the `.collection` file;
- `versions.json`.

**Excluded:** `me.json`, caches, search index, other collections,
unrelated `.inkycap/` content. Output name e.g.
`<collection>-2026-05-21.inkycap-pkg.zip`.

### Importing a package (the review flow)

1. User picks a received package.
2. Unzip to `.inkycap/collab/<collection-id>/incoming/`.
3. If `me.json` unset → prompt "which collaborator are you?".
4. Load incoming `versions.json`; compute `Vec<ReviewItem>` by clock
   comparison (§clock comparison) including tombstones and the
   hash-based no-op/auto-resolve collapses.
5. Bibliography: union-by-key merge; same-key-different-content →
   one conflict ReviewItem.
6. Emit `collab:review-pending`; the **Review panel** opens.
7. Per item, the user picks: accept / accept-with-edits / reject (demands
   a rationale; appended as a Typst `#review-reject(...)` block) /
   annotate (adds a `#review(...)` block without deciding). Same
   primitives the git plan defined for `inkycap-notebox/lib.typ`.
8. On apply: accepted files are written through `NoteboxStorage`
   (atomic); the local `versions.json` is updated by cell-wise-max
   merging the accepted entries' clocks; filename collisions resolved by
   the birth-author suffix rule; staging cleaned.

### Bibliography merge detail

- Collaborative collection ⇒ exactly one bibliography: the shared `.bib`
  in the collection, which travels in the package.
- Each collaborator still *uses* their own Zotero locally. The existing
  Zotero→`.bib` export
  ([`write_zotero_export`](../../src-tauri/src/typst_pipeline/bibliography.rs))
  is redirected to **merge cited entries into the shared `.bib` by
  citation key** (union, never overwrite) rather than writing a local
  throwaway.
- Import merge is also union-by-key: identical entries → no-op; same key,
  different content → a conflict review item; **never auto-delete** (a
  note elsewhere may still cite the key). Optional GC: only entries that
  no note cites *and* the current user originally added.
- `hayagriva` + `biblatex` are already dependencies; parse → merge →
  re-emit needs no new crates.

---

## Frontend

| File | Change |
|---|---|
| `src/components/ReviewPanel.tsx` (new) | Source-agnostic review list + CodeMirror merge view for diffs; decision controls. Built for collaboration; designed reusable. |
| `src/components/ContributorsEditor.tsx` (new) | The Book Metadata contributors table (name, bibliographic role, CRediT multi-select, collaborator checkbox + minted handle). |
| `src/stores/collab.ts` (new) | Per-collection collab state, pending-review signal, current handle. Event-driven, no polling. |
| `src/lib/types.ts`, `src/lib/ipc.ts` | Typed mirrors + IPC wrappers; nothing as `any`. |
| Book Metadata tab (collection panel) | Swap single Author field for `<ContributorsEditor>`; add "Collaborative" toggle + package/import buttons + last-action timestamps. |
| `src/components/RightPanel.tsx` | Mount `ReviewPanel` when a collection has pending review items. |
| `src/components/StatusBar.tsx` | Indicator hidden unless a collaborative collection has pending review. |
| `src/components/CommandPalette.tsx` | "Collab: package collection…", "Collab: import package…", "Collab: review pending…", "Collab: set my identity…". |

---

## Tauri commands (`src-tauri/src/commands/collab.rs`)

| Command | Purpose |
|---|---|
| `collab_enable(collection_path)` | Run the one-time migration; returns identity-confirm payload |
| `collab_disable(collection_path)` | Turn off (sidecar retained) |
| `collab_set_identity(collection_path, handle)` | Pin `me.json` |
| `collab_package(collection_path, output_path)` | Build the zip |
| `collab_import(collection_path?, package_path)` | Unzip + compute review items |
| `collab_review_list(collection_path)` | Pending review summary |
| `collab_review_detail(collection_path, collabid)` | Side-by-side payload |
| `collab_review_decide(collection_path, collabid, decision, rationale?, edits?)` | Apply one decision |
| `collab_review_apply(collection_path)` | Commit decided items to the working notebox |
| `collab_status(collection_path)` | Pending count, last package/import timestamps |

Plus events in `events/mod.rs`: `CollabReviewPending`, `CollabImportStarted`,
`CollabApplied`, `CollabError` (frontend: `collab:review-pending`, etc.).

---

## Files to create / modify

**Create:** `src-tauri/src/collab/{mod,identity,clock,versions,package,review,bibliography}.rs`,
`src-tauri/src/commands/collab.rs`, `src/stores/collab.ts`,
`src/components/ReviewPanel.tsx`, `src/components/ContributorsEditor.tsx`.

**Modify:**
`collection_parser/model.rs` (Contributor, CollectionCollaboration),
`property_types.rs` (repurpose `gitcollection` → `collabid`),
`state.rs` (collab state: loaded clocks, current handle per collection),
the save path (`state.rs`/`commands/files.rs`, bump clock on real change),
`commands/{mod.rs}` + `lib.rs` (register), `events/mod.rs` (collab events),
`backup/` (factor the zip writer into a shared helper),
`inkycap-notebox/lib.typ` (`#review`/`#review-reject` primitives; contributor
byline + CRediT-statement helpers for book export),
`commands/export/pdf.rs` (title page consumes contributors),
`src/lib/{types,ipc}.ts`, and the collection-panel Book Metadata tab.

---

## Open questions / risks

1. **Bibliography merge is the gnarliest piece.** Union-by-key auto-merge
   handles ~95%; same-key-divergent-content conflicts are real when
   collaborators' Zotero libraries drift. Funnels into the review UI, but
   it's the part most likely to need iteration.
2. **Non-note files beyond the bib** (the `.collection` file itself,
   scaffolds). Simplest rule: version by file hash, conflict ⇒ "keep
   yours / keep theirs". The `.collection` file changing under two
   editors (e.g. both tweak the filter) needs a decision: last-writer or
   review. Leaning review.
3. **Attachments** are binary and unversioned by clock — treat like the
   bib's non-note files: hash-compare, conflict ⇒ pick one. Renames of
   attachments are not tracked.
4. **Identity bootstrapping across a group.** The first package defines
   the collaborator roster; later joiners pick their row. Two people
   independently adding *themselves* as new rows before exchanging could
   create duplicate identities for one human — mitigated by the
   uniqueness suffix, but worth a UX nudge ("is one of these you?").
5. **Reusing the git plan's `#review`/`#review-reject` primitives** means
   the `inkycap-notebox` package work from that plan is still relevant
   even though the git plumbing isn't.

## Verification sketch

1. Two-machine turn-taking: enable collab on machine A, package, import
   on B, edit, package back, import on A → clean fast-forwards, no
   conflicts.
2. Concurrent edit: both edit the same note between exchanges → exactly
   one conflict review item with both versions; hand-merge applies.
3. Same-second creation on both machines → distinct `collabid`s, both
   notes survive import, the colliding filename gets the birth-author
   suffix.
4. Delete vs edit: A deletes a note B concurrently edited → conflict item
   offering drop-or-keep.
5. Identical concurrent edit (both type the same fix) → auto-resolved by
   hash, no review item.
6. Bibliography: A adds `@x` from Zotero, B adds `@y` from Zotero →
   shared `.bib` after exchange contains both; same-key-different-content
   surfaces as a conflict.
7. Contributors: byline renders all rows with bibliographic roles; a
   CRediT statement renders from the role IDs; a name edit after the
   handle is frozen doesn't disturb version history.
8. Apply writes go through atomic `NoteboxStorage` — force-quit mid-apply
   leaves the working notebox coherent (staging is the source of truth
   until apply completes).
