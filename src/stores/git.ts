// Git collaboration store (Phase 4 of the notebox-git plan).
//
// Holds the reactive state for the per-notebox collaboration surface: the git
// status summary, the current fetch-and-review session, and a syncing flag.
// Actions wrap the typed IPC bindings; the backend `notebox:git-*` events keep
// the status fresh (and surface background errors) between explicit actions.
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
  GitReviewSession,
  GitReviewItem,
  GitIdentity,
} from "../lib/types";
import { noteboxSettings, loadNoteboxSettings } from "./settings";
import { openTab } from "./tabs";
import { showToast, toastError } from "./toasts";
import { t } from "../lib/i18n";
import {
  onGitStatus,
  onGitFetchStarted,
  onGitFetchCompleted,
  onGitReviewPending,
  onGitConsolidated,
  onGitPushStarted,
  onGitPushCompleted,
  onGitError,
} from "../lib/events";

const [gitStatus, setGitStatus] = createSignal<GitStatusSummary | null>(null);
const [reviewSession, setReviewSession] = createSignal<GitReviewSession | null>(null);
const [gitSyncing, setGitSyncing] = createSignal(false);
/** The notebox is configured for collaboration (has a git config) but there is
 *  no local git repository behind it — e.g. the `.git` dir was deleted, or the
 *  notebox settings travelled to a machine where the repo was never cloned.
 *  The panel offers re-initialization in this state instead of the review view. */
const [repoMissing, setRepoMissing] = createSignal(false);
/** Last background error message (from a `notebox:git-error` event). Cleared
 *  when a new operation starts. Foreground errors are toasted by the action. */
const [gitError, setGitError] = createSignal<string | null>(null);

/** True when the open notebox carries a git config (and so should show the
 *  collaboration toolbar button + status indicator). */
export function collaborative(): boolean {
  return noteboxSettings.git != null;
}

/** Number of changed items in the current review session (the pending badge). */
export function pendingCount(): number {
  return reviewSession()?.items.length ?? 0;
}

// ─────────────────────────── Event wiring ──────────────────────────────────

let gitListenersReady = false;
const unlisteners: UnlistenFn[] = [];

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
    await onGitReviewPending(() => setGitSyncing(false)),
    await onGitConsolidated(() => void refreshStatus()),
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
  );
}

/** Reset per-notebox review state on a notebox switch and re-query status.
 *  Called from `openNotebox` after the new notebox's settings have loaded. */
export async function resetGitOnOpen(): Promise<void> {
  setReviewSession(null);
  setGitError(null);
  setGitSyncing(false);
  setGitStatus(null);
  setRepoMissing(false);
  if (collaborative()) {
    await refreshStatus();
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
}

/** Fetch the remote and stage incoming notes as suggestions. Returns the
 *  session (also stored). Toasts on failure. */
export async function fetchReview(): Promise<GitReviewSession | null> {
  setGitSyncing(true);
  try {
    const session = await ipc.gitFetchReview();
    setReviewSession(session);
    await refreshStatus();
    if (session.upToDate) {
      showToast("info", t("git.toast.upToDate"));
    }
    return session;
  } catch (err) {
    toastError(t("git.toast.fetchFailed"), err);
    return null;
  } finally {
    setGitSyncing(false);
  }
}

/** Open a staged note copy as a reviewable tab (suggestion pills + the
 *  Annotations pane do the resolving). No-op for items without a staged copy
 *  (deletes / binaries). */
export function openStagedNote(item: GitReviewItem): void {
  if (!item.stagedPath) return;
  const base = item.path.split("/").pop() ?? item.path;
  openTab(
    { type: "file", title: t("git.review.tabTitle", { name: base }), path: item.stagedPath },
    { forceNewTab: true },
  );
}

/** Consolidate one reviewed note (its resolved staged copy becomes the working
 *  note + a commit). Drops it from the session on success. */
export async function consolidateNote(path: string, message?: string): Promise<void> {
  setGitSyncing(true);
  try {
    await ipc.gitConsolidateNote(path, message);
    const session = reviewSession();
    if (session) {
      setReviewSession({
        ...session,
        items: session.items.filter((i) => i.path !== path),
      });
    }
    await refreshStatus();
    showToast("success", t("git.toast.consolidated", { name: path.split("/").pop() ?? path }));
  } catch (err) {
    toastError(t("git.toast.consolidateFailed"), err);
  } finally {
    setGitSyncing(false);
  }
}

/** Consolidate every staged note in one commit, then clear the session. */
export async function consolidateAll(message?: string): Promise<void> {
  setGitSyncing(true);
  try {
    await ipc.gitConsolidateAll(message);
    setReviewSession(null);
    await refreshStatus();
    showToast("success", t("git.toast.consolidatedAll"));
  } catch (err) {
    toastError(t("git.toast.consolidateFailed"), err);
  } finally {
    setGitSyncing(false);
  }
}

/** Publish locally-authored work: commit the working tree and push. The
 *  outgoing counterpart to fetch→review. A rejected push (remote moved) is
 *  reported, not thrown, and prompts a fetch & review. */
export async function publish(): Promise<void> {
  setGitSyncing(true);
  try {
    const result = await ipc.gitPublish();
    if (result.rejected) {
      showToast("info", t("git.toast.publishRejected"));
    } else if (result.nothingToDo) {
      showToast("info", t("git.toast.nothingToPublish"));
    } else {
      showToast("success", t("git.toast.published"));
    }
    await refreshStatus();
  } catch (err) {
    toastError(t("git.toast.publishFailed"), err);
  } finally {
    setGitSyncing(false);
  }
}

/** Abandon the current review session (clears staging). Working tree untouched. */
export async function discardReview(): Promise<void> {
  try {
    await ipc.gitDiscardReview();
    setReviewSession(null);
  } catch (err) {
    toastError(t("git.toast.discardFailed"), err);
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
  setReviewSession(null);
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

/** Set the commit identity for this notebox's remote. */
export async function setIdentity(name: string, email: string): Promise<void> {
  await ipc.gitSetIdentity(name, email);
}

export { gitStatus, reviewSession, gitSyncing, gitError, repoMissing };
