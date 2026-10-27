import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { GitStatusSummary } from "./types";

// Some events belong to one window's notebox and carry no path to filter on
// (git status, index build results), so the backend sends each to its window
// with `emit_to(window_label, …)`. But `listen()` by default also hears events
// sent to other windows, so these options limit a listener to this window.
// (File watcher events are already filtered by path.)
//
// Resolved per subscribe, with a fallback: `getCurrentWebviewWindow()` throws
// outside a Tauri webview (e.g. Vitest/jsdom), where the default is fine.
export function thisWindowOnly(): { target: string } | undefined {
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

// Sent after the backend updates bookmark paths for a rename or move in
// InkyCap, so the Bookmarks pane reloads. Sent to all windows, since bookmarks
// are app-wide.
export function onBookmarksChanged(
  callback: () => void,
): Promise<() => void> {
  return listen("notebox:bookmarks-changed", () => {
    callback();
  }).then((unlisten) => unlisten);
}

// ─────────────────────────── Git collaboration ─────────────────────────────
// The backend sends `notebox:git-*` events during fetch, review, merge and push
// (see `src-tauri/src/commands/git.rs` and
// `commands/notebox.rs::surface_git_status`). The git store uses them for the
// syncing indicator and status.

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
  }, thisWindowOnly()).then((unlisten) => unlisten);
}

export function onGitStatus(
  callback: (payload: GitStatusEventPayload) => void,
): Promise<() => void> {
  return listen<GitStatusEventPayload>("notebox:git-status", (event) => {
    callback(event.payload);
  }, thisWindowOnly()).then((unlisten) => unlisten);
}

export function onGitFetchStarted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-fetch-started", () => callback(), thisWindowOnly()).then(
    (unlisten) => unlisten,
  );
}

export function onGitFetchCompleted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-fetch-completed", () => callback(), thisWindowOnly()).then(
    (unlisten) => unlisten,
  );
}

export function onGitPushStarted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-push-started", () => callback(), thisWindowOnly()).then(
    (unlisten) => unlisten,
  );
}

export function onGitPushCompleted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-push-completed", () => callback(), thisWindowOnly()).then(
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
  }, thisWindowOnly()).then((unlisten) => unlisten);
}
