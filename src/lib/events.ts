import { listen } from "@tauri-apps/api/event";
import type { GitStatusSummary } from "./types";

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

/** Emitted after a fetch-and-review with the number of changed items staged. */
export interface GitReviewPendingPayload {
  count: number;
}

/** Emitted after a consolidate: a single note (`path`) or the batched-all case. */
export interface GitConsolidatedPayload {
  path?: string;
  all?: boolean;
}

export function onGitStatus(
  callback: (payload: GitStatusEventPayload) => void,
): Promise<() => void> {
  return listen<GitStatusEventPayload>("notebox:git-status", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onGitFetchStarted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-fetch-started", () => callback()).then(
    (unlisten) => unlisten,
  );
}

export function onGitFetchCompleted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-fetch-completed", () => callback()).then(
    (unlisten) => unlisten,
  );
}

export function onGitReviewPending(
  callback: (payload: GitReviewPendingPayload) => void,
): Promise<() => void> {
  return listen<GitReviewPendingPayload>("notebox:git-review-pending", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onGitConsolidated(
  callback: (payload: GitConsolidatedPayload) => void,
): Promise<() => void> {
  return listen<GitConsolidatedPayload>("notebox:git-consolidated", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onGitPushStarted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-push-started", () => callback()).then(
    (unlisten) => unlisten,
  );
}

export function onGitPushCompleted(callback: () => void): Promise<() => void> {
  return listen("notebox:git-push-completed", () => callback()).then(
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
  }).then((unlisten) => unlisten);
}
