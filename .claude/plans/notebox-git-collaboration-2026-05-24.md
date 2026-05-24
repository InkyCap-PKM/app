---
title: "Notebox-level Git Collaboration — Plan"
created: "2026-05-24"
supersedes:
  - ".claude/plans/hi-i-would-like-declarative-otter.md (collection-level git)"
  - "the package-handoff transport (collaboration-status-2026-05-21.md), which this removes"
baseline_commit: "4c4966e (MILESTONE: …last set of changes before switching to a git-based system)"
status: "Phase 0 DONE (e1298c8). Phase 1 (a84829d). Phase 2 (fe2a560). Phase 3 (resolve→consolidate→push) DONE + committed (f064bd6), 536 lib tests green. Remaining: Phase 3b (binary/add/delete decisions) + Phase 4 (frontend review surface)."
---

## Phase 3 — DONE (2026-05-24, commit f064bd6)

The consolidate + push spine. `cargo test --lib` 536 (+4), 0 warnings,
utf8/path safety + tsc green. Frontend untouched (Phase 4).

- **`commands/git.rs`**: `git_consolidate_note(path, message?)` /
  `git_consolidate_all(message?)` write the resolved staged copy to the working
  path **through `NoteboxStorage`** then stage + commit; `git_push` (never
  force — a non-ff comes back as `PushResult { rejected: true }`, not an error,
  so the caller fetch-and-reviews); `git_discard_review` (clears staging,
  working tree untouched); `git_set_identity`/`git_get_identity` (per-remote
  commit identity — completes Phase 1's identity story; consolidate's commits
  need an author). All registered; git work in `spawn_blocking`.
- **Correctness fix — the consolidate model:** a consolidate commit must be
  parented on the **fetched remote tip (theirs)**, not the stale local HEAD, or
  the push is a non-fast-forward and gets rejected. `backend.rs::fast_forward_to`
  does a soft/mixed reset that adopts theirs when it descends from HEAD (leaves
  the working tree so resolved files survive to be staged); on divergence it
  does nothing → push rejects → re-review (never a force-move). `commit_staged`
  adopts theirs before staging.
- **`backend.push`** returns `PushResult` and detects rejection from *both* the
  `NotFastForward` error and the `push_update_reference` callback (libgit2 uses
  either depending on transport — the bare-remote path errors).
- **`staging.rs`**: `list_staged`/`remove_staged` for the consolidate pass.
- Tests: end-to-end through a **bare remote + two clones** (fetch→review→resolve
  →consolidate-adopts-theirs→fast-forward push→third clone sees it) + a
  diverged-push-rejected case.

**Deferred to Phase 3b** (UI-coupled — decisions come from the Phase 4 review
surface): binary attachment **Keep-mine/Take-theirs/Rename** and note
**Add/Delete** decision application. The note-suggestion → consolidate → push
spine is complete and proven; these are the remaining non-note decision flows.



## Phase 2 — DONE (2026-05-24, commit fe2a560)

The one-review-surface core. `cargo test --lib` 532 pass (+19), 0 warnings,
utf8/path safety green. Frontend untouched (Phase 4).

- **`git/suggest.rs`** (the make-or-break piece): `render_incoming(base, mine,
  theirs, by, on) -> StagedRender`. Strategy: a line diff of *mine→theirs*
  drives rendering (insert/delete/replace) so the staged copy = mine with
  theirs overlaid as `#suggestion`s — giving **accept-all == theirs,
  reject-all == mine** (the round-trip invariant). The merge base classifies
  each hunk **clean** (only theirs touched it) vs **conflict** (mine also
  differs from base); conflict byte-offsets are returned so the review layer
  can hold them back from bulk-accept. No base ⇒ all clean ("all incoming").
  Reuses `typst_pipeline::suggestion::{suggestion_call, resolve_all_suggestions}`.
  Safety per CLAUDE.md: bodies verbatim (markup, not strings); line split scans
  ASCII `\n` only (UTF-8 safe); **staged copy parsed with the real Typst
  parser — whole-note fallback to raw-diff if rendering introduced errors**;
  existing `#suggestion`/`#annotation` hunks pass through (no double-wrap).
