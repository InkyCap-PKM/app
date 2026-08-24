import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { GitStatusSummary } from "./types";

// Git events are per-notebox, i.e. per-window, and carry no path the frontend
// could filter on, so the backend targets each at its owning window via
// `emit_to(window_label, …)`. But `listen()` defaults to a catch-all (target
// `Any`) that receives events emitted to ANY target — including a *different*
// window's — so without scoping, syncing in one open notebox would light up the
// status/spinner of every other one. Scoping these listeners to the current
// window's label makes them ignore events emitted to other windows while still
// receiving this window's. Used only for the git events (file-watcher events
// are deliberately broadcast and self-scoped by path).
//
// Resolved lazily (per subscribe) and guarded: `getCurrentWebviewWindow()`
// throws outside a Tauri webview (e.g. the Vitest/jsdom env), where falling
// back to the default target is harmless.
function gitEventOptions(): { target: string } | undefined {
  try {
    return { target: getCurrentWebviewWindow().label };
  } catch {
    return undefined;
  }
}

export interface FileChangedPayload {
  path: string;
  change: "Content" | "Metadata";
}

export interface FileCreatedPayload {
  path: string;
}

export interface FileDeletedPayload {
  path: string;
}

export interface FileRenamedPayload {
  from: string;
  to: string;
}

export function onFileChanged(
  callback: (payload: FileChangedPayload) => void,
): Promise<() => void> {
  return listen<FileChangedPayload>("notebox:file-changed", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onFileCreated(
  callback: (payload: FileCreatedPayload) => void,
): Promise<() => void> {
  return listen<FileCreatedPayload>("notebox:file-created", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onFileDeleted(
  callback: (payload: FileDeletedPayload) => void,
): Promise<() => void> {
  return listen<FileDeletedPayload>("notebox:file-deleted", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onFileRenamed(
  callback: (payload: FileRenamedPayload) => void,
): Promise<() => void> {
  return listen<FileRenamedPayload>("notebox:file-renamed", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onIndexRebuilt(
  callback: () => void,
): Promise<() => void> {
  return listen("notebox:index-rebuilt", () => {
    callback();
  }).then((unlisten) => unlisten);
}

// Emitted after the backend rebases bookmark paths in response to an
// InkyCap-initiated rename or move, so the Bookmarks pane re-queries and drops
// stale paths. Broadcast (not window-scoped) because bookmarks are app-global.
export function onBookmarksChanged(
  callback: () => void,
): Promise<() => void> {
  return listen("notebox:bookmarks-changed", () => {
    callback();
  }).then((unlisten) => unlisten);
}

// ─────────────────────────── Git collaboration ─────────────────────────────
// The backend emits `notebox:git-*` throughout the fetch → review →
// consolidate → push loop (see `src-tauri/src/commands/git.rs` and
// `commands/notebox.rs::surface_git_status`). The git store subscribes to
// these to drive the syncing indicator and refresh status.

/** Emitted on notebox open for a collaborative repo: the configured remote +
 *  branch and a status summary. */
export interface GitStatusEventPayload {
  remote: string;
  branch: string;
  status: GitStatusSummary;
}

/** Emitted on opening a notebox that is a git repo with an `origin` remote but
 *  carries no collaboration config — the frontend offers a one-click reconnect. */
export interface GitReconnectablePayload {
  remote: string;
  branch: string;
}

export function onGitReconnectable(
  callback: (payload: GitReconnectablePayload) => void,
): Promise<() => void> {
  return listen<GitReconnectablePayload>("notebox:git-reconnectable", (event) => {
    callback(event.payload);
  }, gitEventOptions()).then((unlisten) => unlisten);
}

export function onGitStatus(
  callback: (payload: GitStatusEventPayload) => void,
): Promise<() => void> {
  return listen<GitStatusEventPayload>("notebox:git-status", (event) => {
    callback(event.payload);
  }, gitEventOptions()).then((unlisten) => unlisten);
}

export function onGitFetchStarted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-fetch-started", () => callback(), gitEventOptions()).then(
    (unlisten) => unlisten,
  );
}

export function onGitFetchCompleted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-fetch-completed", () => callback(), gitEventOptions()).then(
    (unlisten) => unlisten,
  );
}

export function onGitPushStarted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-push-started", () => callback(), gitEventOptions()).then(
    (unlisten) => unlisten,
  );
}

export function onGitPushCompleted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-push-completed", () => callback(), gitEventOptions()).then(
    (unlisten) => unlisten,
  );
}

/** A git operation failed; the payload is a safe-to-show message (no note
 *  content or filesystem paths). */
export function onGitError(
  callback: (message: string) => void,
): Promise<() => void> {
  return listen<string>("notebox:git-error", (event) => {
    callback(event.payload);
  }, gitEventOptions()).then((unlisten) => unlisten);
}
