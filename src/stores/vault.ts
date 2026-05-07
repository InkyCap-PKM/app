import { createSignal } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VaultInfo } from "../lib/types";
import * as ipc from "../lib/ipc";
import { buildFileList } from "./filelist";
import { onFileCreated, onFileDeleted } from "../lib/events";
import { reloadPropertyTypes } from "./propertyTypes";
import { startLsp, stopLsp } from "./lsp";

const [vaultInfo, setVaultInfo] = createSignal<VaultInfo | null>(null);
const [isLoading, setIsLoading] = createSignal(false);
/**
 * `indexReady` is false during the brief window between vault open and the
 * background index build completing. UI features that depend on the property
 * index, link index, or full-text search (search pane, tag pane, backlinks,
 * properties view) should show a loading indicator while this is false.
 */
const [indexReady, setIndexReady] = createSignal(false);
/**
 * Bumped whenever the set of files in the vault changes on disk
 * (creates/deletes surfaced by the Rust file watcher). Consumers that render
 * from `getFileTree()` should key their resource on this signal so they
 * refetch instead of serving a stale snapshot. The flat filelist used by
 * quick-open is rebuilt in-place alongside the bump.
 */
const [fileTreeVersion, setFileTreeVersion] = createSignal(0);

/**
 * Bumped whenever a note's properties are modified (via the Properties panel
 * or inline cell editing). Collection views key their resource on this so
 * they refetch after membership changes even if mounted on a different tab.
 */
const [propertyVersion, setPropertyVersion] = createSignal(0);

function bumpPropertyVersion() {
  setPropertyVersion((v) => v + 1);
}

/** Payload of the `vault:index-ready` event emitted by the Rust backend. */
interface IndexReadyPayload {
  file_count: number;
  collection_count: number;
  property_keys: string[];
}

let indexReadyUnlisten: UnlistenFn | null = null;
let indexErrorUnlisten: UnlistenFn | null = null;
let fileCreatedUnlisten: (() => void) | null = null;
let fileDeletedUnlisten: (() => void) | null = null;

// Debounce file-system-event-driven tree refetches. Bulk operations
// (copying a folder of notes into the vault) can fire dozens of
// FileCreated events in a few ms; we want one tree refresh, not thirty.
let treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTreeRefresh() {
  if (treeRefreshTimer !== null) clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(async () => {
    treeRefreshTimer = null;
    try {
      const tree = await ipc.getFileTree();
      buildFileList(tree);
      setFileTreeVersion((v) => v + 1);
    } catch (err) {
      console.error("File tree refresh failed:", err);
    }
  }, 150);
}

async function ensureIndexEventListeners() {
  if (indexReadyUnlisten === null) {
    indexReadyUnlisten = await listen<IndexReadyPayload>(
      "vault:index-ready",
      (event) => {
        // Merge the freshly-built index stats into the current vault info so
        // panels relying on `property_keys` / accurate counts pick them up.
        const current = vaultInfo();
        if (current) {
          setVaultInfo({
            ...current,
            file_count: event.payload.file_count,
            collection_count: event.payload.collection_count,
            property_keys: event.payload.property_keys,
          });
        }
        setIndexReady(true);
      },
    );
  }
  if (indexErrorUnlisten === null) {
    indexErrorUnlisten = await listen<{ error: string }>(
      "vault:index-error",
      (event) => {
        console.error("Background index build failed:", event.payload.error);
        // Treat a failed build as "ready" so the UI doesn't spin forever —
        // the indexes will simply be empty until the next successful rebuild.
        setIndexReady(true);
      },
    );
  }
  // File system watcher events → refresh the sidebar tree and the
  // quick-open file list. Subscribed once per process; the Rust
  // watcher is torn down and re-created when the vault path changes,
  // but the event channel is vault-scoped by path so stale events
  // can't bleed across vault switches.
  if (fileCreatedUnlisten === null) {
    fileCreatedUnlisten = await onFileCreated(() => scheduleTreeRefresh());
  }
  if (fileDeletedUnlisten === null) {
    fileDeletedUnlisten = await onFileDeleted(() => scheduleTreeRefresh());
  }
}

export async function openVault(path: string) {
  setIsLoading(true);
  setIndexReady(false);
  try {
    await ensureIndexEventListeners();
    const info = await ipc.openVault(path);
    setVaultInfo(info);
    // The sidebar's createResource will fetch the file tree when vaultInfo
    // changes. We kick off the flat file list build in parallel rather than
    // blocking the UI — quick-open will be ready shortly after the sidebar.
    ipc.getFileTree().then((tree) => {
      buildFileList(tree);
    }).catch(console.error);
    // Load per-vault property type registry so PropertyEditor sees
    // the right types from the first render onward.
    reloadPropertyTypes().catch(console.error);
    // Pre-warm Tinymist LSP so completions/hover are ready by the
    // time the user opens a file (~425ms cold start).
    startLsp(path).catch(console.error);
    return info;
  } finally {
    setIsLoading(false);
  }
}

export async function pickAndOpenVault(): Promise<VaultInfo | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select InkyCap Vault Folder",
  });
  if (!selected) return null;
  return openVault(selected);
}

export async function initVault(): Promise<void> {
  const savedPath = await ipc.getSavedVaultPath();
  if (savedPath) {
    try {
      await openVault(savedPath);
      return;
    } catch (e) {
      console.warn("Saved vault path failed, prompting picker:", e);
    }
  }
  await pickAndOpenVault();
}

export async function refreshVaultInfo() {
  const info = await ipc.getVaultInfo();
  setVaultInfo(info);
}

export { vaultInfo, isLoading, indexReady, fileTreeVersion, propertyVersion, bumpPropertyVersion };
