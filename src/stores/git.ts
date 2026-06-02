// Git collaboration store (Phase 5: the Sync model).
//
// Holds the reactive state for the per-notebox collaboration surface: the git
// status summary, the last sync outcome (digest of what landed + any conflicts
// awaiting resolution), and a syncing flag. The two user gestures are Sync
// (pull + merge + push) and Check for updates (a read-only fetch that reports
// how far behind the remote is, without pulling files in); when a Sync's merge
// conflicts the outcome is `paused` and the conflicted notes are staged as
// inline suggestions to resolve, then finalized.
//
// Deliberately does NOT import `./notebox` — `notebox.ts` imports this store to
// reset it on a notebox switch, and a back-import would be a cycle.
// "Collaborative" is derived from `noteboxSettings.git`, which `settings.ts`
// owns; that module does not import this one.

import { createSignal } from "solid-js";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import type {
  GitStatusSummary,
  GitSyncOutcome,
  GitUnresolvedEntry,
  GitSinceSyncEntry,
  GitIdentity,
} from "../lib/types";
import { noteboxSettings, loadNoteboxSettings } from "./settings";
import { invalidateEditorCacheForPath } from "./tabs";
import { awaitAllPendingWrites } from "./editor-writes";
import { showToast, toastError } from "./toasts";
import { t } from "../lib/i18n";
import {
  onGitStatus,
  onGitFetchStarted,
  onGitFetchCompleted,
  onGitPushStarted,
  onGitPushCompleted,
  onGitError,
  onGitReconnectable,
  onFileChanged,
  onFileCreated,
  onFileDeleted,
} from "../lib/events";
import type { GitReconnectablePayload } from "../lib/events";

const [gitStatus, setGitStatus] = createSignal<GitStatusSummary | null>(null);
/** The last completed sync outcome — drives the digest ("what landed"). */
const [syncOutcome, setSyncOutcome] = createSignal<GitSyncOutcome | null>(null);
const [gitSyncing, setGitSyncing] = createSignal(false);
/** The notebox is configured for collaboration (has a git config) but there is
 *  no local git repository behind it — e.g. the `.git` dir was deleted, or the
 *  notebox settings travelled to a machine where the repo was never cloned.
 *  The panel offers re-initialization in this state instead of the sync view. */
const [repoMissing, setRepoMissing] = createSignal(false);
/** Last background error message (from a `notebox:git-error` event). Cleared
 *  when a new operation starts. Foreground errors are toasted by the action. */
const [gitError, setGitError] = createSignal<string | null>(null);
/** Set when the open notebox is a git repo with a remote but carries no
 *  collaboration config — the panel offers a one-click reconnect (deriving the
 *  remote/branch from git) instead of a blank setup form. Null otherwise. */
const [reconnectable, setReconnectable] = createSignal<GitReconnectablePayload | null>(null);
/** Incoming commits the last "Check for updates" found on the remote but did not
 *  pull (0 = up to date / not checked). Drives the "N updates available — Sync"
 *  notice; cleared by a Sync (which brings them in) and on notebox switch. */
const [incomingCount, setIncomingCount] = createSignal(0);
/** Whether the collaboration panel's "Manage collaboration" section is expanded.
 *  Lifted to the store so the Settings › Configure entry point can open the panel
 *  with it already expanded. Reset (collapsed) on a notebox switch. */
const [manageOpen, setManageOpen] = createSignal(false);
/** Whether the "Import/export changes" / "Sync changes" action section is
 *  expanded. Collapsed by default and auto-collapsed by the store once a gesture
 *  completes (sync / export / import / finalize / discard), so the panel returns
 *  to the calm status + digest view. Lifted to the store so those gesture
 *  actions can fold it back. Reset (collapsed) on a notebox switch. */
const [actionsOpen, setActionsOpen] = createSignal(false);
/** Per-machine "bundle Typst packages on share" preference for the open
 *  notebox (off by default). When on, Sync push and package export first
 *  vendor the notebox's packages into it. Loaded on open. */
const [bundlePackages, setBundlePackagesSignal] = createSignal(false);

/** Notes across the notebox that still carry unresolved `#suggestion(...)`
 *  tracked changes awaiting an accept/reject decision. This is the persistent,
 *  notebox-wide counterpart of the per-open-file Changes & History badge: after
 *  a user merges incoming changes but never resolves the individual
 *  suggestions, they linger here regardless of which file is open or whether
 *  the post-sync digest was dismissed. Refreshed on notebox open, after a
 *  pull/finalize, and (debounced) whenever the working tree changes. */
