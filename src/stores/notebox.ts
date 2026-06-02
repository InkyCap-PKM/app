import { createSignal } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { NoteboxInfo, NoteboxRegistryEntry } from "../lib/types";
import { focusNoteboxWindow } from "../lib/new-window";
import { pathEquals } from "../lib/paths";
import * as ipc from "../lib/ipc";
import { buildFileList } from "./filelist";
import { onFileCreated, onFileDeleted, onFileRenamed } from "../lib/events";
import { renameTabPath, closeAllTabs, openTab, createEmptyTab, tabs } from "./tabs";
import { reloadPropertyTypes } from "./propertyTypes";
import {
  loadNoteboxSettings,
  noteboxSettings,
  settings,
  updateNoteboxSetting,
} from "./settings";
import { triggerCreationRule } from "./creation-rules";
import { refreshAliases, bumpAliasGeneration } from "./aliases";
import { startLsp, stopLsp } from "./lsp";
import { maybeSeedNotebox } from "./notebox-seed";
import { awaitAllPendingWrites } from "./editor-writes";
import { ensureGitListeners, resetGitOnOpen } from "./git";

const [noteboxInfo, setNoteboxInfo] = createSignal<NoteboxInfo | null>(null);
/** Bumped once per notebox switch, *after* the new notebox's per-notebox stores
 *  (settings, etc.) have loaded — so it's the safe key for remounting UI that
 *  seeds editable state from those stores at mount (e.g. the collaboration
 *  panel's setup/manage forms). Distinct from `noteboxInfo().path`, which
 *  changes *before* settings load and would remount such UI against stale data.
 *  Reactive UI that reads stores directly doesn't need this — it updates on its
 *  own. */
const [noteboxUiKey, setNoteboxUiKey] = createSignal(0);
const [noteboxRegistry, setNoteboxRegistry] = createSignal<NoteboxRegistryEntry[]>([]);
const [isLoading, setIsLoading] = createSignal(false);
/**
 * Set when the backend's per-notebox health monitor detects that the notebox
 * directory no longer exists on disk (deleted via OS file manager,
 * unmounted drive, etc.). Holds the path the notebox used to live at so the
 * banner can show it. Cleared automatically the next time a notebox opens
 * successfully.
 *
 * UI consumers: render a persistent warning (no save-elsewhere/save-as
 * recovery is implemented yet) and disable in-notebox writes — see
 * `assertNoteboxWritable()`.
 */
const [noteboxLost, setNoteboxLost] = createSignal<string | null>(null);
/**
 * False until the initial notebox-open attempt at app launch has run to a
 * conclusion (opened the saved notebox, or determined there isn't one). The
 * `NoteboxRequiredOverlay` keys on this so it only takes over *after* startup
 * has had its chance — without it the overlay would flash during the first
 * tick before `initNotebox()` resolves. InkyCap holds the invariant that the
 * app is never usable without an active notebox, so once this is true the
 * overlay is shown whenever `noteboxInfo()` is null.
 */
const [initAttempted, setInitAttempted] = createSignal(false);
/**
 * `indexReady` is false during the brief window between notebox open and the
 * background index build completing. UI features that depend on the property
 * index, link index, or full-text search (search pane, tag pane, backlinks,
 * properties view) should show a loading indicator while this is false.
 */
const [indexReady, setIndexReady] = createSignal(false);
/**
 * Bumped whenever the set of files in the notebox changes on disk
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
  refreshAliases().catch(console.error);
}

/** Payload of the `notebox:index-ready` event emitted by the Rust backend. */
interface IndexReadyPayload {
  file_count: number;
  collection_count: number;
  property_keys: string[];
}

let indexReadyUnlisten: UnlistenFn | null = null;
let indexErrorUnlisten: UnlistenFn | null = null;
let noteboxLostUnlisten: UnlistenFn | null = null;
let fileCreatedUnlisten: (() => void) | null = null;
let fileDeletedUnlisten: (() => void) | null = null;
let fileRenamedUnlisten: (() => void) | null = null;
let noteSavedUnlisten: (() => void) | null = null;
let indexUpdatedUnlisten: UnlistenFn | null = null;

// Debounce file-system-event-driven tree refetches. Bulk operations
// (copying a folder of notes into the notebox) can fire dozens of
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

