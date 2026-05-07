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

export function onFileChanged(
  callback: (payload: FileChangedPayload) => void,
): Promise<() => void> {
  return listen<FileChangedPayload>("vault:file-changed", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onFileCreated(
  callback: (payload: FileCreatedPayload) => void,
): Promise<() => void> {
  return listen<FileCreatedPayload>("vault:file-created", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onFileDeleted(
  callback: (payload: FileDeletedPayload) => void,
): Promise<() => void> {
  return listen<FileDeletedPayload>("vault:file-deleted", (event) => {
    callback(event.payload);
  }).then((unlisten) => unlisten);
}

export function onIndexRebuilt(
  callback: () => void,
): Promise<() => void> {
  return listen("vault:index-rebuilt", () => {
    callback();
  }).then((unlisten) => unlisten);
}
