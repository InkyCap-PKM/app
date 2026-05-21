---
title: "InkyCap Git Collaboration Plan"
ZID: "20260510144628"
tags:
description:
source-url:
subject-dept:
disposition:
aliases:
journalconnection: "[[2026-05-10]]"
revised: "2026-05-21"
---
# Git Collaboration for InkyCap

## Revision note (2026-05-21)

This plan was first written when the notebox concept was still called a
"vault", and it led with whole-notebox auto-sync as the headline feature.
Since then InkyCap has matured into a collection-centric editor:
`.collection` YAML files drive views, filters, book export, styles, and
agendas; `NoteboxStorage` is the I/O seam; the event bus, backup
runner, and per-notebox settings are all in place. The collaboration
story has also narrowed. The user wants git to be a **useful optional
connector for collections** — not a sync engine grafted onto the
notebox, and not a dependency the user has to install before InkyCap
will run.

The shape below reflects that. The original Phase 1 (notebox-wide
auto-commit) is demoted to an optional power-user feature; the new
Phase 1 is **collection-as-repo with a review workflow**. The
collaboration loop — pull, see what changed, accept/reject/annotate,
push your own work — is the headline.

---

## Goals

1. **Connect a Collection to a remote git repository** (Codeberg, GitLab,
   GitHub, self-hosted, or a local bare repo). The collection becomes
   the unit of sharing — not the whole notebox.
2. **Pull incoming changes into a staging area**, present them as a
   reviewable list, and let the user accept, reject (with a written
   rationale), or accept-with-edits on a per-file or per-hunk basis
   before they touch the working notebox.
3. **Annotate changes with notes** — both private (just for me) and
   shared (visible to collaborators on the next push). Annotations are
   first-class Typst content where possible, so they survive in plain
   files.
4. **Push local changes** the user has explicitly chosen to share, with
   a commit message and (optionally) attached review notes.
5. **Be a first-class optional, not a requirement.** A user who never
   touches a remote should see no git noise. A user who does should
   not need to install `git`, configure SSH, or learn the porcelain.

## Non-goals

- Replicating the git CLI. No interactive rebase, no branch manager,
  no submodule UI, no stash UI, no cherry-pick, no log explorer beyond
  what the review workflow needs.
- Real-time collaboration / OT / CRDT.
- Whole-notebox automatic background sync as the default user
  experience. (Still available behind a setting for users who want it,
  but it is not what InkyCap leads with.)
- Typst-aware semantic merging in v1. Conflict resolution is text-level
  with helpful presentation.
- LFS, GPG signing, encrypted transport beyond what `git2` provides.

## Constraints

- **No required external dependencies.** `git` does not need to be on
  the user's PATH. SSH keys and credential managers may not exist. The
  default backend must be self-contained.
- **No telemetry, no leakage.** Note contents, paths, and remote URLs
  never appear in crash reports or any outbound request InkyCap itself
  makes.
- **Typst-first.** Anything a notebox can already do (labels, queries,
  metadata, package functions) is preferred over inventing new
  storage. Review annotations are Typst content; reviewer identities
  are Typst values; the rejection log is a Typst-readable file. The
  `inkycap-notebox` package gets the new `#review(...)` and
  `#review-reject(...)` primitives — see §2.2.
- **NoteboxStorage is the only file-I/O seam.** Git operations that
  touch the working notebox flow through it; the git plumbing itself
  operates on the mirror worktree (see §3).

---

## Architectural shape

```
┌──────────────────────────────────────────────────────────────────────┐
│ Notebox (the user's local working copy — never has a .git directory) │
│                                                                       │
│  …/notes/*.typ        ←──── working copy of collection files          │
│  …/.collection files                                                  │
│  …/.inkycap/                                                          │
│      packages/inkycap-notebox/…   (bundled, gitignored by default)    │
│      settings.json                                                    │
│      cache.sqlite, search.bin     (gitignored)                        │
│      git/                                                             │
│        <collection-id>/           ← one bare-ish mirror per linked    │
│          .git/                      collection. The working tree of   │
│          <files copied in>          this repo is private to InkyCap;  │
│          .inkycap-review/           the user never sees it directly.  │
│            pending/                                                   │
│            decisions.yaml                                             │
│        another-collection/…                                           │
└──────────────────────────────────────────────────────────────────────┘
```

The mirror-worktree approach is borrowed from the original plan and
holds up well:

- `.inkycap/git/` is in the gitignore the user's collection repos
  inherit, so we never sync a repo-inside-a-repo.
- `.inkycap/` is already in the file watcher's `IGNORED_DIRS`, so no
  feedback loops when we shuffle files in and out.
- The user's working copy of a collection's files stays exactly where
  they live in the notebox today — git is a satellite, not a host.

---

## Phase 1 — Foundation: backends and connectivity

### 1.1 `GitBackend` trait

Single module, `src-tauri/src/git/`, with the same submodule layout
the original plan called out. The trait surface stays small — only
what the collaboration loop needs:

