---
title: "Notebox-level Git Collaboration — Plan"
created: "2026-05-24"
supersedes:
  - ".claude/plans/hi-i-would-like-declarative-otter.md (collection-level git)"
  - "the package-handoff transport (collaboration-status-2026-05-21.md), which this removes"
baseline_commit: "4c4966e (MILESTONE: …last set of changes before switching to a git-based system)"
status: "Phases 0-6 + Phase 7 + all session-2 work COMMITTED on `notebox-git-collab` (HEAD `2ae7920`, 2026-05-25). Session-2 commits: `acda2e6` (App.tsx collab-pane bounce-on-toggle-ON regression fix), `9c502cd` (Phase 7 offline package handoff + review-incoming mode + collaboration UX), `2ae7920` (suggest.rs markup-overlap raw-diff fallback). Phase 7 = whole-`.git` zip export/import; package mode = empty remote; rides Phase 5 engine via run_sync(push=false) against a transient local-path remote; optional AES. Review-incoming = per-notebox/per-machine toggle (off by default): Sync+import pause and stage every incoming note as suggestions (clean=mine→merged, no data loss). 567 lib tests, 0 warnings, tsc+vite+safety green; clippy 108 pre-existing/0 new. **⚠ 4 Junicode .ttf fonts left modified/uncommitted (pre-existing 2026-05-20, NOT this work — user to resolve).** **NEXT = continued in-app testing.** Deferred (user-validated, not built): two export modes — full vs incremental (git2 0.21 HAS PackBuilder → feasible); full intra-line opaque-markup rendering in suggest.rs (now falls back to raw diff on overlap); Export/Import surfaced only in package-mode panel (UI gate); binary/settings.json conflict UI (Phase 3b). Full detail in ⮕⮕ RESUME HERE + Phase 7 — DONE."
---

## ⮕⮕ RESUME HERE (next session) — all committed; continue in-app testing

**State at handoff (2026-05-25, end of session 2):** **everything is COMMITTED**
on `notebox-git-collab`, **HEAD `2ae7920`**, working tree clean except 4
unrelated font files (see ⚠ below). All gates green: `cargo test --lib` **567**,
0 compiler warnings, `tsc`, `npm run build`, utf8/path-safety. clippy 108
pre-existing / 0 new. The user was mid in-app testing and will resume there.

**Session-2 commit map (newest last):**
- `acda2e6` — **App.tsx collab-pane bounce fix.** The Round-6 "leave the pane
  when `!collaborative()`" effect (`800cc01`) bounced the pane away when toggling
  collaboration *on* (the SetupForm opens it on a not-yet-collab notebox). Now
  fires only on the `collaborative: true→false` transition (switch /
  Stop-collaborating), never on a deliberate open. A real regression the user hit.
- `9c502cd` — **Phase 7 offline package handoff + review-incoming mode + collab
  UX.** Phase 7: export the whole `.git` to one (optional AES) `.zip`; import as a
  new notebox (clone + drop transient origin) or reconcile into an existing one
  (transient local-path remote + `run_sync(push=false)` → conflicts pause/finalize
  like Sync); package mode = empty `NoteboxGitConfig.remote`; `run_sync` gained
  `push`. Review-incoming: per-notebox/per-machine toggle
  (`NoteboxLocalState.review_incoming`, off by default) — Sync+import pause and
  stage every incoming note as suggestions (clean = mine→merged, NO local-edit
  loss; proven by `review_mode_accept_preserves_local_edit_on_clean_merge`);
  `run_review` + `stage_suggestion_item` refactor; `git_get/set_review_incoming`;
  `save_settings` load-merges `local.json`; `git_pending_review` rebuilds a paused
  review after a restart. UX: status-bar chip is the SOLE collab entry (removed
  the vertical-toolbar handshake), neutral-until-action; package panel polish
  (folder-up/down Import/Export, "to share" language, Manage chevron +
  auto-collapse, review-aware ConflictView, package-mode setup toggle); Changes &
  History pane — row click navigates, per-row UserPen button opens
  Accept/Reject/Comment.
- `2ae7920` — **suggest.rs markup-overlap fallback.** A change over a line that
  already holds inline `#suggestion`/`#annotation` markup falls back to the raw
  diff instead of nesting a suggestion in a suggestion. Narrow (a change on a
  *different* line still renders pills). +2 tests.

**⚠ Uncommitted in the working tree (NOT this work):** 4 `src-tauri/assets/fonts/
Junicode-*.ttf` files, modified 2026-05-20 (pre-dates this session — likely a dev
build rewrite). Excluded from all session-2 commits. **The user is to decide**
whether to `git checkout` (discard) or commit them.

**NEXT — pick up the user's in-app testing.** Two deferred enhancements are queued
(both user-validated, neither built):
1. **Full intra-line opaque-markup rendering in `suggest.rs`** — preserve existing
   tracked-changes markup as a live pill and suggestion-render only the
   surrounding text (needs a tokenized intra-line diff). Today it falls back to
   raw diff on overlap (`2ae7920`); do this if that fallback proves too coarse
   once notes carry lots of tracked changes.
