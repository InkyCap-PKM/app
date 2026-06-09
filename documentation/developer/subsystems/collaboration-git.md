# Collaboration and sync (git)

> **Audience:** developers working on InkyCap's collaboration subsystem.
> **Status:** living reference. Describes the **merge-first** model that is
> current; earlier staged-suggestion designs are superseded and not documented
> here.

InkyCap collaborates by treating the **whole notebox as a git repository**. A
notebox is plain Typst plus a documented `.inkycap/` layout, so git is a natural
fit: every note is a text file, every change is a commit, and history is the
audit trail. The subsystem wraps **libgit2** (via the `git2` crate, vendored, so
no system `git` is required) and adds a collaboration model designed for writers
rather than programmers.

The defining choice is **merge-first**: a sync never pauses to make you resolve
conflicts before you can keep working. It always completes, taking the other
side's version on any overlap, and gives you a calm, after-the-fact review pane
to revert anything you did not want. Conflicts become a *review task*, not a
*blocking modal*. Nothing is lost: a revert is just another ordinary edit, and
the overwritten version stays in history.

---

## 1. Module layout (`src-tauri/src/git/`)

| File | Responsibility |
|---|---|
| `mod.rs` | Module overview; states the merge-first contract (`commit local, fetch, merge taking theirs on overlap, push`; review and revert happen later in the Changes pane). |
| `backend.rs` | The **only** place that talks to libgit2. A thin synchronous `git2` wrapper: open/init, remotes, status (ahead/behind/dirty), 3-way merge, fetch/push, stage/commit, checkout, history, tree-to-tree and tree-to-workdir diffs. |
| `sync_review.rs` | Pure line-level hunk engine for "changes since last sync": `diff_hunks`, `revert_hunk`, `drop_structural_hunks`. No I/O. |
| `json_merge.rs` | Structured 3-way merge for `.inkycap/settings.json`, key by key (not whole-file pick). |
| `auth.rs` | Credential resolution for fetch/push and commit identity. Nothing secret is stored in the repo. |
| `package.rs` | Offline package handoff: zip a notebox's whole `.git` directory, optionally AES-256 encrypted. |

The IPC commands that drive all of this live in
[`src-tauri/src/commands/git.rs`](../../../src-tauri/src/commands/git.rs).

---

## 2. The merge-first sync (`run_sync`)

`run_sync(root, git, push)` is the core. It never pauses:

1. **Commit local edits** if the working tree is dirty, producing local tip `M`.
2. **Fetch** the remote tip `T`.
3. **Decide:**
   - Nothing incoming (`T` absent, `T == M`, or `M` is already a descendant of
     `T`): optionally push, done.
   - Local branch unborn and diverged: **fast-forward** to `T` (a pure pull).
   - Genuinely diverged histories: **3-way merge**.
4. **Merge:**
   - Clean merge: write the merge commit, checkout, push.
   - Conflicts: apply all cleanly-merged files, then for each conflicted path
     **take theirs** (overwrite with the incoming blob, or delete if they
     deleted it). Commit the merge with both parents `[M, T]` and push. The
     merge commit descends from `T`, so the push fast-forwards.

`settings.json` is the one exception to blind take-theirs: it goes through the
**structured JSON merge** (below) so two people changing *different* settings
keys both keep their changes.

Because notebox content is text notes (never binaries InkyCap emits), there is
no special binary-conflict path: take-theirs is always a safe, reviewable
default.

---

## 3. Structured settings merge (`json_merge.rs`)

`three_way(base, mine, theirs)` recurses over the two JSON objects:

- A key changed on only one side, or changed identically on both, **auto-merges**.
- A key changed to *different* values on both sides is a **conflict**, recorded
  with its path and both values; the merged document keeps `mine` until the user
  picks otherwise (`set_at_path` flips a key to `theirs`).
- Arrays and scalars are atomic (no element-level merge).

This is why a teammate enabling a feature and you changing the theme do not
clobber each other: distinct keys merge silently; only a true same-key clash
surfaces.

---

## 4. Changes since last sync, and revert (`sync_review.rs`)

Merge-first means the review happens *after* the merge. The subsystem records,
in `local.json`, the local HEAD from just before the merge (`last_sync_oid`) and
the list of paths it took theirs on (`last_sync_conflicted`). The Changes pane
reads these:

- `git_changes_since_sync()` lists notes changed between `last_sync_oid` and
  HEAD, conflicted ones first (these are where your edit may have been
  overwritten).
- `git_note_sync_diff(path)` returns two hunk diffs for one note: **incoming**
  (`last_sync_oid` to HEAD, what the merge brought in) and **local** (HEAD to
  working tree, your edits since). The notebox import preamble is filtered out of
  both by `drop_structural_hunks()` so structural lines do not clutter the view.
- `git_revert_sync_hunk(path, start, end)` reverts one hunk back to baseline via
  `revert_hunk()` (with a staleness check if the range no longer matches).
- `git_revert_note_since_sync(path)` reverts a whole note (or deletes it if the
  sync added it).