```rust
#[async_trait]
pub trait GitBackend: Send + Sync {
    async fn open_or_init(&self, repo_path: &Path) -> Result<()>;
    async fn set_remote(&self, repo_path: &Path, name: &str, url: &str) -> Result<()>;
    async fn fetch(&self, repo_path: &Path, remote: &str, branch: &str) -> Result<FetchResult>;
    async fn diff_incoming(&self, repo_path: &Path, remote: &str, branch: &str) -> Result<Vec<FileChange>>;
    async fn diff_outgoing(&self, repo_path: &Path) -> Result<Vec<FileChange>>;
    async fn apply_incoming(&self, repo_path: &Path, files: &[FileSelection]) -> Result<()>;
    async fn commit(&self, repo_path: &Path, message: &str, author: &Author) -> Result<CommitId>;
    async fn push(&self, repo_path: &Path, remote: &str, branch: &str) -> Result<PushResult>;
    async fn log(&self, repo_path: &Path, limit: usize) -> Result<Vec<CommitInfo>>;
    async fn current_head(&self, repo_path: &Path) -> Result<CommitId>;
}
```

The trait deliberately omits high-level `pull` and `sync`. We never
want a one-shot pull that merges directly into the working notebox —
the review workflow always sits between fetch and apply.

### 1.2 Two backends, `Git2` is the default

- **`Git2Backend`** — the `git2` crate (libgit2 bindings). Self-
  contained, no PATH dependency. **This is the default** so a fresh
  install can collaborate without installing anything.
- **`SystemGitBackend`** — shells out to `git`. Offered when the user
  wants their existing SSH agent, `gitconfig`, credential helper, or
  GPG signing config. Detected at startup; only selectable if
  available.

User choice in settings. Auto-fallback Git2 → System is not done —
the user picks once. A silent fallback would surprise them.

### 1.3 Authentication

Self-contained credential storage so the default backend works end to
end without a system git install:

- **SSH key pairs** — let the user point InkyCap at an existing
  private key or generate one for them (stored in the OS keyring via
  the `keyring` crate, never in the notebox). Public key shown for
  copy-paste into the forge.
- **HTTPS personal access tokens** — stored in the OS keyring, keyed
  by remote host.
- The `SystemGitBackend` inherits the OS-level credential setup and
  needs none of this.

Credential prompts are modeled as `AppEvent::GitCredentialNeeded { ... }`
events with a frontend modal — they never block a Tauri command
indefinitely.

### 1.4 Settings — two levels (not three)

Per-collection settings live in the `.collection` YAML file (§2). The
intermediate `.inkycap/git.json` from the original plan is dropped —
the only thing left for it to hold was notebox-wide defaults, which
fit naturally in `UserSettings`.

In `UserSettings` (`src-tauri/src/settings.rs`):

```rust
pub struct GitSettings {
    pub backend: String,                    // "git2" | "system"
    pub system_git_path: Option<String>,    // override if user has git elsewhere
    pub default_author_name: String,        // for commit author when no signing config
    pub default_author_email: String,
    pub auto_fetch_interval_minutes: u32,   // 0 = manual only; default 0
    pub notebox_wide_sync: NoteboxWideSyncSettings, // power-user feature, default off
}

pub struct NoteboxWideSyncSettings {
    pub enabled: bool,                      // off by default
    pub remote_url: Option<String>,
    pub auto_commit: String,                // "manual" | "on_save_debounced" | "periodic"
    pub auto_push: bool,
}
```

Notebox-wide sync is preserved as an opt-in for users who want classic
"sync my whole notebox across machines" — but it is no longer the
headline.

---

## Phase 2 — Collections as repositories

### 2.1 Collection git config in `.collection`