const [unresolvedFiles, setUnresolvedFiles] = createSignal<GitUnresolvedEntry[]>([]);
export { unresolvedFiles };

/** Total open suggestions across the notebox — the status-bar attention cue. */
export function unresolvedCount(): number {
  return unresolvedFiles().reduce((n, f) => n + f.count, 0);
}

/** Re-query the notebox-wide unresolved-suggestion list. Cheap — the backend
 *  reads cached per-note counts, not a recompile. Clears when not collaborative. */
export async function refreshUnresolved(): Promise<void> {
  if (!collaborative()) {
    setUnresolvedFiles([]);
    return;
  }
  try {
    setUnresolvedFiles(await ipc.gitUnresolvedChanges());
  } catch (err) {
    console.error("git unresolved-changes refresh failed:", err);
  }
}

/** Notes the most recent sync changed, relative to the recorded pre-sync
 *  baseline — the merge-first "review what landed" surface. Take-theirs
 *  (conflicted) entries sort first. This is the primary notebox-wide
 *  collaboration indicator: a Sync / import folds incoming changes straight in
 *  (the model never pauses), and the user reviews and reverts here afterwards.
 *  Refreshed on notebox open, after a pull, and (debounced) on working-tree
 *  changes (a revert drops the note's hunks, so the list self-clears). */
const [changesSinceSync, setChangesSinceSync] = createSignal<GitSinceSyncEntry[]>([]);
export { changesSinceSync };

/** Bumped whenever the changes-since-sync list is re-queried (notebox open, a
 *  pull, or a debounced working-tree change). The per-note incoming-diff view in
 *  the Annotations pane depends on it to refetch its hunks after the open note is
 *  edited or reverted — its baseline-vs-working diff changes even when the
 *  HEAD-based `changesSinceSync` list does not. */
const [syncReviewVersion, setSyncReviewVersion] = createSignal(0);
export { syncReviewVersion };

/** Number of notes changed since the last sync — the status-bar attention cue. */
export function changesSinceSyncCount(): number {
  return changesSinceSync().length;
}

/** Re-query the changes-since-last-sync list. Cheap — a tree-to-tree git diff
 *  against the recorded baseline, no recompile. Clears when not collaborative. */
export async function refreshChangesSinceSync(): Promise<void> {
  if (!collaborative()) {
    setChangesSinceSync([]);
    return;
  }
  try {
    setChangesSinceSync(await ipc.gitChangesSinceSync());
  } catch (err) {
    console.error("git changes-since-sync refresh failed:", err);
  } finally {
    // Signal per-note diff views to refetch even when the HEAD-based list is
    // unchanged (a local edit moves the working text relative to the baseline).
    setSyncReviewVersion((v) => v + 1);
  }
}

/** Revert one hunk of a note to its pre-sync baseline, then refresh open editors
 *  and the review surfaces. Identified by its current-side line range (from
 *  `gitNoteSyncDiff`). On a stale range the backend rejects and we refetch. */
export async function revertSyncHunk(
  path: string,
  currentStart: number,
  currentEnd: number,
): Promise<void> {
  try {
    await awaitAllPendingWrites();
    await ipc.gitRevertSyncHunk(path, currentStart, currentEnd);
    // The working file changed on disk — reload mounted editors, drop stale
    // caches of inactive tabs, then refresh the review lists (the reverted hunk
    // drops out of the diff).
    invalidateEditorCacheForPath(path);
    document.dispatchEvent(new CustomEvent("inkycap:notebox-synced"));
    await refreshStatus();
    void refreshChangesSinceSync();
  } catch (err) {
    toastError(t("git.toast.revertFailed"), err);
  }
}

/** Revert a whole note to its pre-sync baseline (or delete it when the sync
 *  added it), then refresh open editors and the review surfaces. */
export async function revertNoteSinceSync(path: string): Promise<void> {
  try {
    await awaitAllPendingWrites();
    await ipc.gitRevertNoteSinceSync(path);
    invalidateEditorCacheForPath(path);
    document.dispatchEvent(new CustomEvent("inkycap:notebox-synced"));
    await refreshStatus();
    void refreshChangesSinceSync();
  } catch (err) {
    toastError(t("git.toast.revertFailed"), err);
  }
}

/** True when the open notebox carries a git config (and so should show the
 *  collaboration toolbar button + status indicator). */
export function collaborative(): boolean {
  return noteboxSettings.git != null;
}