The hunk engine uses the `similar` crate's Myers diff. It is pure (`&str` in,
values out), which keeps it unit-testable and free of I/O concerns.

---

## 5. Version history

Independent of sync, any note's git history is browsable:

- `git_note_history(path)` returns recent commits (capped), newest first, each
  with short hash, author, timestamp, and message. A commit equal to
  `last_sync_oid` where the merge took theirs is flagged so History can say "this
  is what replaced your edit; click to compare."
- `git_note_version_text(path, commit)` reads the note's content at a past
  commit.
- The frontend `VersionDiffView` shows a **read-only** inline diff (CodeMirror
  `@codemirror/merge` unified view) between HEAD and a chosen version, with a
  Restore action. Restore is non-destructive: it lands the old text as an
  ordinary new edit you then re-sync.

---

## 6. Credentials and identity (`auth.rs`)

Nothing sensitive is committed. Stores are per-installation:

- **HTTPS (primary path).** Username lives in `git-usernames.json` (not secret);
  the password lives in the **OS keychain** (via the `keyring` crate), keyed by
  the normalized remote URL so two repos on one host can hold different
  passwords.
- **SSH (advanced path).** ssh-agent first, then the first default `~/.ssh` key.
- **Commit identity.** Per-notebox identity (in `local.json`) wins, falling back
  to a per-remote store then to git config. Two clones of one notebox can commit
  as different people.

`normalize_remote()` unifies URL spellings (strips scheme, `user@`, `.git`, maps
`git@host:path` to `host/path`) so credentials match regardless of how the
remote was typed. Auth failures surface to the user through `AppEvent`s rather
than blocking the sync.

---

## 7. Offline package mode (`package.rs`)

Collaboration without a server: **package mode** is a notebox whose
`NoteboxGitConfig.remote` is empty.

- `git_export_package(dest, password)` commits pending edits, optionally vendors
  Typst packages, zips the entire `.git` directory (optionally AES-256
  encrypted), and records the shared HEAD in `last_shared_oid` so the status line
  can say "shared" until the next edit.
- `git_import_package(archive, password)` extracts to a temp staging dir, points
  a transient local-path remote at it, and runs the same `run_sync` 3-way merge.
- `git_import_package_as_notebox(...)` clones a package into a brand-new notebox.

`package.rs` defends extraction hard: every entry must live under `.git/`, with
no `..` traversal and no symlinks. This is an untrusted-input boundary (a package
can come from anyone), so treat it accordingly when you change it.

**Package bundling** (the `bundle_packages` flag) vendors the notebox's Typst
packages into `.inkycap/packages/` on each share, so a recipient compiles
offline without fetching from the registry.

---

## 8. What lives in `local.json` (per machine, never synced)

`NoteboxLocalState` (in
[`notebox_settings.rs`](../../../src-tauri/src/notebox_settings.rs)) is the
per-machine state that must **not** travel with the notebox:

| Field | Meaning |
|---|---|
| `git` (`NoteboxGitConfig`) | remote + branch; `None` means "not collaborative on this machine"; empty remote means package mode |
| `git_identity` | per-notebox commit author |
| `last_sync_oid` | local HEAD just before the last merge (baseline for the Changes pane) |
| `last_sync_conflicted` | paths the last merge took theirs on (flagged for priority review) |
| `last_shared_oid` | HEAD at last package export (status without a server ref) |
| `bundle_packages` | vendor Typst packages on share |
| `last_active_file` | last cursor location on this machine |

Keeping all of this out of `settings.json` (which *does* sync) is what prevents
device-specific state from causing merge churn. If you add collaboration state,
decide deliberately which file it belongs in.

---

## 9. Frontend

- `GitCollaborationPanel` has two faces: a setup form (remote, branch, sign-in,
  identity, offline/SSH toggles) and a sync view (status, Sync/Check, the
  incoming digest, the conflicted list).
- `ChangesSinceSyncView` lists changed notes riskiest-first, each expandable to
  hunk-level review and revert.
- `AnnotationsPanel` surfaces incoming changes for conflicted notes inline.
- The status bar and right panel carry a "changes to share" indicator (dirty or
  unpushed in server mode; dirty or HEAD past `last_shared_oid` in package mode).
- State lives in [`src/stores/git.ts`](../../../src/stores/git.ts).

Collaboration is **opt-in per notebox** (Settings) and is off by default.

---

## 10. Key files

| Concern | Path |
|---|---|
| Sync model + all IPC commands | `src-tauri/src/commands/git.rs` |
| libgit2 wrapper | `src-tauri/src/git/backend.rs` |
| Hunk diff/revert | `src-tauri/src/git/sync_review.rs` |
| Settings 3-way merge | `src-tauri/src/git/json_merge.rs` |
| Credentials/identity | `src-tauri/src/git/auth.rs` |
| Package export/import | `src-tauri/src/git/package.rs` |
| Per-machine state | `src-tauri/src/notebox_settings.rs` (`NoteboxLocalState`) |
| Panel + stores | `src/components/GitCollaborationPanel.tsx`, `src/stores/git.ts` |