Add to `CollectionFile` (`src-tauri/src/collection_parser/model.rs`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CollectionGit {
    /// Remote URL (any protocol git2 understands). None means "not linked".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    /// Branch to push to and fetch from. Defaults to "main".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Include collection-adjacent files (the `.collection` file itself,
    /// the bibliography file referenced by `bibliography_file`, attachments
    /// reachable from the included notes). Default true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_adjacent: Option<bool>,
    /// Reviewer identity used when annotating incoming changes. None means
    /// fall back to `UserSettings.git.default_author_*`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    /// When pulling, never auto-apply. Default true. Setting this false
    /// turns the collection into a classic auto-merge sync — supported
    /// but explicit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_review: Option<bool>,
}
```

…and a field `pub git: Option<CollectionGit>` on `CollectionFile`. The
serialiser already preserves untouched fields, which matters here —
users will hand-edit `.collection` YAML.

The mirror-worktree path is keyed by a stable id derived from the
collection's path relative to the notebox root, hashed; that survives
collection renames better than using the bare name. The mapping is
held in `.inkycap/git/index.json` so the UI can list every linked
collection without scanning every `.collection` file.

**Membership is filter-determined, not property-determined.** A
collection includes notes because the collection's filter matches
them — by tag, folder, property comparison, date, or any other
filter expression — not because the literal collection name appears
in a `#note(collection: ...)` list. Folder-based collections, tag-
based collections, and property-based collections all coexist. The
git pipeline must reuse the existing filter evaluator
(`get_collection_data`) as the single source of truth for "what
files belong to this collection right now"; no shortcut that reads
`#note(collection:)` from individual notes will give the right
answer for filter-based collections.

### 2.2 `inkycap-notebox` review primitives

New Typst-side primitives in `inkycap-notebox/lib.typ`. These are the
**Typst-first answer** to "where do review notes live": as queryable
Typst metadata, not a sidecar format.

```typst
// A reviewer's note attached to an incoming change. Renders as a
// callout in reading view; collapsed to a pill in visual mode.
#let review(
  author: none,            // string; defaults to current reviewer
  at: none,                // commit short-sha or ISO date
  scope: "file",           // "file" | "block" | "line"
  visibility: "shared",    // "private" | "shared"
  body,
) = [
  #metadata((kind: "review", author: author, at: at, scope: scope,
             visibility: visibility)) <inkycap-review>
  #body
]

// A rejection record. Lives at the bottom of the rejected note, or
// — if the whole file is rejected — in the collection's reviews log.
#let review-reject(
  author: none,
  at: none,
  rationale: "",
  rejected-content: none,  // raw Typst the reviewer didn't accept
) = [
  #metadata((kind: "review-reject", author: author, at: at,
             rationale: rationale)) <inkycap-review-reject>
  // Rendered as a struck-through, dimmed block in reading view; the
  // rationale shows above. Always visible — rejections aren't hidden.
]
```

Two new labels join the existing query catalogue (`<inkycap-note>`,
`<inkycap-tag>`, `<inkycap-link>`). The link index and indexer learn
to surface `<inkycap-review>` and `<inkycap-review-reject>` so the
review panel can be populated by the same `typst query` path
everything else uses.

### 2.3 Syndication home — which linked collection owns a given note

A note can be a member of many collections at once (its filter
matches several). When more than one of those is linked to a remote,
which collection is responsible for pushing the note? Without a
rule, edits would silently fan out to every matching repo — almost
never what the user wants.

The rule:

1. **Explicit assignment.** If the note has
   `#note(gitcollection: "<collection>")`, that collection is the
   syndication home. The `gitcollection` property is new — it's
   added to `SYSTEM_PROPERTY_KEYS` so its semantics are fixed (type:
   Text, one value, names a linked collection) and users cannot
   reassign its type. The name is deliberately git-specific to make
   its purpose obvious at a glance in the property editor;
   collections without a remote don't need it.
2. **Single-match fallback.** If only one linked collection's filter
   matches the note, that collection is the home implicitly — no
   `gitcollection` value required.
3. **Ambiguous case.** If two or more linked collections match and
   no `gitcollection` is set, push refuses for that note and the UI
   prompts the user to pick one. Better to interrupt than silently
   fan out.

Home is computed at push time against the *current* notebox state,
not stored as a snapshot. A note can change home as the user edits
its tags / properties / `gitcollection` value or as a collection's
filter changes.

**The pull direction is simpler.** Incoming files land at their
paths in the working notebox, and they are "in" or "not in" any
given collection by whether they match its filter — regardless of
which repo delivered them. The git remote is a delivery mechanism,
not a membership oracle.

The review panel surfaces the home explicitly: each pending file
shows "Home: <collection> ▾" so the user always knows where edits
will go when they push back.

### 2.4 Review staging area

`.inkycap/git/<collection-id>/.inkycap-review/`:

```
pending/
  <commit-sha>/
    files/            # incoming versions of files
      notes/foo.typ
      bib/refs.bib
    manifest.yaml     # which files, base sha, incoming sha, summary
decisions.yaml        # append-only record of past decisions:
                      #   - commit, file, decision (accept|reject|edit),
                      #     rationale, reviewer, timestamp
```

`decisions.yaml` is the durable, human-readable audit trail. It is
itself a git-tracked file (committed inside the mirror), so every
collaborator sees the same history of review decisions for the
collection — that is the part collaborators care about, even more
than the merge graph.

### 2.5 The review flow, step by step

When the user clicks "Pull changes" on a linked collection:

1. **Fetch.** `GitBackend::fetch` updates the mirror's remote-tracking
   ref. No working-copy changes yet.
2. **Diff incoming.** Compute the file changes between the mirror's
   current HEAD (representing what the user has accepted) and the
   fetched remote tip. Each change is classified `added | modified |
   deleted | renamed`.
3. **Stage.** Copy the incoming versions of changed files into
   `pending/<commit-sha>/files/`. Build `manifest.yaml`.
4. **Notify.** Emit `git:review-pending` with a summary. The status
   bar grows a badge with the count.
5. **Review UI** (§4) walks the user through each change with diff,
   editing, and annotation. Each pending row also shows the
   destination path and (where applicable) the home collection that
   would own the file after apply. Decisions are recorded into
   `decisions.yaml` *and* materialised:
   - **accept**: incoming file is copied into the working notebox via
     `NoteboxStorage`; the mirror's working tree is updated; a merge
     commit is created on the mirror's main branch.
   - **accept-with-edits**: same, but the user's edits land first; the
     merge commit records both contributions.
   - **reject**: the file in the working notebox is *not* changed; a
     `#review-reject(...)` block is appended to a per-collection
     "rejection log" note (default `_rejections.typ`, configurable per
     collection) capturing the rationale, the rejected content, and
     the source commit. On the next push, collaborators see the
     rejection in plain Typst.
6. **Cleanup.** `pending/<commit-sha>/` is removed once every file in
   the manifest has a decision.

### 2.6 The push flow

When the user pushes a collection:

1. **Compute outgoing.** Re-evaluate the collection's filter against
   the current notebox state via `get_collection_data` to get the
   set of files that belong to the collection right now. For each,
   apply the syndication-home rule from §2.3 — only files whose
   home is this collection are candidates. Compare each against the
   last accepted state in the mirror to classify as `added`,
   `modified`, or `deleted` (no longer matching the filter, or
   matching but with a different home now).
2. **Confirm.** Show the user a "what you're about to send" diff
   list, per-file deselect, and a commit message field. **Files
   classified as deleted get a distinct treatment** — they're
   surfaced under a separate "Files no longer in this collection
   (will be removed from the remote)" header, with the reason
   ("filter no longer matches" / "home changed to <other>" / "note
   deleted from notebox"). The user deselects any unintended
   deletions before push proceeds. This is the single biggest place
   where filter-based membership can surprise people, and the UI
   has to make it impossible to miss.
3. **Ambiguity check.** If any selected file's home cannot be
   resolved (multiple linked collections match, no `gitcollection`
   set), push refuses and the UI prompts the user to set
   `gitcollection` for each ambiguous note.
4. **Attach annotations.** Optionally include `#review(...)` blocks
   the user has authored with `visibility: "shared"` — these travel
   alongside the file content as Typst content, no out-of-band
   channel.
5. **Materialise.** Copy selected files into the mirror; stage;
   commit with the user's author identity; push.
6. **Reconcile.** If push fails because the remote moved, fall back
   to fetch-and-review (§2.5). We never force-push; the rebase /
   force-push affordance is explicitly out of scope.

### 2.7 Initial link to an existing remote

Two paths:

- **Clone into a new collection.** User pastes a remote URL, picks
  a destination folder inside the notebox; InkyCap clones into the
  mirror, then copies files out to the notebox at that folder and
  writes a `.collection` file alongside them. The generated
  `.collection` uses a **folder-based filter**
  (`file.folder.startswith("<dest folder>")`) so the collection is
  defined by location, not by mutating note frontmatter. This is
  the version that's least surprising for non-InkyCap collaborators
  editing the same `.typ` files outside the app — they don't need
  to know about a collection property.
- **Link an existing collection.** User pastes a remote URL onto an
  existing collection. Two sub-cases:
  - Remote is empty: push current collection contents up.
  - Remote has history: present a one-time review pass treating
    *all* remote files as incoming, then accept selectively. Files
    that would land at paths the existing collection's filter
    doesn't match are flagged in the review UI so the user can
    decide whether to widen the filter, place them elsewhere, or
    reject them.

### 2.8 Coexistence with external file-sync tools

Many writers run Filen, Syncthing, iCloud, Dropbox, or similar over
their notebox folder for personal multi-machine sync. InkyCap does
not try to coordinate with these tools — that's their domain — but
the collaboration design needs to play nicely alongside them.

**Recommended setup**, documented in an in-app help page reachable
from the Git settings tab:

- The external sync tool handles general notebox content.
- Git handles **only** the collections that are shared with other
  people.
- The user excludes `.inkycap/` (or at minimum `.inkycap/git/`,
  `.inkycap/cache.sqlite`, `.inkycap/search.bin`, `.inkycap/backups/`)
  from the external sync tool. InkyCap ships an "external sync
  exclusion list" snippet ready to paste into Syncthing's
  `.stignore`, a Filen ignore file, Dropbox's selective sync, etc.

**Affordances we add to make this workflow comfortable:**

- **"Fetch all linked collections"** — a single command palette
  entry and a status-bar popover button that runs fetch + populates
  review staging for every linked collection in the notebox. One
  click after the external tool has synced the day's notes in.
- **"Fetch all on startup"** — an opt-in setting under Git for
  users who want this to happen without thinking. Off by default.

**Safety nets for users who go against the recommendation anyway.**
The reality is that some users will sync the same files via both
git and an external tool. Pretending otherwise produces the worst
failure modes: corrupted reads, lost edits, watcher event storms,
silently divergent mirrors. We can't make this scenario *correct*,
but we can keep it from being *catastrophic*. **The mechanisms
below are deliberately small and isolated** — none introduce
always-running classifiers, per-write tagging, or shared substrate
that future contributors must remember to update. Each one stands
alone and can be disabled independently from the Git settings
"Diagnostics" panel without affecting git operations themselves.

- **Atomic writes everywhere `NoteboxStorage` touches the working
  tree.** Write to `<file>.inkycap-tmp` in the same directory,
  fsync, rename over the original. External sync tools then either
  see the old file or the new file, never a half-written one. The
  benefit isn't limited to git — it helps every external-sync user
  on every save. Audit `LocalNoteboxStorage` and add if missing.
- **Mtime check before and after applies.** When the review apply
  copies a file into the working notebox, stat the destination
  first and stash its mtime; immediately after the copy, stat
  again. If the post-copy mtime differs from what we just wrote
  (within a small tolerance), an external process touched it
  during the apply window — surface a "file was modified by
  another process during apply" warning and offer to re-pull.
  Doesn't prevent the race; makes it visible.
- **Quiescence wait before git operations.** Optional setting
  ("External sync is active on this notebox", off by default).
  When enabled, `git_collection_fetch` / `git_collection_push`
  start by calling a small helper that reads from the existing
  watcher event stream and returns once N seconds (default 3) have
  passed without a watcher event in the collection's tree, with a
  hard cap (default 30s) after which the user is asked
  "Wait / Proceed anyway / Cancel". No new substrate — just a thin
  async wrapper around the watcher channel the indexer already
  consumes.
- **Mirror integrity check on open.** When opening a notebox, for
  each linked collection, verify the mirror is structurally sound:
  `Repository::open()` succeeds, `HEAD` resolves to a real commit,
  our local last-applied state matches the mirror's record. If
  not — most commonly because an external sync tool partially
  synced `.inkycap/git/<id>/` — offer to re-clone the mirror from
  the remote. The user's working notebox is unaffected; only the
  satellite is rebuilt. ~80–100 lines, isolated, runs once per
  notebox-open per linked collection.
- **Indexer debounce extension during write storms.** The indexer
  already debounces watcher events before reindexing. Extend this
  with a single multiplier: when the rolling event rate (watcher
  events per second, all sources, no classification) exceeds a
  threshold, scale the debounce window up — 200ms → 1s → 5s,
  capped at 10s. Once the rate falls below the threshold for one
  full window, reindex with the accumulated set. Invisible to the
  user; ~20 lines added to the existing indexer; helps any heavy-
  write situation including but not limited to external sync.
- **"Diagnose sync issues" command** (replaces always-on
  detection). A command palette entry plus a button on the Git
  settings tab. Runs on demand and scans for known symptoms:
  external-sync artifact files inside `.inkycap/` (`.stversions/`,
  `.syncthing.*.tmp`, `Icon\r`, `.DS_Store` in odd places),
  recent foreign mtimes on git plumbing files, mirror integrity
  failures across all linked collections, and any orphaned files
  in review staging. Reports findings as a list with suggested
  fixes. Doesn't run automatically; the user triggers it when they
  suspect a problem. Avoids the per-write classifier and the
  always-on banner state — at the cost of not catching
  misconfigurations preemptively. The settings-tab help link
  carries the preventive-education weight instead.

**Maintainability commitments.** Three practices to keep this from
drifting into the kind of complexity it's trying to mitigate:

- **`NoteboxStorage` is the single seam.** A debug-build-only
  assertion verifies that no writes happen to the notebox tree
  outside the trait — added to the watcher event handler in
  `cfg(debug_assertions)` blocks. Zero cost in release builds;
  catches drift early in development.
- **One "sync-diagnostics" log channel.** All five mechanisms
  above log their decisions to the same target ("integrity check
  passed for collection X", "extended debounce to 1.2s",
  "atomic-rename failed, retrying"). When something misbehaves in
  the wild, one log tells the whole story.
- **Per-mechanism kill switches.** A "Diagnostics" section in the
  Git settings exposes a checkbox for each: atomic writes, mtime
  check, quiescence wait, integrity check, debounce extension.
  These are augmentations, not core — if any misbehaves in the
  field, the user can disable it without losing git itself. This
  is the safety valve that keeps a "useful safety net" from
  becoming "load-bearing complexity nobody dares remove."

**What we still explicitly don't try to solve:**

- Two-way conflict semantics across the boundary. If Syncthing
  delivers version A of a file at the same instant a git pull
  delivers version B, one of them wins on disk. Both tools own
  their own conflict mode; bridging them is out of scope.
- Detecting that the user has *forgotten* to exclude `.inkycap/`
  before any damage has happened. The "Diagnose sync issues"
  command finds the problem after symptoms appear — preventive
  education lives in the help docs the Git settings tab links to.

---

## Phase 3 — Wiring (commands, state, events)

### 3.1 Tauri commands (`src-tauri/src/commands/git.rs`)

|Command|Purpose|
|---|---|
|`git_environment`|Probe backends, return availability + version|
|`git_collection_link(collection_path, remote_url, branch)`|Connect a collection to a remote|
|`git_collection_unlink(collection_path)`|Disconnect (mirror retained for safety)|
|`git_collection_clone(remote_url, dest_folder)`|Clone a remote into a new collection|
|`git_collection_fetch(collection_path)`|Run fetch + populate review staging|
|`git_collection_review_list(collection_path)`|Pending reviews summary|
|`git_collection_review_detail(collection_path, commit, file)`|Side-by-side diff payload|
|`git_collection_review_decide(collection_path, commit, file, decision, rationale?, edits?)`|Apply a decision|
|`git_collection_push(collection_path, message, file_selection, attached_reviews?)`|Push outgoing changes|
|`git_collection_status(collection_path)`|Outgoing-count, pending-count, last-fetch, last-push|
|`git_collection_log(collection_path, limit)`|Recent commits (read-only timeline)|
|`git_credential_save(host, kind, value)`|Persist a credential into the keyring|
|`git_credential_forget(host)`|Drop a credential|
|`git_diagnose_sync()`|On-demand sync-issue scan (§2.8); returns a findings list|
|`git_notebox_sync_*` (optional set)|Notebox-wide sync for users who enable it|

Register in `commands/mod.rs` and `lib.rs`.

### 3.2 `AppState` additions

```rust
pub git_backend: RwLock<Option<Arc<dyn GitBackend>>>,
pub git_collection_states: RwLock<HashMap<CollectionId, CollectionGitState>>,
pub git_review_in_progress: AtomicBool,   // suppresses the watcher's
                                           // reindex thrash while we
                                           // shuffle files into the mirror
```

`CollectionGitState` holds last-fetch timestamp, outgoing/pending
counts, and the pending-review summary. It is what powers the status
bar badge and the collection sidebar indicator.

### 3.3 Events (`src-tauri/src/events/mod.rs`)

```rust
GitFetchStarted { collection: CollectionId }
GitFetchCompleted { collection: CollectionId, incoming: usize }
GitReviewPending { collection: CollectionId, count: usize }
GitReviewDecisionRecorded { collection: CollectionId, commit: String, file: PathBuf, decision: ReviewDecision }
GitPushStarted { collection: CollectionId }
GitPushCompleted { collection: CollectionId, pushed: usize }
GitCredentialNeeded { remote: String, kind: CredentialKind }
GitError { collection: Option<CollectionId>, message: String }
```

Frontend events on the same names: `git:fetch-started`, etc.

### 3.4 Notebox → mirror file movement

All copies of incoming files into the working notebox flow through
`NoteboxStorage` so the file watcher sees normal writes and reindexes
naturally. Copies in the *other* direction (working → mirror) read
through `NoteboxStorage` but write into `.inkycap/git/…` directly,
because that path is not the user's content.

`git_review_in_progress` is held for the duration of an apply so a
batch of file writes doesn't cause repeated partial reindex passes.

---

## Phase 4 — Frontend

### 4.1 Types (`src/lib/types.ts`) and IPC wrappers (`src/lib/ipc.ts`)

Typed mirrors of all the structs above. Nothing about git is allowed
to leak into the frontend as `any`.

### 4.2 Store (`src/stores/git.ts`)

Granular signals:

- `gitEnvironment` — backend availability and selection
- `collectionGitState(collectionPath)` — per-collection store, derived
  lazily so collections without git config have no cost
- `pendingReviews()` — flat list across all linked collections for the
  global review entry point

The store listens to git events and emits derived signals; no
polling. (The original plan called for a 30-second poll — drop it.)

### 4.3 Review panel

A new right-panel tab, mounted in `RightPanel.tsx`, surfaced
whenever any collection has pending reviews. Layout:

- Header: collection name, source commit summary, "X files to review"
- Per-file row: file path, change type (added / modified / deleted),
  a side-by-side or inline diff toggle, decision controls
- Decision controls:
  - **Accept** — apply as-is
  - **Accept with edits** — opens an inline editor; on save, the
    user's version is what lands
  - **Reject** — opens a small composer that demands a rationale
    (text + optional `#review-reject(rationale: …)` body)
  - **Annotate without deciding** — adds a `#review(...)` block to
    the incoming version (visibility: private | shared) so the user
    can leave a note on a change before committing to a decision
- Footer: "Apply all decided files" / "Stop and resume later"

The diff itself is rendered by a CodeMirror 6 merge view (existing
upstream extension, no new heavy dep). Visual-mode rendering of
diffs is out of scope for v1; the diff view is source-mode-only.

### 4.4 Status bar

Add a single indicator to `StatusBar.tsx`:

- Hidden entirely when no collection is linked.
- Otherwise: a dot with state — clean / outgoing / pending-review /
  syncing / error.
- Click opens a popover: per-collection status, "Fetch all linked
  collections", entry into the review panel.

### 4.5 Settings UI

A new "Git" tab in `SettingsPanel.tsx`:

1. Backend selector (Git2 default; System git if detected)
2. Default author name + email
3. Manage credentials (host, kind, last used; saved-credential rows
   with forget buttons)
4. Auto-fetch interval (0 = manual; 5 / 15 / 60 minutes)
5. Notebox-wide sync (collapsed advanced section)

Per-collection settings live in the **collection panel**, not the
global Settings dialog:

1. Remote URL + branch
2. Reviewer identity override
3. Include adjacent files toggle
4. "Require review on pull" toggle (default on)
5. Link / unlink / re-link buttons
6. Push / fetch buttons + last-action timestamps

### 4.6 Command palette entries

Discoverable, low-traffic:

- "Git: link this collection to a remote…"
- "Git: clone a remote into a new collection…"
- "Git: fetch changes for current collection"
- "Git: fetch all linked collections"
- "Git: push current collection…"
- "Git: review pending changes…"
- "Git: set `gitcollection` for this note…"
- "Git: diagnose sync issues"
- "Git: open rejection log"

---

## Phase 5 — Notebox-wide sync (optional, demoted)

The original plan's auto-commit + auto-push + status-bar-as-headline
pattern stays available as an opt-in, off by default. Implementation
mostly survives:

- `auto_commit.rs` subscribes to the event bus, debounces edits,
  commits to a single notebox-wide git repo at the notebox root.
- The notebox-wide `.gitignore` covers `.inkycap/packages/`,
  `.inkycap/git/`, `.inkycap/cache.sqlite`, `.inkycap/search.bin`, and
  the rest of the generated noise.
- Conflicts surface in the same review panel as collection conflicts,
  scoped to "notebox sync".

The reason it stays in the plan at all: a writer using InkyCap for
purely personal notes across two laptops still wants this, and it
falls out of the same backend with little extra code. It just isn't
what we sell.

---

## Phase 6 — Future (out of scope for v1)

- Typst-aware semantic merge (collapse trivial whitespace/heading
  reorderings; merge non-overlapping `#note(...)` property edits)
- Visual diff (visual mode on both sides of the diff view)
- Inline comments tied to commit ranges (vs. file-level annotations)
- GPG / signed-commit support
- Branch-aware workflows (proposing changes against a branch other
  than the configured default)
- Server-blind / content-encrypted git transport (git-crypt / age-
  style). Note: HTTPS and SSH transport already encrypt in flight
  via `git2` — this would only add value for users who want their
  forge to be unable to read content at rest, at the cost of the
  forge's web review / search / blame features. Not required for v1.
- LFS for large attachments
- "Full Notebox Sync" as a system collection — a single shared
  filter that covers the whole notebox, plugged into the same
  collection-as-repo machinery. Deferred until the syndication-home
  rule (§2.3) is shipped and proven, since the two features
  interact and ordering matters.

---

## Files to create

|File|Purpose|
|---|---|
|`src-tauri/src/git/mod.rs`|Module root|
|`src-tauri/src/git/backend.rs`|`GitBackend` trait + both impls|
|`src-tauri/src/git/auth.rs`|Keyring-backed credential store; libssh2 auth callbacks|
|`src-tauri/src/git/mirror.rs`|Mirror-worktree management; collection-id derivation|
|`src-tauri/src/git/review.rs`|Pending/decision staging, `decisions.yaml` I/O|
|`src-tauri/src/git/diff.rs`|`FileChange` / `FileSelection` types, hunk extraction|
|`src-tauri/src/git/notebox_sync.rs`|Optional whole-notebox auto-sync (Phase 5)|
|`src-tauri/src/git/diagnose.rs`|"Diagnose sync issues" scanner (§2.8); shared "sync-diagnostics" log channel|
|`src-tauri/src/commands/git.rs`|Tauri IPC commands|
|`src/stores/git.ts`|Reactive git state|
|`src/components/GitReviewPanel.tsx`|Review UI in the right panel|
|`src/components/GitCollectionPanel.tsx`|Per-collection git settings (sub-panel of collection settings)|

## Files to modify

|File|Change|
|---|---|
|`src-tauri/src/settings.rs`|Add `GitSettings` (incl. `NoteboxWideSyncSettings`) to `UserSettings`|
|`src-tauri/src/state.rs`|Add `git_backend`, `git_collection_states`, `git_review_in_progress` to `AppState`|
|`src-tauri/src/events/mod.rs`|Add git event variants|
|`src-tauri/src/commands/mod.rs`|Register git commands module|
|`src-tauri/src/commands/notebox.rs`|Initialise git_backend on notebox open; populate per-collection state|
|`src-tauri/src/commands/collections.rs`|Surface `CollectionGit` field through existing read/write paths|
|`src-tauri/src/collection_parser/model.rs`|Add `CollectionGit` and `git: Option<CollectionGit>`|
|`src-tauri/src/property_types.rs`|Add `"gitcollection"` to `SYSTEM_PROPERTY_KEYS` and `builtin_property_type` (PropertyType::Text). System-reserved so users can't reassign its type.|
|`src-tauri/src/storage/local.rs`|Audit / ensure `LocalNoteboxStorage` writes use the atomic-rename pattern (tmp file → fsync → rename); add if missing — see §2.8 safety nets|
|`src-tauri/src/storage/traits.rs`|Document the "all writes through NoteboxStorage" invariant in the trait doc-comment|
|`src-tauri/src/watcher/`|Debug-build assertion (`#[cfg(debug_assertions)]`) that flags writes to the notebox tree which don't correlate to a recent NoteboxStorage call — catches drift in development without runtime cost in release|
|`src-tauri/src/scanner/` or wherever the indexer debounce lives|Add the rolling-rate-based debounce-window multiplier (§2.8 safety net #5); raw watcher rate, no source classification|
|`src-tauri/src/backup/`|Add `.inkycap/git/` to the backup exclusion list alongside the existing cache/search/bin exclusions|
|`src-tauri/src/lib.rs`|Register git commands with Tauri|
|`src-tauri/src/link_index/…`|Index `<inkycap-review>` / `<inkycap-review-reject>` labels|
|`src-tauri/Cargo.toml`|Add `git2`, `keyring`|
|`inkycap-notebox/lib.typ`|Add `#review` and `#review-reject` primitives|
|`src/lib/types.ts`|Add git TypeScript types|
|`src/lib/ipc.ts`|Add git IPC wrappers|
|`src/components/SettingsPanel.tsx`|Add "Git" tab|
|`src/components/RightPanel.tsx`|Mount `GitReviewPanel` when there are pending reviews|
|`src/components/StatusBar.tsx`|Add sync state indicator (hidden when no linked collection)|
|`src/components/CommandPalette.tsx`|Register the git command entries|

## Error handling

`InkyCapError::Git(GitErrorKind, String)` with structured kinds —
`NoBackend`, `RemoteUnreachable`, `AuthFailed`, `NotFastForward`,
`Conflict`, `LocalChangesPresent`, `Other`. Frontend maps each to an
actionable toast: "Authentication failed — open Git settings to
update your credentials" beats a raw libgit2 error.

## Dependencies

- `git2` — primary backend
- `keyring` — OS-native credential storage
- (Frontend) the upstream `@codemirror/merge` extension for diff view

No telemetry libraries. No HTTP client beyond what `git2` brings.

---

## Verification

1. **Default flow without git installed.** On a machine with no `git`
   on PATH, link a collection to a fresh Codeberg repo, push initial
   content, fetch on a second machine, review, accept all, edit one
   note, push back, review on the first machine.
2. **Reject with rationale.** Modify a note on machine B; on machine
   A, reject the change with a rationale; verify the rejection
   appears in the rejection log note in plain Typst; verify
   `decisions.yaml` records it; push back; verify machine B sees the
   rejection.
3. **Annotate without deciding.** Leave a private `#review` and a
   shared `#review` on an incoming change; verify the private one
   does not leave the local notebox on push; verify the shared one
   does.
4. **System git backend parity.** Repeat (1)–(3) with the system git
   backend selected; verify SSH agent–based auth works end to end.
5. **Conflict.** Make conflicting edits on two machines; verify the
   conflict surfaces in the review panel with both versions visible
   and a "use mine / use theirs / hand-merge" choice; verify the
   merge commit lands cleanly.
6. **Notebox-wide sync (opt-in).** Enable Phase 5; verify auto-commit
   debouncing batches edits; verify `.inkycap/git/` and friends are
   correctly excluded.
7. **No working-copy corruption on cancel.** Cancel a fetch mid-flight,
   cancel a push mid-flight, force-quit during a review apply; verify
   the working notebox is never left in a half-applied state (the
   mirror is the source of truth; the working copy is only touched
   after a complete apply).
8. **Indexer interaction.** During an apply, verify the file watcher
   sees a coherent burst of writes (not partial files); verify link
   index / search / property index converge to the post-apply state.
9. **Self-contained binary.** Build a release binary on a clean VM
   with no git installed; verify all of (1)–(7) still work using the
   bundled Git2 backend.
10. **Filter-based membership end-to-end.** Create a tag-filtered
    collection (`tag.contains("shared")`); link it to a remote;
    verify only tagged notes push; remove the tag from a note and
    push again; verify the push-confirm UI surfaces it as "no longer
    in this collection" and the user can deselect the deletion.
11. **Syndication home — ambiguous case.** Create two linked
    collections whose filters both match a single note (no
    `gitcollection` set); attempt to push; verify push refuses and
    the UI prompts the user to set `gitcollection`; set it; verify
    push proceeds and pushes only to that collection's repo.
12. **Folder-filtered clone.** Clone a remote into a new folder;
    verify the generated `.collection` uses
    `file.folder.startswith(...)` as its filter; verify notes
    landing in that folder appear in the collection without any
    `#note(collection:)` mutation.
13. **Backup exclusion.** Run a backup with a linked collection
    active; verify `.inkycap/git/` is absent from the resulting
    archive; verify restore reconstructs the collection correctly
    after a re-fetch from the remote.
14. **External sync coexistence (recommended setup).** Set up
    Syncthing on a notebox with `.inkycap/` excluded; verify the
    working notebox files sync via Syncthing while a linked
    collection's git operations still work; verify "Fetch all
    linked collections" picks up changes the user pushed from a
    second machine.
15. **External sync coexistence (misconfigured / safety nets).**
    Repeat (14) **without** excluding `.inkycap/`. Verify: (a) the
    mirror-integrity check on open detects the corrupted mirror
    and offers to re-clone; (b) atomic writes prevent torn reads
    of `.typ` files during simultaneous Syncthing + InkyCap save;
    (c) "Git: diagnose sync issues" reports the foreign artifacts
    inside `.inkycap/` with actionable findings; (d) with the
    "External sync is active" setting enabled,
    `git_collection_fetch` waits for quiescence before populating
    review staging; (e) the indexer's debounce window scales up
    during a Syncthing burst and the post-burst reindex runs once,
    not 200 times.
16. **Diagnostics kill-switch isolation.** With every entry in the
    Git settings "Diagnostics" section disabled, verify that all
    git operations (clone / link / fetch / review / push) still
    work; the safety nets are augmentations, not prerequisites.
17. **Debug-build write-seam assertion.** In a debug build, write
    to a file in the notebox tree via a path that bypasses
    `NoteboxStorage` (a test harness only); verify the assertion
    fires. Verify the same write in a release build is silent.