- **`git/staging.rs`**: `.inkycap/incoming/` lifecycle (gitignored + watcher-
  ignored). Staged copies mirror each note's relative path; cleared per fetch.
- **`git/backend.rs`** additions: `remote_tracking_oid`, `commit_info`
  (author/email/timestamp/message/short-hash), `changed_paths(from: Option<Oid>,
  to)` (HEAD→theirs tree diff; `None` from = unborn HEAD).
- **`commands/git.rs`**: `git_fetch_review` — set/sync `origin` from the config
  URL, fetch, diff HEAD→theirs, classify each path (`.typ` Added/Modified/
  Deleted vs non-note `Binary`), render modified notes as suggestions + stage,
  return `ReviewSession { items, incoming, up_to_date }`. `by:`/`on:` stamped
  from the incoming commit. Emits `notebox:git-{fetch-started,fetch-completed,
  review-pending,error}`. Registered in `lib.rs`. Runs entirely on a
  `spawn_blocking` task (git2 is sync + `GitBackend` is `!Sync`).
- **`similar` 2.7** added (line diffing; pure Rust, vetted via `insta`).
- Tests include an **end-to-end local-clone fetch** (no network) exercising the
  whole fetch→diff→render→stage→round-trip pipeline.

**Carried to Phase 3:** binary/attachment changes are only *classified*
(`ChangeKind::Binary`) — the Keep-mine/Take-theirs/Rename decision flow, plus
note Add/Delete decisions and `consolidate`/`push`, are Phase 3. The conflict
offsets from `suggest` feed the bulk-accept-excludes-conflicts rule there.



## Phase 1 — DONE (2026-05-24)

All eight ordered steps landed; `cargo build` (0 warnings), `cargo test --lib`
(513 pass, +13 new), `utf8_safety`/`path_safety`, `tsc`, and `npm run build`
all green. **Uncommitted** on `notebox-git-collab`.

What shipped:
- **`git2` 0.21** vendored (`vendored-libgit2` + `vendored-openssl`) — matches
  the project's "no OS-native TLS, identical cross-platform" stance and the
  "no system git installed" verification goal. `InkyCapError::Git` + `From<git2::Error>`.
- **`src-tauri/src/git/`**: `mod.rs` (loop doc + re-exports), `backend.rs`
  (`GitBackend`: `open_or_init`/`open`/`is_repo`/`set_remote`/`remote_url`/
  `current_head`/`status_summary`/`merge_base`/`read_blob_at`/`author_signature`/
  `stage_paths`/`commit`/`fetch`/`push` + `ensure_collaboration_gitignore`),
  `auth.rs` (keyring HTTPS-PAT per host, ssh-agent→default-key credentials
  callback, **remote-keyed author-identity store**), and honest "not built yet"
  stubs for `staging.rs`/`suggest.rs` (Phase 2/3). Local ops fully unit-tested;
  fetch/push are foundation, first exercised in Phase 2/3.
- **Events** (`events/mod.rs`): full Git vocabulary —
  `GitFetchStarted/Completed`, `GitReviewPending{count}`, `GitConsolidated{path}`,
  `GitPushStarted/Completed`, `GitCredentialNeeded{remote,transport}` (field is
  `transport`, not `kind`, which is the serde tag), `GitError{message}`.
- **`NoteboxGitConfig { remote, branch }`** on `NoteboxSettings.git: Option<…>`
  (shared, travels). Frontend `types.ts` + defaults updated so a settings save
  never drops a configured remote.
- **Settings split**: audit found window-state, metadata cache, and search
  index already live under OS config/cache dirs (outside the repo), so the only
  in-repo per-machine field was `startup.last_active_file`. It now routes to a
  gitignored `.inkycap/local.json` transparently inside `load_settings`/
  `save_settings` — **frontend `NoteboxSettings` shape unchanged** (the split is
  a pure persistence concern). The committed `settings.json` always records
  `last_active_file: null`.