// Debounce collection-view refreshes driven by index updates. The backend
// emits `notebox:index-updated` *after* it has reindexed a created /
// changed / deleted note, so bumping `propertyVersion` here makes open
// collection views refetch against a property index that already reflects
// the change (no race). Debounced so importing or bulk-creating dozens of
// notes triggers one refetch, not dozens.
let collectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCollectionRefresh() {
  if (collectionRefreshTimer !== null) clearTimeout(collectionRefreshTimer);
  collectionRefreshTimer = setTimeout(() => {
    collectionRefreshTimer = null;
    bumpPropertyVersion();
  }, 150);
}

async function ensureIndexEventListeners() {
  if (indexReadyUnlisten === null) {
    indexReadyUnlisten = await listen<IndexReadyPayload>(
      "notebox:index-ready",
      (event) => {
        // Merge the freshly-built index stats into the current notebox info so
        // panels relying on `property_keys` / accurate counts pick them up.
        const current = noteboxInfo();
        if (current) {
          setNoteboxInfo({
            ...current,
            file_count: event.payload.file_count,
            collection_count: event.payload.collection_count,
            property_keys: event.payload.property_keys,
          });
        }
        setIndexReady(true);
        refreshAliases().catch(console.error);
      },
    );
  }
  if (indexErrorUnlisten === null) {
    indexErrorUnlisten = await listen<{ error: string }>(
      "notebox:index-error",
      (event) => {
        console.error("Background index build failed:", event.payload.error);
        // Treat a failed build as "ready" so the UI doesn't spin forever —
        // the indexes will simply be empty until the next successful rebuild.
        setIndexReady(true);
      },
    );
  }
  if (noteboxLostUnlisten === null) {
    noteboxLostUnlisten = await listen<{ path: string }>(
      "notebox:lost",
      (event) => {
        console.warn("Notebox root vanished:", event.payload.path);
        setNoteboxLost(event.payload.path);
      },
    );
  }
  // File system watcher events → refresh the sidebar tree and the
  // quick-open file list. Subscribed once per process; the Rust
  // watcher is torn down and re-created when the notebox path changes,
  // but the event channel is notebox-scoped by path so stale events
  // can't bleed across notebox switches.
  if (fileCreatedUnlisten === null) {
    fileCreatedUnlisten = await onFileCreated(() => scheduleTreeRefresh());
  }
  if (fileDeletedUnlisten === null) {
    fileDeletedUnlisten = await onFileDeleted(() => scheduleTreeRefresh());
  }
  // External renames (mv / file-manager rename) — follow the file in
  // any open tab so it doesn't become a phantom that errors on save.
  // The tree refresh is already handled by the watcher emitting the
  // corresponding delete+create pair alongside this event.
  if (fileRenamedUnlisten === null) {
    fileRenamedUnlisten = await onFileRenamed((payload) => {
      renameTabPath(payload.from, payload.to);
    });
  }
  // Refresh aliases when a note is saved (inline edits to
  // #note(aliases: ...)). `refreshAliases` debounces internally so
  // bursts of saves collapse to one IPC call. The same hook also
  // catches property-panel edits via `bumpPropertyVersion`.
  if (noteSavedUnlisten === null) {
    const handler = () => {
      refreshAliases().catch(console.error);
    };
    document.addEventListener("inkycap:note-saved", handler);
    noteSavedUnlisten = () => document.removeEventListener("inkycap:note-saved", handler);
  }
  // The backend reindexes a created/changed/deleted note and then emits
  // `notebox:index-updated`. Refresh open collection views off this so a
  // note that newly matches (or stops matching) a collection's filter —
  // including notes brought in by a collaboration import — appears without
  // needing a notebox reopen.
  if (indexUpdatedUnlisten === null) {
    indexUpdatedUnlisten = await listen("notebox:index-updated", () =>
      scheduleCollectionRefresh(),
    );
  }
}

export async function loadNoteboxRegistry(): Promise<void> {
  try {
    const entries = await ipc.getNoteboxRegistry();
    setNoteboxRegistry(entries);
  } catch (err) {
    console.error("Failed to load notebox registry:", err);
  }
}

/** Open the contents the user's startup-behaviour preference asks for —
 *  the last-active file, a creation-rule trigger, a specific page, or a
 *  specific collection. Reads `behavior` from the user-global settings
 *  and the target / last-active pointer from the *current notebox's*
 *  settings, so each notebox restores its own state on switch. */