/** True when the open notebox collaborates by offline package handoff rather
 *  than a hosted git server — an empty `remote` (see
 *  `NoteboxGitConfig::is_package_mode` on the backend). The panel then offers
 *  Export / Import package instead of Sync / Check for updates. */
export function packageMode(): boolean {
  return collaborative() && (noteboxSettings.git?.remote ?? "").trim() === "";
}

// ─────────────────────────── Event wiring ──────────────────────────────────

let gitListenersReady = false;
const unlisteners: UnlistenFn[] = [];

// A working-tree change (a save, a restore, a create/delete) means the git
// status — dirty / unpushed — is now stale. Refresh it, debounced so a burst of
// saves coalesces into one query. Only meaningful for a collaborative notebox.
let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleStatusRefresh(): void {
  if (!collaborative()) return;
  clearTimeout(statusRefreshTimer);
  statusRefreshTimer = setTimeout(() => {
    void refreshStatus();
    // A save may have resolved (or introduced) a suggestion — keep the
    // notebox-wide count in step. The incremental indexer only re-scans the
    // changed file, so the cache-backed query stays cheap.
    void refreshUnresolved();
    // A working-tree change also moves a note toward (an edit) or away from (a
    // revert back to baseline) its pre-sync state — keep the review list current.
    void refreshChangesSinceSync();
  }, 600);
}

/** Subscribe to the backend git events once per process. Called from
 *  `openNotebox`; idempotent. */
export async function ensureGitListeners(): Promise<void> {
  if (gitListenersReady) return;
  gitListenersReady = true;
  unlisteners.push(
    await onGitStatus((p) => setGitStatus(p.status)),
    await onGitFetchStarted(() => {
      setGitError(null);
      setGitSyncing(true);
    }),
    await onGitFetchCompleted(() => setGitSyncing(false)),
    await onGitPushStarted(() => setGitSyncing(true)),
    await onGitPushCompleted(() => {
      setGitSyncing(false);
      void refreshStatus();
    }),
    // Background error (e.g. an auth failure surfaced mid-operation). Record it
    // and drop the syncing state; the awaiting action also rejects and toasts,
    // so this listener does not double-toast.
    await onGitError((message) => {
      setGitError(message);
      setGitSyncing(false);
    }),
    // Keep the status fresh as the working tree changes (saves, restores, file
    // create/delete) — otherwise the chip can read "Up to date" after an edit.
    await onFileChanged(() => scheduleStatusRefresh()),
    await onFileCreated(() => scheduleStatusRefresh()),
    await onFileDeleted(() => scheduleStatusRefresh()),
    // A repo-with-remote that has no collaboration config → offer to reconnect.
    await onGitReconnectable((p) => setReconnectable(p)),
  );
}

/** Reset per-notebox sync state on a notebox switch and re-query status.
 *  Called from `openNotebox` after the new notebox's settings have loaded. */
export async function resetGitOnOpen(): Promise<void> {
  setSyncOutcome(null);
  setGitError(null);
  setGitSyncing(false);
  setGitStatus(null);
  setRepoMissing(false);
  // Cleared here; the backend re-emits notebox:git-reconnectable on open if the
  // (now non-collaborative) notebox is a repo with a remote.
  setReconnectable(null);
  setIncomingCount(0);
  setManageOpen(false);
  setActionsOpen(false);
  setBundlePackagesSignal(false);
  setUnresolvedFiles([]);
  setChangesSinceSync([]);
  if (collaborative()) {
    await refreshStatus();
    void refreshUnresolved();
    void refreshChangesSinceSync();
    // Load the per-machine bundle-packages preference for this notebox.
    setBundlePackagesSignal(await ipc.gitGetBundlePackages().catch(() => false));
  }
}

// ─────────────────────────── Actions ───────────────────────────────────────

/** Re-query the git status for the open notebox (no-op feel when not
 *  collaborative — sets `null`). */
export async function refreshStatus(): Promise<void> {
  try {
    const status = await ipc.gitStatus();
    setGitStatus(status);
    // Collaborative config present but the backend reports no status ⇒ the repo
    // is gone (or was never cloned). git_status only returns null for a
    // collaborative notebox when it isn't a git repo, so this is unambiguous here.
    setRepoMissing(collaborative() && status === null);
  } catch (err) {
    console.error("git status refresh failed:", err);
  }
}

/** Set up (or re-configure) collaboration for the open notebox, then refresh
 *  the settings store so the toolbar button appears. Throws on failure so the
 *  caller (setup form) can surface a field-level error. */