2. **Two export modes** — see "Future export work" below.

**Future export work (user-validated design, NOT built):** export currently
ships the **whole `.git`** every time. Two-mode plan, mirroring git
clone-vs-fetch: **Full / "Complete package"** (whole `.git`, the only thing that
onboards a *new* collaborator — what we have) + **Update / incremental** (only the
commits the peer lacks; needs per-peer basis tracking; a separate "Export
update" button). **Correction to an earlier note:** git2 0.21 lacks a `bundle`
API but **does** expose `PackBuilder` (`insert_walk` over a revwalk), so both a
compact single-packfile *full* export (smaller/faster for big noteboxes — the
135 MB case) and true incremental are feasible without a bundle API. Deferred,
not blocked.

**(Phase 0–6 historical note)** Everything from `e09fe27` onward is committed but
was not in the instance the user tested mid-session-1; the user has since
confirmed validation. The Phase 5/6 commit map is preserved below.

**Commit map (this collaboration effort, newest last):**
- `2ba46cc` Phase 5 sync model (git_sync / git_check_updates / git_sync_finalize)
  + the Settings per-notebox collaboration toggle.
- `e09fe27` post-sync editor reload (open editors refresh after a pull).
- `ed1846f` fetch prunes stale remote-tracking refs.
- `38fe1b6` Discard merge aborts (restores the working tree to HEAD).
- `c83b98d` **Phase 6** per-note version history + restore ("Changes & History"
  pane, Changes|History toggle, read-only version tab, non-destructive Restore).
- `b437fbd` Phase-6 validation: persistent Restore button, live status refresh,
  dismiss-a-comment, pane-click opens the review menu.
- `627d701` status reads "No local changes" (not "Up to date") before a fetch.
- `56cf1f5` dismiss/transform a comment no longer orphans its `#`.
- `6830f7d` offer to **reconnect** a repo-with-remote whose collab config is
  missing (vs silently non-collaborative).
- `58c17d7` Manage section is a full config editor (remote/branch/token/identity);
  identity pre-filled from `git_default_commit_identity`; honest identity hint.
- `9d5838e` **Check for updates is read-only** (fetch + report `behind`, no pull);
  token hint → `?` HelpButton; lighter dark-mode `.sidebar-hint`.
- `800cc01` Configure opens with Manage expanded; leaving a collab notebox for a
  non-collab one exits the Collaboration pane.

**NEXT:**
1. **Rebuild**, then run the in-app 2-clone validation from a CLEAN remote
   (`rm -rf /tmp/inkycap-test-remote.git && git init --bare -b main …` — the bare
   remote persists across sessions and `git init` won't wipe it). Exercise:
   clean-merge, conflict→finalize, ff; the read-only Check (status only, no
   files pulled); History/Restore; reconnect offer; the Manage config editor;
   dark-mode hint legibility.
2. Then **Phase 7 (offline package handoff)** — see its section. It rides the
   Phase 5 engine: `run_sync`/`run_finalize` are transport-agnostic and git2
   fetches from a local path, so "import a package" = extract + transient
   local-path remote + run the existing Sync. Only packaging (export/import zip
   of `.git`) + package-mode UX is new. Open Qs in that section
   (bundle vs whole-`.git` zip; how `NoteboxGitConfig` marks a server-less notebox).

**Still deferred (not blockers):** the opt-in "review every incoming change"
toggle (off by default; render M→merged, not M→theirs, to avoid dropping local
edits — `git_fetch_review`/`suggest.rs` kept for it); binary / genuine
both-edited-`settings.json` conflicts dead-end in "resolve manually" (Phase 3b —
`finalize` keeps-mine unless the user edits the working file first); a
per-notebox timeline + diff-against-now view + a true read-only version tab.

**Identity note (not a bug):** commits are authored by the system git config
(`~/.gitconfig` `user.name`) when no InkyCap identity is set; overridable in the
panel's Manage › identity fields (now pre-filled to make this visible).

**In-app validation findings (2026-05-25, partial run — fixed as found):**
- **Stale remote-tracking ref** → `ed1846f`. A remote that was reset/re-created
  left the local `origin/<branch>` ref pointing at deleted content; plain fetch
  doesn't prune it, so Sync merged against phantom content (recurring
  `settings.json` conflict + loop). Fetch now prunes. (Surfaced via the standard
  `/tmp/inkycap-test-remote.git` retaining content across sessions; `git init
  --bare` over an existing repo doesn't wipe it.)
- **Discard left auto-applied clean files** → `38fe1b6`. A conflicted Sync
  auto-applies the clean incoming files to the working tree before pausing;
  Discard cleared staging but left them, so the next Sync committed them
  (notebox polluted by an abandoned merge against the wrong remote). Discard now
  restores the working tree to HEAD.
- **Still open (low priority):** `settings.json` *travels in git by design*
  (carries shared config); a genuine both-edited `settings.json` conflict still
  dead-ends in the unresolvable "binary — resolve manually" path (Phase 3b). Not
  a blocker. Validation was not fully completed (clean-merge / digest / reload
  paths still want a proper 2-clone run from a clean remote).

**What shipped (Phase 5):**
- **[git/backend.rs]**: `apply_clean_merge(ours, theirs) -> MergeApplication
  {conflicts, applied}` (materializes the clean portion of a conflicted merge to
  the working tree via stage-0 blobs + clean deletions, leaving conflicts at
  ours), `write_index_tree()`. Test
  `apply_clean_merge_lands_clean_files_and_holds_conflicts`. **Removed**
  `fast_forward_to` (the retired rebase-onto-theirs hack).
- **[commands/git.rs]**: `git_sync` (pull+merge+push), `git_check_updates`
  (pull+merge, no push), `git_sync_finalize(push)` (resolve-then-commit), all on
  the shared pure+blocking `run_sync` / `run_finalize`. `SyncOutcome
  {upToDate, committed, pulled, pushed, rejected, paused, conflicts[], digest[],
  incoming}` + `DigestEntry`. Algorithm = the 5 steps documented at the top of
  the Phase-5 section in the file. Tests: clean-divergent-merge, conflict→pause→
  finalize, ff-check-no-push, up-to-date, push-only. **Removed** the user-facing
  `git_consolidate_note/all`, `git_publish`, `git_push` + `commit_staged`
  + `notebox_relative`; `git_fetch_review`/`suggest.rs`/`staging.rs` kept
  (suggest backs conflict rendering; fetch_review backs the future review-all).
- **Frontend**: `stores/git.ts` reshaped (`sync`/`checkUpdates`/`finalizeSync`/
  `discardReview`/`dismissDigest`, `syncOutcome`, `syncPaused`, `pendingCount` =
  paused conflicts); `GitCollaborationPanel.tsx` → Sync + Check for updates +
  ConflictView (finalize/discard) + DigestView ("what landed", dismissible);
  `types.ts` (`GitSyncOutcome`/`GitDigestEntry`, dropped `GitPushResult`/
  `GitPublishResult`); `ipc.ts` (`gitSync`/`gitCheckUpdates`/`gitSyncFinalize`);
  `events.ts` (dropped `onGitConsolidated`); command palette (`git:sync`,
  `git:check-updates`); i18n (`git.actions.*`, `git.conflict.*`, `git.digest.*`,
  `git.toast.sync*`); CSS (`git-panel__digest*`, `banner--conflict`; removed the
  per-item consolidate button styles).

**Post-sync editor reload — DONE in code (`e09fe27`), pending in-app confirm.**
The file watcher fires for git-checkout note writes (it ignores `.git`/
`.inkycap` but watches notes), yet nothing reloaded an *open editor buffer* on a
content change. Fixed: `stores/git.ts` dispatches `inkycap:notebox-synced` after
any pull and `awaitAllPendingWrites()` before each gesture; `TypstEditor`'s new
`reloadFromDisk()` (extracted from the sidebar property-reload path) reloads the
buffer on that event **only when clean** — a dirty buffer keeps its unsaved
edits (they merge on the next Sync), and the buffer-equality guard no-ops
untouched files. Still wants the GUI check (cursor position + visual-mode rebuild
after reload) during validation.

**In-app validation round 2 (2026-05-25, Phase 6 + status) — fixed as found:**
- Restore button hover-faded → made persistent. (`b437fbd`)
- Status read "Up to date"/stale after an edit/restore → the git store now
  refreshes status (debounced) on file-change events + restore refreshes
  immediately. (`b437fbd`)
- A standalone `#annotation` comment couldn't be removed → dismiss (X) on its
  Changes-pane row. (`b437fbd`)
- Clicking a tracked change in the pane dropped into raw markup → now opens its
  Accept/Reject/Comment menu (extracted `openSuggestionMenu`, shared with the
  inline widget; position-safe via `applyCallTransform`). (`b437fbd`)
- Status said "Up to date" before any fetch (misleading re: incoming) → **user
  chose manual-only + reworded to "No local changes"** (no auto-fetch; incoming
  stays a manual Check for updates / Sync). (`627d701`)
- Dismissing a comment left an orphan `#` (invalid Typst) → the annotation
  tracker now normalizes a call's `from` to include the leading `#`, so dismiss
  *and* the pane's Accept/Reject operate on the whole call. (`56cf1f5`)
- Collaborative state lived only in `settings.json`'s `git` field, so a repo
  with a remote but no field showed as non-collaborative (lost across a
  move/re-add; or an external clone — e.g. `InkyCap-Professional` w/ a codeberg
  remote). → **user chose "offer to reconnect"**: on open, a repo-with-remote-
  but-no-config emits `notebox:git-reconnectable`; the panel offers a one-click
  `git_reconnect_collaboration` (adopts the remote/branch from git, no typing).
  Externally-managed repos stay quiet until the user opts in. (`6830f7d`)
- **"Joshua Chalifour" as commit author = NOT a bug** — it's the system git
  config (`user.name`, from `~/.gitconfig`) fallback when no InkyCap identity is
  set. Surfaced + made editable (next item).
- **"Check for updates" made read-only** (`9d5838e`): it used to run the full
  pull+merge (downloaded files into the notebox). Now `git_check_updates` fetches
  and reports `CheckResult {upToDate, behind, incoming}` without merging/touching
  the working tree; the panel shows "N updates available — Sync to get them" (via
  the `incomingCount` store signal) + status chip; Sync brings them in. `run_sync`
  dropped its now-dead `push=false` path. Also: token hint → `?` HelpButton;
  `.sidebar-hint` dark-mode color → `--fg-muted` (was a saturated teal).
- Collaboration config UX (`58c17d7`): (a) remote URL + branch were unreachable
  after setup → **Manage section reworked into a full config editor** (remote/
  branch/token/identity, one Save = idempotent re-setup); (b) the commit identity
  was a mystery blank → new `git_default_commit_identity` (`GitBackend::config_identity`)
  resolves what InkyCap would use (per-notebox choice, else git config) and the
  setup + Manage forms **pre-fill** Name/Email with it; (c) the hint was wrong
  ("never shared with collaborators" — the author IS in commits; "keyed by
  remote" jargon) → rewritten honest.

**NEXT (Phase 5 + 6 are built + committed; this is validation + Phase 7):**
1. **Rebuild the app** (the running instance predates `ed1846f`/`38fe1b6` and all
   of Phase 6).
2. **Full in-app validation from a CLEAN remote** (`rm -rf` the bare remote
   first — it persists across sessions). Phase 5: clean-merge / conflict→finalize
   / ff all land; post-sync editor reload behaves (open a note in clone B, Sync
   in a collaborator's edit, watch it refresh without clobbering an unsaved
   buffer); digest + conflict lists read right; Discard truly aborts. Phase 6:
   the Changes|History toggle; History lists versions; viewing opens a read-only
   tab; Restore writes a new edit that Syncs. (Known minor: resolve tabs under
   `.inkycap/incoming/` stay open after finalize — auto-close is a nicety.)
3. Then **Phase 7 (offline package handoff)** — see its section below.

**Known limits to revisit (not blockers):**
- **Binary conflicts**: `finalize` keeps *mine* for a conflicted non-`.typ` file
  unless the user edits the working file before finalizing (the conflict row says
  "resolve manually"). The Keep-mine/Take-theirs/Rename UI is still Phase 3b.
- **Review-all toggle deferred**: the opt-in "review every incoming change" mode
  (off by default) is not built. The correct shape is to render *M→merged* (not
  M→theirs) as suggestions so non-conflicting local edits are never dropped, then
  reuse the same finalize path; `git_fetch_review`/`suggest.rs` are kept for it.

**Validation harness (recreate per machine):** `git init --bare -b main
/tmp/inkycap-test-remote.git`; set up a notebox at it, **Sync** (first commit +
push); clone elsewhere (in-app "Clone from remote") to play collaborator 2; edit
+ Sync on each side to exercise clean-merge, conflict→finalize, and ff. The
`-b main` matters (libgit2 inits on `master`; setup's `ensure_initial_branch`
handles it).

---

## Phase 5 — Sync model (ACTIVE, agreed with user 2026-05-24)

**Why:** Phase 2-4 added conveniences that diverged awkwardly from git and
created the partial-merge data-loss trap + the double-commit: (a) **per-note
partial consolidation** (git merges atomically — no "merge only their change to
note A"); (b) **two commit verbs** (Consolidate for incoming, Publish for
outgoing); (c) **mandatory review of *clean* incoming changes** (git auto-merges
non-conflicting work for free); (d) **rebase-onto-theirs** (`fast_forward_to`)
to keep pushes linear, which is what left un-consolidated notes stale. Keep the
genuinely-good accommodations (track-changes UI for conflicts, hidden porcelain,
author/message context); align the plumbing with git.

**User decisions (all confirmed):**
1. **Two gestures: `Sync` (pull+merge+push) and `Check for updates` (pull+merge,
   no push)** — so a writer can pull a collaborator's changes without
   broadcasting work-in-progress.
2. **Default = auto-merge clean + a non-blocking post-sync digest** ("Alice
   edited 3 notes…", click to see the track-changes diff). Full suggesting-mode
   review of *every* incoming edit is an **opt-in toggle**, off by default.
3. **Version history / restore (Phase 6)** comes next — per-note (and per-
   notebox) list of past versions (who/when/message), view/compare/**restore**
   (non-destructive: restore = a new change). Doubles as the safety net + the
   "what changed" surface.

**The merge mechanic (real git, no rebase hack):**
- Sync: (1) commit my working edits if dirty → `M`; (2) fetch → `T`;
  (3) `base = merge_base(M,T)`. Cases: `T` absent or `base==T` ⇒ mine is ahead,
  just push. `M`==`base` (I haven't diverged) ⇒ **fast-forward** to `T` (pure
  pull, no merge commit). Else **3-way merge** via libgit2 `merge_trees(base,M,T)`.
  (4) no conflicts ⇒ write merged tree + **merge commit (parents [M,T])** +
  checkout; conflicts ⇒ render conflicted notes as suggestions in staged copies,
  auto-apply the clean notes to the working tree, **pause** and return the
  conflict list + digest; user resolves → finalize: merged tree + merge commit +
  checkout. (5) push if Sync (the merge commit descends from `T`, so it
  fast-forwards the remote — no rebase, and atomic ⇒ no partial-merge trap).
- `Check for updates` = the same up to the merge/commit, **without** the push.

**Command reshape:** add `git_sync` (+ a finalize step for the conflict-resume),
`git_check_updates`; retire `git_consolidate_note/all`, `git_publish`, `git_push`
as user-facing (keep `git_fetch_review`/suggest.rs internally for conflict
rendering). Drop `fast_forward_to` from the consolidate path. Build the new
commands *alongside* the old (transition), switch the frontend, then remove the
old. Reuse: `suggest::render_incoming` (conflict-note rendering), `staging.rs`
(invisible scratch), fetch/commit/push/merge_base. New backend: `merge_trees`/
`merge_commit`, clean-tree checkout, digest from `changed_paths`.

**Frontend reshape:** panel's primary actions become **Sync** + **Check for
updates**; conflicts list (only conflicted notes need action) + post-sync digest
("what landed"); a "review every incoming change" opt-in toggle. Status chip:
behind/ahead → "updates available" / "changes to share". Retire the
Consolidate-all / per-note-Consolidate / Publish buttons.

## Phase 6 — Version history / restore — DONE (2026-05-25, `c83b98d`)

**Per-note** history shipped (per-notebox timeline deferred — not needed yet).
Hosted in the right-panel pane, **renamed "Changes & History"** with a
**Changes | History** segmented toggle (default Changes = the existing
annotations/tracked-changes view). History lists the open note's past versions
(message / author·date / short hash) from the commit graph; clicking a row opens
that version in a **read-only scratch tab**; **Restore** (confirmed) writes the
old content back through `NoteboxStorage` as a new edit the user then Syncs —
never rewrites history.

- **backend.rs**: `FileVersion` + `file_history(rel, limit)` (walks commits that
  touched the path, newest first, via `commit_touched_path`); `ensure_collaboration_gitignore`
  made **additive** (backfills new entries into an older managed block) and now
  ignores `.inkycap/history/`. Tests: `file_history_lists_only_touching_commits_newest_first`,
  `file_history_empty_on_unborn_branch`, `gitignore_additively_backfills_missing_entries`.
- **git/history.rs**: disposable scratch lifecycle for the read-only views
  (`.inkycap/history/<short-hash>/<note>`), cleared on notebox open
  (`surface_git_status`).
- **commands/git.rs**: `git_note_history`, `git_open_note_version` (writes a
  version to scratch, returns its path), `git_restore_note_version` (writes back
  via storage). Content fetched on demand with the existing `read_blob_at`.
- **Frontend**: `NoteHistory.tsx` (gated on `collaborative()`); the toggle in
  `AnnotationsPanel`; `RightPanel` tab/title rename; `GitNoteVersion` type +
  ipc; i18n (`history.*`, `annotations.paneTitle`/`view.*`); CSS.

**Possible later:** per-notebox timeline; diff-against-now view (the read-only
tab is view-only today); a true read-only editor state (the scratch tab is
technically editable but inconsequential — gitignored, watcher-ignored).

## Phase 7 — Offline package handoff (server-less transport) — DONE (2026-05-25, uncommitted)

**Built + all gates green** (`cargo test --lib` **563**, 0 compiler warnings,
tsc, vite build, utf8/path-safety). **Not yet committed; not yet in-app
validated** (the running instance predates it — rebuild before validating).

**Decisions taken (the section below was the roadmap; these resolve its open Qs):**
- **Transport = whole-`.git` zip.** git2 0.21 exposes **no bundle API**
  (confirmed — nothing in the crate), so incremental `git bundle` stays deferred.
- **`.git`-only** (no working tree): it is a complete repo; the working tree is
  reconstructed on import (clone/checkout), and the gitignored per-machine
  scratch is correctly absent. Confirmed against the `.gitignore` rationale.
- **Package mode = empty `NoteboxGitConfig.remote`** (no new field). Documented
  via `NoteboxGitConfig::is_package_mode()` (backend) / `packageMode()` (store).
- **Encryption optional, off by default, per-operation password** (not keychain —
  the recipient needs it out-of-band). Reuses the AES-256 `ZipBuilder`.
- **Rides the Phase 5 engine:** `run_sync` gained a `push: bool`; import points a
  transient local-path remote at the extracted package and calls
  `run_sync(.., push=false)` — conflicts pause + finalize exactly like a Sync
  (`git_sync_finalize(false)`). `set_remote` is skipped on an empty remote.

**What shipped:**
- **[git/package.rs]** (new) — `export(root, dest, password)` zips the whole
  `.git`; `extract_to_temp(archive, password)` unpacks to a temp staging repo
  with zip-slip defence (entries must be under `.git/`, no `..`/absolute
  components, never materialized as symlinks). 4 unit tests (round-trip,
  encrypted + wrong-password, reject-outside-`.git`, reject-traversal).
- **[git/backend.rs]** — `remove_remote(name)` (idempotent; drops the transient
  origin a first-time import leaves behind).
- **[commands/git.rs]** — `git_export_package`, `git_import_package` (case B:
  reconcile into the open notebox), `git_import_package_as_notebox` (case A: new
  notebox via `clone_into` + drop origin), `git_setup_package_handoff` (empty
  remote). `run_sync(root, git, push)` + empty-remote `set_remote` guards in
  run_sync/run_check/run_finalize; `apply_setup` empty-remote-safe. 2 e2e tests
  (clean divergent merge + conflict→finalize-no-push via a local package).
  Registered in lib.rs.
- **Frontend** — `types.ts` (`GitPackageExportResult`); `ipc.ts` (4 wrappers);
  `stores/git.ts` (`packageMode()`, `setupPackageHandoff`, `exportPackage`,
  `importPackage` — import routes through `applyOutcome(.., false)` to reuse the
  ConflictView/DigestView + finalize-without-push); `GitCollaborationPanel.tsx`
  (setup "Offline (package handoff)" toggle hiding remote/token; package-mode
  `PackageActions` view = Export/Import + one optional shared password field via
  save()/open() dialogs; Manage Save routes empty-remote→package, remote→server);
  `SettingsPanel.tsx` ("Import package" → new-notebox flow beside Clone, mirrors
  clone register+open); `commands.ts` (`git:export-package`/`git:import-package`
  open the panel); en.json (`git.setup.offline*`, `git.package.*`,
  `git.toast.export*/import*`, `command.git.*Package`). No new CSS (reused
  `git-panel__*` / `settings__*` classes).

**Known limits / deferred:** incremental bundles (no git2 API); a server-backed
notebox does **not** surface Export/Import in the panel yet (only package-mode
does — the backend supports export on any repo, so this is a UI gate only);
command-palette export/import open the panel rather than driving the dialog
directly (password lives inline in the panel). Binary-conflict + review-all
limits from Phase 3b/5 still stand and apply to import the same as Sync.

**⮕ NEXT: rebuild, then in-app-validate the package handoff** (export from one
notebox → import-as-new-notebox into an empty folder; edit both sides → export →
import-into-existing for a clean merge and a conflict→finalize; encrypted package
with right/wrong password), **then commit.**

---

## Phase 7 — Offline package handoff (server-less transport) — original ROADMAP (HISTORICAL)

**Idea (user, 2026-05-24):** collaborate with no hosted git server. Export the
notebox **with its git history** to a single file, send it however (email, USB,
drive), the recipient imports it and reconciles **locally**, edits, exports a
package back. This resurrects InkyCap's original pre-git "package handoff" —
but on the correct git foundation: because the package carries the full commit
graph, the **merge base travels with it**, so reconciliation is the same real
3-way merge as Sync (the old vector-clock model only had a 2-way compare — this
is strictly better). Fits the local-first, no-account audience.

**The key realization — it rides the Phase 5 engine almost entirely.** git2
fetches/clones from a **local filesystem path** (proven by the clone tests), and
the merge/conflict/digest orchestration (`run_sync`/`run_finalize`) is
transport-agnostic. So "import a package" = extract it to a temp dir and point a
**transient local-path remote** at it, then run the existing Sync. The only
genuinely new code is *packaging* (export/import) + the package-mode UX. The hard
part (merging) is done.

**Transport encoding — decide at implementation:**
- **Primary (works with today's git2): a zip of the repo's `.git`** (the whole
  repository — every committed note, attachment, and the history). Reuse the
  existing zip stack: `storage/zip_archive.rs` (`ZipBuilder`), `backup/archive.rs`
  (tree walk; here we *include* `.git` rather than exclude it as backup does),
  `backup/restore.rs` (extract), and `backup/password.rs` + the `zip` crate's
  `aes-crypto` for optional encryption. `.git` alone is a complete repo — leaner
  than shipping the working tree too.
- **Optional later: `git bundle`** — a single file supporting *incremental*
  packages (only the commits the other side lacks). **OPEN: confirm whether
  git2 0.21 exposes a bundle API** (Explore could not confirm; no bundle usage
  exists). If it doesn't: ship the whole-`.git` zip first; revisit incremental
  bundles (manual packfile, or a vendored capability) — do **not** shell out to
  system `git` (breaks the self-contained, no-system-git stance).

**Commands (new), modelled on backup:**
- `export_notebox_package(dest, password?)` — commit any pending working edits
  first (reuse Sync's "commit mine" step), then zip the repo → an encrypted-
  optional package. Sibling of `backup_now`.
- `import_notebox_package(archive_path, password?, dest?)` — extract to a temp
  staging dir, then:
  - **First-time recipient:** the extracted repo *becomes* their notebox →
    `register_notebox` + `open_notebox` (mirrors `git_clone_notebox`/`clone_into`).
  - **Already have it:** set a transient local-path remote at the staging repo
    and run `run_sync` (no push — there's no server; reconciliation is the
    merge) → conflicts as suggestions + the post-sync digest, exactly as Sync.

**UX:** a package-mode notebox shows **Export package** / **Import package**
instead of (or alongside) Sync / Check-for-updates. Needs a way to mark a
notebox "package-backed, no server" — `NoteboxGitConfig.remote` may be empty in
that mode (Sync requires a URL today), so setup gains a "no server / package
handoff" path, and the panel chooses gestures by mode. Server-backed and
package-backed can coexist on the same repo (same engine).

**Sequencing:** lands **after Phase 6**. Prereq: Phase 5 committed + validated.
**Open decisions for the proper plan:** bundle vs whole-`.git` zip (+ git2 bundle
check); `.git`-only vs whole-folder; how `NoteboxGitConfig` represents a
server-less notebox; encryption default; incremental vs full packages.

---


## Phase 4.2 — in-app clone onboarding (2026-05-24)

Removes the command-line-git step a joining collaborator previously needed.
Validated in-app (cloned the local bare remote into a fresh folder → opened as a
collaborative notebox).

- **`commands/git.rs`:** `git_clone_notebox(remote, branch?, dest, https_token?)`
  → stores the optional token, clones with the standard auth callbacks via a
  testable `clone_into` helper, returns the cloned path (frontend form). The
  cloned tree arrives already collaborative — remote + branch travel in the
  committed `.inkycap/settings.json`. Test `clone_into_fetches_notebox_content`.
- **Frontend:** `ipc.gitCloneNotebox`; a **Clone from remote** form in Settings ›
  Overview › Notebox Management (remote / branch / folder-name / optional token +
  parent-folder picker) that clones → `registerNotebox` → `openNotebox`.

## In-app validation — DONE (2026-05-24, uncommitted)

Full 2-repo round-trip exercised in the running app against a local bare remote
(`/tmp/inkycap-test-remote.git`): set up → publish (initial) → a "collaborator"
clone edits a note + pushes → Fetch & review (rendered the edit as a clean inline
`#suggestion`, banner "Proposed by …") → accept pill → Consolidate → Publish.
Remote tip ends with the consolidation fast-forwarded on top of theirs; no force.

Two bugs found + fixed during validation:
- **init default branch**: `apply_setup` did `open_or_init`, and libgit2 inits on
  `master`, so the first commit landed off the configured `main` and the push of
  `refs/heads/main` failed ("src refspec … does not match any existing object").
  Fix: `backend.ensure_initial_branch(branch)` points an unborn HEAD at the
  configured branch during setup. Regression test
  `setup_then_publish_lands_on_configured_branch`.
- **configured-but-no-repo**: deleting a notebox's `.git` (or opening a notebox
  whose settings travelled without a clone) left the panel stuck in the review
  view with no re-init path. Fix: store `repoMissing` (collaborative && status
  null), panel shows the setup form (pre-filled, "Re-initialize repository")
  in that state, and refreshes status on open.

**Open for the user's UX-clarity pass (deferred by user — "let it land first"):**
consolidate + publish currently yields **two** commits (`Consolidate …` then
`Update notes`) because the working tree reads dirty after consolidate; ideally
consolidate leaves a clean tree so Publish is a pure push. General workflow
wording/affordances also to be reviewed.

## Phase 4.1 — outgoing-authoring half (2026-05-24, uncommitted)

Phase 4 wired the *incoming* review loop but left no in-app way to commit/push
locally-authored work (the only commit path was consolidate, on incoming
staged copies). Added the outgoing half so a solo author can seed a remote and
share edits, and so the whole loop is testable in-app:

- **`backend.rs`:** `stage_all` (add_all+update_all, honours .gitignore),
  `unpushed_count(remote,branch)` (ahead vs remote-tracking ref; counts *all*
  commits when no tracking ref exists yet ⇒ first publish is surfaced), and
  `push` now **refreshes the local remote-tracking ref to HEAD on success** so
  status/unpushed reflect a push without a round-trip fetch. `GitStatusSummary`
  gained `unpushed`.
- **`commands/git.rs`:** `git_publish(message?) -> PublishResult {committed,
  pushed, rejected, nothingToDo, commit}` — commit the working tree if dirty
  (handles first commit *and* later edits), then push if anything is unpushed;
  never force (rejection ⇒ fetch & review). `git_status` now fills `unpushed`;
  `REMOTE_NAME` made `pub(crate)` and reused by `surface_git_status`. Test
  `publish_commits_working_tree_and_pushes_initial` (bare remote, +1 → 538).
- **Frontend:** `GitPublishResult` type, `ipc.gitPublish`, store `publish()`
  action (replaces the standalone `push()`, now removed — publish subsumes the
  post-consolidate push too); panel shows a single **Publish** button when
  `dirty || unpushed>0` ("Commit & push" vs "Push N"); status-bar + panel use
  `unpushed` for outgoing; command palette **Git: Publish my changes**.

**Test recipe (no GitHub needed):** `git init --bare /tmp/r.git`; open an
existing notebox → Settings › Overview › Collaboration (remote=`/tmp/r.git`) →
Publish (first commit + push). `git clone /tmp/r.git` a second folder, open it,
enable collab (adopts) → edit a note in clone A → Publish → in clone B: Fetch &
review → resolve pills → Consolidate → Publish. **Still uses CLI git for the
bare remote + the 2nd clone** (no in-app `git_clone` onboarding yet — next).

## Phase 4 — DONE (2026-05-24, uncommitted)

The frontend review surface. `cargo build` 0 warnings, `cargo test --lib` 537
(+1), utf8/path-safety, `tsc --noEmit`, and `npm run build` all green.

**UI placement (decided with the user, see memory `feedback_git_collab_ui_placement`):**
collaboration is **opt-in per notebox from Settings › Overview** (each notebox
row gets a Handshake "Collaboration" button — `handleCollaboration` switches to
that notebox if needed, then dispatches `inkycap:open-collaboration`). When a
notebox is collaborative, a **Handshake button appears in `VerticalToolbar`'s
`__bottom` group, just above the theme switcher** (gated on `collaborative()`,
carries a pending-count badge) and opens a **left-sidebar panel** (new
`SidebarMode "collaboration"`, rendered in `LeftSidebar`, modelled on the
Templates panel). File-level review reuses the existing suggestion pills + the
right-panel `AnnotationsPanel` (the staged note opens as a tab).

**Backend (commands/git.rs):** `git_setup_collaboration(remote, branch?,
identity?, https_token?)` (init-or-adopt repo via `apply_setup` — a testable
free fn — write `.gitignore`, set `origin`, store keychain token + identity,
persist `NoteboxGitConfig` through `save_settings` + shared state),
`git_status` (`Option<GitStatusSummary>`, `None` when not collaborative/not a
repo — lets the panel/status-bar refresh after ops), `git_sign_in(token)`
(keychain only), `git_disable_collaboration` (drops config + clears staging;
leaves `.git` + creds). All registered in `lib.rs`; test
`setup_initializes_repo_gitignore_and_remote` (no keychain/identity-store
touch).

**Frontend:** `types.ts` git mirrors (GitStatusSummary/CommitInfo/ReviewItem/
ReviewSession/PushResult/Identity/SetupResult); `ipc.ts` bindings (camelCase
wrappers, consolidate guarded by `assertNoteboxWritable`); `events.ts`
`on*` helpers for the `notebox:git-*` vocabulary; `stores/git.ts` (reactive
`gitStatus`/`reviewSession`/`gitSyncing`/`gitError`, `collaborative()`,
`pendingCount()`, actions, `ensureGitListeners`/`resetGitOnOpen` wired into
`openNotebox`); `GitCollaborationPanel.tsx` (setup form ↔ review view by
`collaborative()`); status-bar chip; command palette **Git** category
(setup/fetch-review/consolidate/push/sign-in) via an `openCollaborationPanel`
callback; full i18n (`git.*`, `command.git.*`) + CSS reusing accent/status
tokens.

**Still open (Phase 3b — build against this UI):** binary attachment
Keep-mine/Take-theirs/Rename and note Add/Delete decision *application*. The
panel currently *shows* `binary`/`deleted` items as read-only (honest: no
consolidate affordance) — the decision flow that re-asserts mine over the
adopted-theirs base is the remaining work. Also: Phase 4 needs **in-app
validation** (the two-clone fetch→review→consolidate→push round-trip).

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

**Deferred to Phase 3b — build *with* Phase 4, not before:** binary attachment
**Keep-mine/Take-theirs/Rename** and note **Add/Delete** decision application.

Why it's coupled to Phase 4 (don't repeat this analysis): consolidate adopts
*theirs* as the new base via `fast_forward_to` (so pushes fast-forward), which
**inverts** decision application. After adoption the committed baseline *is*
theirs, so "take theirs / accept their delete / accept their edit" are **no-ops**;
the work is the *disagreements* — "keep mine / reject their delete" must
**re-assert my bytes on top of the adopted theirs** (re-stage my content, re-add
my file). For notes the resolved staged copy already does this. For binaries and
add/delete, *whether/when* to re-assert depends on the consolidate-session model
(batched-all vs per-item) that the Phase 4 review UX defines — so building these
commands before that model exists would mean guessing it and reworking. The
note-suggestion → consolidate → push spine is complete and proven; 3b is the
remaining non-note decision flow, to be designed against the Phase 4 session.



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