async function applyStartupBehavior(): Promise<void> {
  const { behavior } = settings.startup;
  const { target, last_active_file } = noteboxSettings.startup;

  switch (behavior) {
    case "default":
      break;
    case "last-file":
      if (last_active_file) {
        try {
          await ipc.readFileContent(last_active_file);
          const name = last_active_file.split("/").pop() ?? last_active_file;
          openTab({ type: "file", title: name, path: last_active_file });
        } catch {
          updateNoteboxSetting("startup", "last_active_file", null);
        }
      }
      break;
    case "creation-rule":
      if (target) {
        try {
          const result = await triggerCreationRule(target);
          if (result) {
            const name = result.path.split("/").pop() ?? "New Note";
            openTab(
              { type: "file", title: name, path: result.path },
              { cursorOffset: result.cursor_offset ?? undefined },
            );
          }
        } catch (e) {
          console.error("Startup creation rule failed:", e);
        }
      }
      break;
    case "specific-page":
      if (target) {
        try {
          await ipc.readFileContent(target);
          const name = target.split("/").pop() ?? target;
          openTab({ type: "file", title: name, path: target });
        } catch {
          // Target no longer exists — leave the new notebox with no
          // pre-opened tab rather than surface a confusing error.
        }
      }
      break;
    case "specific-collection":
      if (target) {
        const name = target.split("/").pop()?.replace(/\.collection$/, "") ?? target;
        openTab({ type: "collection", title: name, path: target });
      }
      break;
  }
}

/**
 * Switch the current window to `path`, tearing down the previous notebox's
 * tabs and reloading its settings/index.
 *
 * Returns the opened `NoteboxInfo` on success, or `null` when the notebox is
 * already open in *another* window — in that case this window is left
 * untouched and the other window is focused instead. Callers that follow up
 * with a window-local action (e.g. opening the collaboration panel) must
 * treat `null` as "this window did not switch" and not act on it.
 */
export async function openNotebox(path: string) {
  // One notebox per window: if it's already open in ANOTHER window, focus that
  // window and leave this one untouched (don't tear down its tabs to open a
  // duplicate). The backend's open_notebox guard is the race-safe backstop.
  if (await focusNoteboxWindow(path, true)) return null;

  setIsLoading(true);
  setIndexReady(false);

  // Tear down any tabs from the previous notebox before we switch the
  // backend's active notebox. Closing each tab unmounts its TypstEditor,
  // which fires a flush of any pending save. We then await every
  // in-flight write so it lands in the OLD notebox — `write_file_content`
  // routes through whatever notebox is currently active, so a write that
  // overlaps the switch would otherwise land in the new one.
  const switchingNoteboxes = noteboxInfo() !== null && !pathEquals(noteboxInfo()?.path, path);
  if (switchingNoteboxes) {
    closeAllTabs();
    await awaitAllPendingWrites();
  }

  // A fresh successful open clears any previous "notebox missing" state.
  // (If the new notebox is also missing the health monitor will set it
  // again within one tick.)
  setNoteboxLost(null);
  // Discard any in-flight alias refresh from a previous notebox and
  // clear the cached list so stale entries can't surface while the
  // new notebox's index is still building.
  bumpAliasGeneration();
  try {
    await ensureIndexEventListeners();
    await ensureGitListeners();
    const info = await ipc.openNotebox(path);
    setNoteboxInfo(info);
    // The sidebar's createResource will fetch the file tree when noteboxInfo
    // changes. We kick off the flat file list build in parallel rather than
    // blocking the UI — quick-open will be ready shortly after the sidebar.
    ipc.getFileTree().then((tree) => {
      buildFileList(tree);
    }).catch(console.error);
    // Load per-notebox property type registry so PropertyEditor sees
    // the right types from the first render onward.
    reloadPropertyTypes().catch(console.error);
    // Load this notebox's settings (folder paths, citation source,
    // journal-scroll prefs, etc.). Awaited so subsequent components
    // render against the new notebox's settings, not the previous one.
    await loadNoteboxSettings();
    // The new notebox's settings are now in their stores: bump the UI key so
    // mount-snapshot components (the collaboration panel's forms) remount and
    // re-seed from *this* notebox rather than keeping the previous one's values.
    setNoteboxUiKey((v) => v + 1);
    // Reset the git collaboration review state for the new notebox and, if it
    // is collaborative, re-query its status. (The backend also emits
    // `notebox:git-status` on open, which keeps the summary fresh.)
    resetGitOnOpen().catch(console.error);
    // Pre-warm Tinymist LSP so completions/hover are ready by the
    // time the user opens a file (~425ms cold start).
    startLsp(path).catch(console.error);
    // Refresh the notebox registry since open_notebox upserts the entry
    loadNoteboxRegistry().catch(console.error);
    // Apply the user's startup preference (last file, creation rule,
    // specific page, etc.) so the new notebox opens into a useful tab
    // instead of empty. Runs on every successful open — including the
    // initial app launch and subsequent switches.
    await applyStartupBehavior();
    // Invariant: a notebox is always presented with at least one tab.
    // "default" startup, or any of the other modes silently failing
    // (missing target, etc.), can leave us with no tabs — in that case
    // surface a fresh empty tab so the user sees the tabula-rasa hints
    // instead of a blank workspace.
    if (tabs.length === 0) {
      createEmptyTab();
    }
    return info;
  } finally {
    setIsLoading(false);
  }
}