- **`.gitignore` authoring**: idempotent managed block (markers) ignoring
  `.inkycap/local.json`, `.inkycap/incoming/`, OS noise; preserves user entries.
- **Notebox-open lifecycle** (`commands/notebox.rs::surface_git_status`):
  collaborative + already-a-repo ⇒ refresh `.gitignore`, emit
  `notebox:git-status` (no UI consumer yet — Phase 4). Read-only: **never**
  auto-fetches and **never** auto-`init`s (turning a notebox into a repo is an
  explicit Phase 4 action).

**KEY DECISION — author identity (resolves the step-3/step-4 ambiguity, with
the user):** identity is **NOT** in `NoteboxGitConfig` (if it travelled in the
committed settings, every collaborator would commit under one name). It lives in
a **per-installation store keyed by remote URL** (`auth.rs`,
`$CONFIG_DIR/inkycap/git-identities.json`): per-notebook (different remote ⇒
different account, satisfying the user's multi-account need), never leaks to
collaborators, and auto-applies to any clone of that notebox *on this machine*.
Commit-time resolution: store-by-remote → git's own `user.name`/`user.email`
(`repo.signature()`) → prompt. **Known limitation the user flagged:** carrying
identity to a *second machine* automatically needs InkyCap settings-sync (future
feature); the store is shaped so sync slots in additively. Until then it is set
once per machine and remembered per-notebook.



# Notebox-level Git Collaboration

## Phase 1 — original start-here checklist (HISTORICAL — Phases 1–3 are DONE)

> **Resume point is no longer here.** Phases 1–3 are complete and committed (see
> the `Phase N — DONE` sections above and the `status:` frontmatter). **Next up:
> Phase 4 (frontend review surface)** — per-notebox Git setup UI, the staged-note
> review tab (suggestion pills + incoming-commit banner), status bar, and
> command-palette entries; wire to the committed commands `git_fetch_review`,
> `git_consolidate_note`/`git_consolidate_all`, `git_push`, `git_discard_review`,
> `git_set_identity`/`git_get_identity`, listening for the `notebox:git-*` events.
> **Also pending: Phase 3b** (binary Keep-mine/Take-theirs/Rename + note
> Add/Delete decision application — build alongside the Phase 4 UI that drives the
> choices). The section below is kept as the historical Phase 1 record.

**Where we are (at Phase 1 start):** Phase 0 (remove package-handoff collaboration)
is **done and committed** as `e1298c8` on branch `notebox-git-collab` (branched off the
baseline `4c4966e`; `typst-pivot` is untouched). All green at handoff:
`cargo test --lib` = 500 pass / 0 fail, integration tests compile, `tsc` clean,
`vite` build succeeds. Two carried-forward notes: the salvageable bits
(`merge_bibtex`, `ChangeKind`/`ReviewResult`) were removed not parked — recover
from `4c4966e` when needed; and `#annotation`/`#suggestion` currently stamp only
`on:` (date) — `by:` (authorship) is wired back in this phase via the git author.

**Ordered Phase 1 steps (low-risk first; keep cargo/tsc/vite green at each):**

1. Add `git2` to `src-tauri/Cargo.toml` (`keyring` v3 is already a dep);
   `cargo build` to confirm it resolves.
2. Scaffold `src-tauri/src/git/`: `mod.rs` + minimal `backend.rs` / `auth.rs` /
   `staging.rs` / `suggest.rs` seams; register `pub mod git;` in `lib.rs`. No
   speculative scaffolding — just the module boundary.
3. Add `NoteboxGitConfig { remote, branch, author_name, author_email }` to
   `notebox_settings.rs`, persisted in notebox settings (NOT a `.collection`).
   This replaces the removed global identity and restores annotation `by:`.
4. **Settings split (the real design work):** audit `notebox_settings.rs` to
   separate notebox-*shared* settings (travel) from *per-machine* state (window
   state, last-opened, caches — ignored). This gates the `.gitignore` design.
5. Write the collaborative-notebox `.gitignore` (ignore `.inkycap/incoming/`,
   caches, search index, window state, `.git`; travel notes / `.collection` /
   `.bib` / bundled package / shared settings).
6. `GitBackend` over git2: `open_or_init`, `set_remote`, `fetch`, `merge_base`,
   `read_blob(oid)`, `commit`, `push`. No high-level `pull`/`sync` (review
   always sits between fetch and apply).
7. `auth.rs`: keyring-backed SSH-key generate/point + HTTPS PAT; credential
   prompt modelled as `AppEvent::GitCredentialNeeded` (never a blocking command).
8. Notebox-open lifecycle (`commands/notebox.rs`): detect `.git`, init the
   backend when configured, surface status. No auto-fetch by default.

Then **Phase 2** (fetch → 3-way diff → render hunks as inline `#suggestion`s in
`.inkycap/incoming/`) and **Phase 3** (resolve inline → consolidate → push). The
per-notebox "Git Collaboration" setup UI placement is deferred — build the
command/store layer first. Full detail for every step is in the phase sections
below.

## Why this exists (the pivot)

Collaboration was previously built two ways: a **collection-level git** plan
(`hi-i-would-like-declarative-otter.md`) and a shipped **package-handoff**
transport (vector clocks over zip). Both carried a large class of accidental
complexity, and *all of it traced to one root cause*: the unit of sharing was
a **subset** of the notebox (a collection), so the system constantly had to
decide which files belong, which collection "owns" a note, where an incoming
note should land in a differently-organized tree, and how to keep local files
distinct from shared ones.

**This plan changes the unit of sharing to the whole notebox.** A notebox is
either collaborative (backed by a git remote) or it is not. Everything in a
collaborative notebox syncs. Private notes live in a *different* notebox. This
maps onto how teams already use a shared git repo, and it **dissolves** the
hardest parts of both prior designs:

| Prior hard problem | Why it existed | Fate here |
|---|---|---|
| Syndication home (which collection owns a note) | a note can be in many collections | gone — a note is just a file in the repo |
| Filter-drift delete footgun | membership = filter evaluation | gone — no membership computation |
| Per-collection mirror worktrees | the notebox couldn't be a repo | gone — the notebox root *is* the repo |
| `collabid` path-independent identity, Issue #2, `import_folder`, `place_incoming` | collaborators organized trees differently | gone — same notebox ⇒ same tree ⇒ path *is* identity; git tracks renames |
| Vector clocks, membership-shrink, `package_versions_view` | no shared history | gone — git's commit graph *is* the history |
| `include_adjacent`, shared-`.bib` materialization | deciding what travels with a collection | gone — all files travel |
| §2.8 external-sync coexistence tar pit | collection-git + external sync on one tree | mostly gone — a collaborative notebox uses git *as* its sync |

It also **un-tangles collaboration from collections.** Collections revert to
being pure views/filters/book-export; collaboration becomes a notebox-level
property. Collections were doing double duty (organization *and* sharing unit),
and that overloading was the source of most of the pain.

Crucially, the pivot **fixes** the concern that drove the original doubt about
"accept = overwrite." The package/vector-clock model had no common ancestor —
only a 2-way comparison — so accepting a note could only mean *overwrite the
whole file*. **Git carries the merge base (last shared commit), so a real 3-way
merge is available**, and "accept" can become *fold their changes into my
edits* instead of clobbering them. The behaviour the user wanted becomes
*possible* the moment git is the transport.

## The core model

### One review surface: incoming changes rendered as inline suggestions

The defining design decision. Today there are **two disconnected review
surfaces** — file-level Accept/Reject (whole-note merge) and in-note
`#suggestion`/`#annotation` pills (per-span). Accepting a note pulled in their
whole version but left inline suggestions orphaned, so a coarse decision still
owed a pile of fine ones with no clear relationship. **We collapse them into
one surface, inline, in the note:**

1. **Fetch** from the remote (git subset; no merge into the working tree yet).
2. For each changed note, compute the **3-way diff** against the merge base and
   **render the hunks as `#suggestion` spans** (the insert / delete / replace
   variants already specced) in a *copy* of the note placed in a gitignored
   **staging folder** (`.inkycap/incoming/`). The working notes are untouched.
3. The user opens the staged note like any tab and **resolves the suggestions
   inline** — the existing pill workflow. Clean (non-conflicting) changes are
   bulk-acceptable; only genuinely overlapping spans (both sides edited the same
   text) require a hand decision.
4. **Consolidate** = the resolved staged note replaces the working note + a
   commit is recorded. One gesture, meaning exactly "I have merged this."

There is no longer a coarse whole-file accept that strands inline suggestions.
**The note-level gesture means "stage this for inline review"; resolving the
inline suggestions *is* the merge.** This is the connection the user identified
as missing, and it is Typst-first (the staged copy is real Typst with
`#suggestion` markup; source-of-truth preserved).

### Manual suggestions and auto-suggestions compose

Two sources of suggestions land in the same surface:
- **Auto-generated** from the diff — ephemeral; live only in the staging copy.
- **Manually authored** `#suggestion(...)` by a collaborator — real file
  content; travels through git like any text.

**Rule:** the diff→suggestion renderer detects when an incoming hunk *already
is* `#suggestion`/`#annotation` markup and passes it through verbatim rather
than wrapping it (no "suggestion of a suggestion"). A hand-authored suggestion
arrives as itself; a raw edit arrives as an auto-suggestion; both resolve with
the same pills.

### Git features we harvest (and the line we hold)

Use a **subset** of git — not the porcelain (no branch manager, rebase, stash,
cherry-pick, or log explorer; Obsidian Git exposes too much). The loop is
**fetch → stage-as-suggestions → consolidate → push**. From git we *do* harvest:

- **Commit messages** — the git-native carrier for the "why" behind a
  change-set, feeding the annotation/decision layer:
  - *Incoming* commit message(s) → surfaced as review context at the top of the
    staged note ("Changes proposed by Alice: *reworked the methods section*").
  - *Outgoing* consolidate → writes a commit message, optionally auto-summarized
    from the accept/reject decisions; `#review-decision` log entries ride along
    as content.
- **Commit author + timestamp** → auto-populate `by:` / `on:` on annotations and
  suggestions. **This replaces the `collabid` identity machinery** — the git
  author *is* the identity.

## Decisions locked (this conversation)

1. **Unit of sharing = the whole notebox.** A notebox is collaborative or not.
2. **One review surface** — incoming changes become inline suggestions;
   resolving them is the merge. (Whole-file raw-diff view kept only as an
   *optional* secondary view, not the primary gesture.)
3. **Staging = a real gitignored, watcher-ignored folder** (`.inkycap/incoming/`)
   of openable note copies.
4. **"note" = one `.typ` file** (one `#note(...)` per file). Note-level = the
   staging/consolidate/commit unit; suggestion-level = the resolution unit.
5. **Remove the package-handoff code outright** (recoverable from `4c4966e`),
   not "hide the UI" — superseding the earlier hide decision.
6. **Direct model, no mirror worktree.** The notebox root *is* the git repo;
   incoming file versions are read straight from the fetched commit's git
   objects (git2 gives blob content by OID), so there is no mirror worktree to
   manage. (`.git` and `.inkycap` are already in the watcher's `IGNORED_DIRS`.)
7. **Per-notebox Git Collaboration setup**, not global. Remove the global
   Collaboration section in Settings › Overview; add a per-notebox "Git
   Collaboration" entry point (repo URL + sign-in). *Exact UI placement TBD a
   bit down the road.*

## Phase 0 — Remove package-handoff collaboration

Recoverable from `4c4966e`. Salvage reusable pieces before deleting.

**Remove (the package/vector-clock transport):**
- `src-tauri/src/collab/`: `clock.rs`, `versions.rs`, `identity.rs`,
  `package.rs`, `apply.rs`, `attachments.rs`, package-specific guts of `mod.rs`.
- `src-tauri/src/commands/collab.rs`: the 13 `collab_*` commands
  (`collab_set_identity/get_identity/seed_handle/set_state/status/
  set_import_folder/package/import/import_package/pending_review/review_detail/
  review_apply/review_comment`) + their registrations in `lib.rs:347–359`.
- `CollectionCollaboration` struct + the `collaboration:` field on
  `CollectionFile` ([model.rs:303](../../src-tauri/src/collection_parser/model.rs#L303),
  [model.rs:352](../../src-tauri/src/collection_parser/model.rs#L352)) — collections become pure views.
- Frontend: `CollabPanel.tsx`, `CollaborationSection.tsx`; package/import paths
  in `stores/collab.ts`; the `CollectionCollaboration` TS type + the
  `collaboration` field on the collection type ([types.ts:170,180](../../src/lib/types.ts#L170)).
- Global `CollaborationSettings` ([settings.rs:210,419](../../src-tauri/src/settings.rs#L210))
  + its Settings › Overview UI ([SettingsPanel.tsx:267–304](../../src/components/SettingsPanel.tsx#L267))
  + settings store ([settings.ts:97](../../src/stores/settings.ts#L97)).

**Salvage before deleting:**
- `collab/review.rs` — keep the `ChangeKind` / `ReviewResult` / `ReviewItem`
  *types*; drop the clock-based decision matrix.
- `collab/bibliography.rs` — keep `merge_bibtex` (reusable for `.bib` merges).

**Preserve & repurpose (the durable review/annotation layer):**
- `ReviewPanel.tsx` + `@codemirror/merge` — becomes the *optional* raw-diff view.
- `AnnotationsPanel.tsx`, `annotation-tracker.ts`, `annotation-insert.ts` — the
  file-level annotations sidebar (explicitly wanted).
- `ContributorsEditor.tsx` + `typst_pipeline/contributors.rs` — byline/CRediT;
  identity now backed by git author (the `handle`/`is_collaborator` plumbing
  loses its package meaning but the roster/byline stays).
- `lib.typ`: `#annotation`, `#suggestion`, `#review-decision` + their query
  labels — the exact vocabulary the new model renders into.
- The review-session state in `stores/collab.ts` (decisions, the review feed) —
  rewired to the git source rather than rebuilt.

**Gate:** after Phase 0, `cargo build`, `cargo test --lib`, `tsc --noEmit`, and
`npm run build` must be green with the package code gone and collections
demoted to pure views.

## Phase 1 — Git foundation

### Dependencies
- Add **`git2`** to `src-tauri/Cargo.toml`. (`keyring` v3 is **already
  present** — `apple-native` / `windows-native` / `sync-secret-service`.)

### Backend module `src-tauri/src/git/`
A small surface; only what the loop needs:
- `backend.rs` — thin wrapper over `git2`: `open_or_init`, `set_remote`,
  `fetch`, `merge_base`, `read_blob(oid)`, `diff_tree_to_workdir`/`diff against
  base`, `stage_paths`, `commit`, `push`, `current_head`. No high-level
  `pull`/`sync` (review always sits between fetch and apply).
- `auth.rs` — keyring-backed credentials (SSH key generate-or-point; HTTPS PAT
  keyed by host), libssh2 auth callbacks. Credential prompts modeled as an
  `AppEvent::GitCredentialNeeded`, never a blocking command.
- `staging.rs` — `.inkycap/incoming/` lifecycle: write staged copies, read them
  back on consolidate, clean up.
- `suggest.rs` — **the core R&D piece** (see Phase 2).

### Per-notebox config (not global)
Git config lives at the **notebox** level, e.g. a new
`NoteboxGitConfig { remote, branch, author_name, author_email }` persisted in
the notebox settings (`notebox_settings.rs`), not in a `.collection` file.
Author identity (name + email) for commits lives here (or as global git
defaults overridable per notebox) — this is what replaces the removed global
`CollaborationSettings`.

### Notebox-open lifecycle (`commands/notebox.rs`)
On opening a notebox: detect `.git` at the root; if a git config is present,
initialize the backend and surface status (clean / outgoing / incoming). No
auto-fetch by default (opt-in setting). `.git`/`.inkycap` already ignored by the
watcher, so no special suppression needed for the repo itself.

### `.gitignore` + the settings split (real design work)
A collaborative notebox needs a `.gitignore` distinguishing **shareable** from
**per-machine** state:
- **Travels:** notes (`.typ`), attachments, `.bib`, `.collection` view defs, the
  bundled `inkycap-notebox` package, shareable notebox settings.
- **Ignored:** `.inkycap/incoming/` (staging), caches/search index, window
  state, last-opened, the `.git` dir itself, backups.
- **Action:** audit `notebox_settings.rs` and split per-machine state (window
  state, startup/last-opened) from notebox-shared settings so the former does
  not sync. InkyCap writes the `.gitignore` when a notebox becomes collaborative.

## Phase 2 — Fetch → diff → suggestion rendering (the core)

`git/suggest.rs` is the novel, highest-risk component. It maps a **3-way text
diff** (merge-base ▸ theirs ▸ mine) onto **well-formed `#suggestion` Typst
markup** in the staged copy. Requirements:

- **Round-trips** — the staged copy is valid Typst; resolving every suggestion
  yields exactly the intended merged source.
- **Never splits markup** — a hunk boundary must not land inside a `#func[...]`
  call, a math block, or a multi-byte character (UTF-8 discipline per CLAUDE.md;
  operate on char boundaries / slice copies, never `as char`).
- **Passes through existing suggestion/annotation markup** verbatim (the
  manual-suggestion rule above).
- **3-way:** clean (one-sided) hunks → suggestions that are bulk-acceptable;
  overlapping (both-sided) hunks → conflict suggestions requiring a choice
  (Keep mine / Take theirs / hand-edit), local edits never lost. If no merge
  base exists (unrelated histories), fall back to 2-way (all incoming vs empty).
- **Fallback:** if a note's hunks cannot be cleanly suggestion-ized (e.g. a
  pathological diff through complex markup), fall back to the `@codemirror/merge`
  whole-file raw-diff view *for that note only*, with a "couldn't auto-render"
  note. Correctness over coverage.

Pipeline command (replacing the old `collab_*` set), e.g. `git_fetch_review` →
returns a list of changed notes (added / modified / deleted / binary) with
staged paths and incoming commit context. Binary attachments are *not*
suggestion-ized — they keep the Keep-mine / Take-theirs / Rename flow already
built (salvage that logic). Note adds = all-new; deletes = a plain delete
decision.

## Phase 3 — Resolve & consolidate; push

- **Resolve** happens inline via the existing suggestion pills + the review
  session store. Per-note.
- **Consolidate** (per-note, `git_consolidate_note`): the resolved staged note
  is written to the working path via `NoteboxStorage`, staged, and committed.
  Commit granularity: per-note write, batched commit at the user's choosing
  (default: one consolidate = one commit, with a batched "consolidate all
  resolved" option). The commit message is auto-summarized from decisions,
  user-editable. `#review-decision` entries appended to the review/decision log
  travel as content.
- **Push** (`git_push`): standard push of consolidated commits. Never
  force-push. If the remote moved, fall back to fetch-and-review (the same
  Phase 2 loop) — no rebase UI.

## Phase 4 — Frontend

- **Remove** the global Collaboration section (Settings › Overview) and the two
  package panels (Phase 0).
- **Add a per-notebox "Git Collaboration" entry point** — repo URL + branch +
  sign-in (SSH key generate/point, or HTTPS PAT). *Placement TBD;* candidate is
  a notebox-level action near the notebox header in `LeftSidebar.tsx` and/or a
  notebox settings surface. Build the command/store layer first; the precise UI
  shell is the last, cheap-to-move piece.
- **Staging review surface** — reuse `ReviewPanel.tsx` for the optional raw-diff
  view; the primary surface is the staged note opened as a tab with suggestion
  pills + the incoming-commit-message banner. Reuse `stores/collab.ts` (renamed
  conceptually to a git-review session) for the decision feed and the
  status-bar pending badge.
- **Status bar** — clean / outgoing-N / incoming-N / syncing / error; hidden
  when the notebox is not collaborative.
- **Command palette** — "Git: fetch & review", "Git: consolidate resolved",
  "Git: push", "Git: set up collaboration for this notebox", "Git: sign-in".
- All new types in `types.ts`, all IPC through `ipc.ts` (no raw `invoke`).

## Events (`src-tauri/src/events/mod.rs`)
`GitFetchStarted/Completed`, `GitReviewPending { count }`, `GitConsolidated`,
`GitPushStarted/Completed`, `GitCredentialNeeded`, `GitError`.

## Reused vs. new (at a glance)
- **Reused:** suggestion pills + `#suggestion`/`#annotation`/`#review-decision`
  primitives, `AnnotationsPanel`, `ReviewPanel`/`@codemirror/merge`,
  ContributorsEditor, `merge_bibtex`, `ChangeKind`/`ReviewResult` types, atomic
  `NoteboxStorage` writes, `keyring`.
- **New:** `git/` module (git2 backend, auth, staging, **suggest.rs**),
  per-notebox git config + settings split + `.gitignore` authoring, the
  fetch/consolidate/push command set, the staged-note review surface, per-notebox
  setup UI.
- **Removed:** vector clocks, `versions.json`, `collabid`/`identity.rs`,
  `package.rs`, package commands, `CollectionCollaboration`, global
  `CollaborationSettings`.

## Risks / open questions
- **`suggest.rs` is the make-or-break.** Diff→suggestion rendering that
  round-trips and never breaks markup is genuinely hard; the per-note raw-diff
  fallback is the safety valve. Prototype this early against real notes.
- **Binary/attachment bloat** in git history (LFS is a non-goal) — acceptable
  for v1; flag to users.
- **Settings split** — which exact fields are notebox-shared vs per-machine
  needs an audit pass in `notebox_settings.rs`.
- **Per-notebox setup UI placement** — deferred by user ("to determine a bit
  down the road"). Build logic first.
- **Author identity source** — git author name/email replaces the removed
  `CollaborationSettings.author_name`; confirm ContributorsEditor seeding falls
  back gracefully (first contributor or git author).

## Verification (when built)
1. Fresh notebox, no system git installed: set up collaboration, push initial
   content, fetch on a second machine, review-as-suggestions, consolidate, edit,
   push back, review on machine one. (git2 self-contained.)
2. Both sides edit the same note → 3-way merge: non-overlapping hunks
   bulk-accept; the one overlapping span surfaces as a conflict suggestion;
   local edits never lost.
3. Collaborator hand-authors a `#suggestion` → arrives as a real suggestion,
   not double-wrapped.
4. Incoming commit message shown as review context; consolidate writes a
   message; `#review-decision` log entries travel.
5. Binary attachment conflict → Keep-mine / Take-theirs / Rename.
6. `.gitignore` correctness: staging, caches, window state, `.git` excluded;
   `.collection`/`.bib`/notes/package travel.
7. Suggestion-render fallback: a pathological diff falls back to the raw-diff
   view for that note without derailing the others.
8. No working-copy corruption on cancel/force-quit mid-consolidate (working
   notes only touched on a complete per-note consolidate).