export async function setupCollaboration(args: {
  remote: string;
  branch?: string;
  identityName?: string;
  identityEmail?: string;
  httpsToken?: string;
}): Promise<void> {
  const result = await ipc.gitSetupCollaboration(args);
  await loadNoteboxSettings();
  setGitStatus(result.status);
  setRepoMissing(false);
  setReconnectable(null);
}

/** Set up the open notebox for server-less collaboration (offline package
 *  handoff — no remote), then refresh settings so the panel switches to package
 *  gestures. Throws on failure so the setup form can surface it. */
export async function setupPackageHandoff(args: {
  branch?: string;
  identityName?: string;
  identityEmail?: string;
}): Promise<void> {
  const result = await ipc.gitSetupPackageHandoff(args);
  await loadNoteboxSettings();
  setGitStatus(result.status);
  setRepoMissing(false);
  setReconnectable(null);
}

/** Reconnect a notebox that's already a git repo with a remote but lost (or
 *  never wrote) its collaboration config — adopts the remote/branch from git.
 *  Throws on failure so the caller can surface it. */
export async function reconnectCollaboration(): Promise<void> {
  const result = await ipc.gitReconnectCollaboration();
  await loadNoteboxSettings();
  setGitStatus(result.status);
  setRepoMissing(false);
  setReconnectable(null);
}

/** Apply a completed sync outcome to the store + surface a non-blocking message
 *  summarizing what happened. Shared by Sync and package import. */
function applyOutcome(outcome: GitSyncOutcome): void {
  setSyncOutcome(outcome);
  // A Sync reconciles with the remote we just fetched, so any "updates
  // available" notice from an earlier Check is now resolved.
  setIncomingCount(0);
  // A pull (fast-forward, merge, or finalize) rewrote notes on disk. Tell open
  // editors to reload from disk so their buffers aren't stale — clean buffers
  // pick up the merged content; dirty buffers keep their unsaved edits. (Tree /
  // index refresh is driven separately by refreshStatus + the file watcher.)
  if (outcome.pulled) {
    document.dispatchEvent(new CustomEvent("inkycap:notebox-synced"));
    // A pull/finalize wrote incoming suggestions into notes on disk — recompute
    // the notebox-wide unresolved count so the status-bar cue lights up even if
    // the user dismisses the digest without resolving anything.
    void refreshUnresolved();
    // The sync recorded a fresh baseline and folded incoming changes in —
    // populate the "changes since last sync" review list for the merge-first
    // revert-later flow.
    void refreshChangesSinceSync();
  }
  if (outcome.rejected) {
    showToast("info", t("git.toast.syncRejected"));
  } else if (outcome.upToDate) {
    showToast("info", t("git.toast.upToDate"));
  } else if (outcome.pulled || outcome.pushed) {
    const landed = outcome.digest.length;
    if (outcome.pushed && landed === 0) {
      showToast("success", t("git.toast.pushed"));
    } else if (landed > 0) {
      showToast(
        "success",
        landed === 1
          ? t("git.toast.syncedOne")
          : t("git.toast.synced", { n: landed }),
      );
    } else {
      showToast("success", t("git.toast.synced", { n: landed }));
    }
  }
}

/** Sync: pull + merge incoming changes, then push. Pauses on conflicts. */
export async function sync(): Promise<void> {
  setGitSyncing(true);
  try {
    // Let in-flight editor saves land first so the sync's "commit my edits"
    // step sees the latest content rather than a half-written file.
    await awaitAllPendingWrites();
    const outcome = await ipc.gitSync();
    applyOutcome(outcome);
    setActionsOpen(false);
    await refreshStatus();
  } catch (err) {
    toastError(t("git.toast.syncFailed"), err);
  } finally {
    setGitSyncing(false);
  }
}

/** Check for updates: a read-only peek — fetch and report how far behind the
 *  remote is, without pulling files into the notebox. Sets the "N updates
 *  available" notice; the user then Syncs to bring them in. */
export async function checkUpdates(): Promise<void> {
  setGitSyncing(true);
  try {
    const result = await ipc.gitCheckUpdates();
    setIncomingCount(result.behind);
    if (result.behind > 0) {
      showToast(
        "info",
        result.behind === 1
          ? t("git.toast.oneUpdateAvailable")
          : t("git.toast.updatesAvailable", { n: result.behind }),
      );
    } else {
      showToast("info", t("git.toast.noUpdates"));
    }
    await refreshStatus();
  } catch (err) {
    toastError(t("git.toast.checkFailed"), err);
  } finally {
    setGitSyncing(false);
  }
}

