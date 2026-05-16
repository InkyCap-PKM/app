import { listen } from "@tauri-apps/api/event";

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