export async function pickAndOpenNotebox(): Promise<NoteboxInfo | null> {
  // Default to the user's home directory regardless of OS — the previous
  // "default to the current notebox path" felt confusing because adding
  // a notebox is conceptually a fresh task, not navigation from the
  // currently-open one. `homeDir()` works cross-platform via Tauri.
  let defaultPath: string | undefined;
  try {
    defaultPath = await homeDir();
  } catch {
    defaultPath = undefined;
  }
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select InkyCap Notebox Folder",
    defaultPath,
  });
  if (!selected) return null;

  // Offer the seed-from-existing prompt before opening. Skips silently
  // when the folder isn't fresh or there are no other noteboxes.
  await maybeSeedNotebox(selected, noteboxRegistry());

  return openNotebox(selected);
}

export async function initNotebox(): Promise<void> {
  await loadNoteboxRegistry();
  const savedPath = await ipc.getSavedNoteboxPath();
  if (savedPath) {
    try {
      await openNotebox(savedPath);
    } catch (e) {
      console.warn("Saved notebox failed to open:", e);
    }
  }
  // If nothing opened (fresh install, or the saved notebox is gone), we don't
  // pop a bare OS folder picker any more — the `NoteboxRequiredOverlay` takes
  // over once `initAttempted` flips. It walks the user into a valid notebox
  // (open/create a folder, or pick one of their existing noteboxes), so the
  // app is never left running without one.
  setInitAttempted(true);
}

/**
 * Show the notebox picker (`NoteboxRequiredOverlay`) WITHOUT restoring the
 * saved notebox. Used by a freshly-opened "new window" so the user chooses
 * which notebox that window shows, rather than it auto-loading the same
 * notebox as the main window.
 */
export async function showNoteboxPicker(): Promise<void> {
  await loadNoteboxRegistry();
  setInitAttempted(true);
}

/**
 * Unload the active notebox without opening another, returning the app to the
 * "no notebox" state that `NoteboxRequiredOverlay` covers. Used when the active
 * notebox is removed from the registry: editing a notebox the user just removed
 * (and might delete from disk next) must not stay possible. Flushes any pending
 * writes first so in-flight edits still land on disk while the folder exists.
 */
export async function closeActiveNotebox(): Promise<void> {
  closeAllTabs();
  await awaitAllPendingWrites();
  stopLsp();
  setNoteboxInfo(null);
  setNoteboxLost(null);
  setIndexReady(false);
}

export async function refreshNoteboxInfo() {
  const info = await ipc.getNoteboxInfo();
  setNoteboxInfo(info);
}

/**
 * Throw a clear error if the active notebox has been reported missing.
 * Call this at the top of any IPC wrapper that writes inside the notebox
 * (notes, collections, attachments) — global config writes (settings,
 * creation rules, bookmarks) live in `$CONFIG_DIR/inkycap/` and are not
 * gated, so they keep working even when the notebox is gone.
 */
export function assertNoteboxWritable(): void {
  const missing = noteboxLost();
  if (missing) {
    throw new Error(
      `Notebox is missing from disk (${missing}). Copy any open content elsewhere — it cannot be saved in this notebox.`,
    );
  }
}

export { noteboxInfo, noteboxUiKey, noteboxRegistry, isLoading, indexReady, fileTreeVersion, propertyVersion, bumpPropertyVersion, noteboxLost, initAttempted };