/** Export the open notebox (with its full git history) to a package file.
 *  Commits any pending edits first, so the package is current. `password`
 *  enables AES-256; the recipient needs it out-of-band. If the notebox is set
 *  to bundle packages, the Typst packages it uses are vendored in first so they
 *  travel with the export. */
export async function exportPackage(dest: string, password?: string): Promise<void> {
  setGitSyncing(true);
  try {
    // Let in-flight saves land so the auto-commit packages the latest content.
    await awaitAllPendingWrites();
    const res = await ipc.gitExportPackage(dest, password);
    showToast("success", t("git.toast.exported", { path: res.path }));
    if (res.vendoredPackages.length > 0) {
      showToast(
        "success",
        t("git.toast.packagesVendored", { count: res.vendoredPackages.length }),
      );
    }
    if (res.unresolvedPackages.length > 0) {
      showToast(
        "warning",
        t("git.toast.packagesUnresolved", {
          specs: res.unresolvedPackages.join(", "),
        }),
      );
    }
    setActionsOpen(false);
    // A dirty notebox was committed during export — refresh the status chip.
    await refreshStatus();
  } catch (err) {
    toastError(t("git.toast.exportFailed"), err);
  } finally {
    setGitSyncing(false);
  }
}

/** Import a received package into the open notebox, reconciling histories
 *  through the same engine as Sync (no push). Routes the outcome through
 *  `applyOutcome` with `pushGesture = false`, so a conflict pauses into the same
 *  ConflictView and finalizes without pushing. */
export async function importPackage(archive: string, password?: string): Promise<void> {
  setGitSyncing(true);
  try {
    await awaitAllPendingWrites();
    const outcome = await ipc.gitImportPackage(archive, password);
    applyOutcome(outcome);
    setActionsOpen(false);
    await refreshStatus();
  } catch (err) {
    toastError(t("git.toast.importFailed"), err);
  } finally {
    setGitSyncing(false);
  }
}

/** Dismiss the post-sync digest (the non-blocking "what landed" summary). */
export function dismissDigest(): void {
  setSyncOutcome(null);
}

/** Toggle the per-machine "bundle Typst packages on share" preference. Enabling
 *  vendors current packages immediately and reports what was bundled (or what
 *  couldn't be located). Optimistic; reverts + toasts on failure. */
export async function setBundlePackages(enabled: boolean): Promise<void> {
  setBundlePackagesSignal(enabled);
  try {
    const res = await ipc.gitSetBundlePackages(enabled);
    if (enabled && res.vendored.length > 0) {
      showToast(
        "success",
        t("git.toast.packagesVendored", { count: res.vendored.length }),
      );
    }
    if (enabled && res.unresolved.length > 0) {
      showToast(
        "warning",
        t("git.toast.packagesUnresolved", { specs: res.unresolved.join(", ") }),
      );
    }
  } catch (err) {
    setBundlePackagesSignal(!enabled);
    toastError(t("git.bundle.toggleFailed"), err);
  }
}

/** Store an HTTPS token for the remote host (re-auth). Throws on failure. */
export async function signIn(token: string): Promise<void> {
  await ipc.gitSignIn(token);
}

/** Stop collaborating; refresh settings so the toolbar button disappears. */
export async function disableCollaboration(): Promise<void> {
  await ipc.gitDisableCollaboration();
  await loadNoteboxSettings();
  setSyncOutcome(null);
  setGitStatus(null);
}

/** The commit identity configured for this notebox's remote, if any. */
export async function getIdentity(): Promise<GitIdentity | null> {
  try {
    return await ipc.gitGetIdentity();
  } catch {
    return null;
  }
}

/** The identity InkyCap would stamp on commits (the per-notebox choice, else the
 *  git-config fallback) — for pre-filling the identity fields so the author is
 *  visible and editable rather than mysteriously blank. */
export async function getDefaultIdentity(): Promise<GitIdentity | null> {
  try {
    return await ipc.gitDefaultCommitIdentity();
  } catch {
    return null;
  }
}

/** Set the commit identity for this notebox's remote. */
export async function setIdentity(name: string, email: string): Promise<void> {
  await ipc.gitSetIdentity(name, email);
}

export {
  gitStatus,
  syncOutcome,
  gitSyncing,
  gitError,
  repoMissing,
  reconnectable,
  incomingCount,
  manageOpen,
  setManageOpen,
  actionsOpen,
  setActionsOpen,
  bundlePackages,
};
