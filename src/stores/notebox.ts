import { createSignal } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { NoteboxInfo, NoteboxRegistryEntry } from "../lib/types";
import { focusNoteboxWindow } from "../lib/new-window";
import { pathEquals } from "../lib/paths";
import { t } from "../lib/i18n";
import * as ipc from "../lib/ipc";
import { buildFileList } from "./filelist";
import {
  onBookmarksChanged,
  onFileCreated,
  onFileDeleted,
  onFileRenamed,
  thisWindowOnly,
} from "../lib/events";
import { renameTabPath, closeAllTabs, openTab, createEmptyTab, tabs } from "./tabs";
import {
  recordTabSession,
  restorePreviousTabs,
  resumeTabSessionRecording,
  suspendTabSessionRecording,
} from "./tab-session";
import { reloadPropertyTypes } from "./propertyTypes";
import {
  loadNoteboxSettings,
  noteboxSettings,
  settings,
  updateNoteboxSetting,
} from "./settings";
import { triggerCreationRule, loadCreationRules } from "./creation-rules";
import { refreshAliases, bumpAliasGeneration } from "./aliases";
import { startLsp, stopLsp } from "./lsp";
import { maybeSeedNotebox } from "./notebox-seed";
import { awaitAllPendingWrites } from "./editor-writes";
import { ensureGitListeners, resetGitOnOpen } from "./git";

const [noteboxInfo, setNoteboxInfo] = createSignal<NoteboxInfo | null>(null);
/**
 * Bumped once per notebox switch after the new notebox's stores have loaded, as
 * a key for remounting UI that copies those stores into editable state at mount
 * (e.g. the collaboration forms). `noteboxInfo().path` changes before settings
 * load, so it would remount too early.
 */
const [noteboxUiKey, setNoteboxUiKey] = createSignal(0);
const [noteboxRegistry, setNoteboxRegistry] = createSignal<NoteboxRegistryEntry[]>([]);
const [isLoading, setIsLoading] = createSignal(false);
/**
 * The old path of a notebox whose folder has disappeared (deleted, unmounted
 * drive), as reported by the health monitor, for the warning banner. Cleared on
 * the next successful open. While set, in-notebox writes are refused (see
 * `assertNoteboxWritable()`).
 */
const [noteboxLost, setNoteboxLost] = createSignal<string | null>(null);
/**
 * False until the launch-time notebox open has finished (opened, or found
 * none). `NoteboxRequiredOverlay` waits for this so it doesn't flash before
 * `initNotebox()` resolves. After that, the overlay shows whenever
 * `noteboxInfo()` is null, since the app is never usable without a notebox.
 */
const [initAttempted, setInitAttempted] = createSignal(false);
/**
 * False from notebox open until the background index build finishes. Search,
 * tags, backlinks and properties should show a loading state meanwhile.
 */
const [indexReady, setIndexReady] = createSignal(false);
/**
 * Bumped when files are created or deleted on disk. Resources built from
 * `getFileTree()` should key on it. The quick-open list is rebuilt alongside.
 */
const [fileTreeVersion, setFileTreeVersion] = createSignal(0);

/**
 * Bumped when a note's properties change (Properties panel or table cell
 * edits), so collection views refetch even in other tabs.
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
let bookmarksChangedUnlisten: (() => void) | null = null;
let noteSavedUnlisten: (() => void) | null = null;
let indexUpdatedUnlisten: UnlistenFn | null = null;

// Debounce tree refreshes; copying a folder of notes fires many create events
// at once.
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

// Debounce collection refreshes from `notebox:index-updated`, which arrives
// after the reindex, so the refetch sees current data. One refetch for a bulk
// import.
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
      thisWindowOnly(),
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
      thisWindowOnly(),
    );
  }
  if (noteboxLostUnlisten === null) {
    noteboxLostUnlisten = await listen<{ path: string }>(
      "notebox:lost",
      (event) => {
        console.warn("Notebox root vanished:", event.payload.path);
        setNoteboxLost(event.payload.path);
      },
      thisWindowOnly(),
    );
  }
  // Watcher events refresh the tree and quick-open list. Subscribed once;
  // events are scoped by notebox path, so they don't leak across switches.
  if (fileCreatedUnlisten === null) {
    fileCreatedUnlisten = await onFileCreated(() => scheduleTreeRefresh());
  }
  if (fileDeletedUnlisten === null) {
    fileDeletedUnlisten = await onFileDeleted(() => scheduleTreeRefresh());
  }
  // External renames: open tabs follow the file. The tree refresh comes from
  // the accompanying delete and create.
  if (fileRenamedUnlisten === null) {
    fileRenamedUnlisten = await onFileRenamed((payload) => {
      renameTabPath(payload.from, payload.to);
    });
  }
  // The backend rebases bookmarks on rename or move; refresh the Bookmarks
  // pane.
  if (bookmarksChangedUnlisten === null) {
    bookmarksChangedUnlisten = await onBookmarksChanged(() => {
      document.dispatchEvent(new CustomEvent("inkycap:bookmarks-changed"));
    });
  }
  // Refresh aliases when a note is saved (`refreshAliases` debounces).
  // Property-panel edits arrive through `bumpPropertyVersion`.
  if (noteSavedUnlisten === null) {
    const handler = () => {
      refreshAliases().catch(console.error);
    };
    document.addEventListener("inkycap:note-saved", handler);
    noteSavedUnlisten = () => document.removeEventListener("inkycap:note-saved", handler);
  }
  // Refresh collection views after the backend reindexes a note, so notes that
  // start or stop matching (including imported ones) update without reopening.
  if (indexUpdatedUnlisten === null) {
    indexUpdatedUnlisten = await listen(
      "notebox:index-updated",
      () => scheduleCollectionRefresh(),
      thisWindowOnly(),
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

/**
 * Open what the startup setting asks for: the last-active file, a creation
 * rule, a page or a collection. `behavior` is a user setting; the target and
 * last-active file come from the current notebox, so each notebox restores its
 * own.
 */
async function applyStartupBehavior(): Promise<void> {
  const { behavior } = settings.startup;
  const { target, last_active_file } = noteboxSettings.startup;

  switch (behavior) {
    case "default":
      break;
    case "previous-tabs": {
      const path = noteboxInfo()?.path;
      if (path) await restorePreviousTabs(path);
      break;
    }
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
 * Switch this window to the notebox at `path`, closing the previous notebox's
 * tabs and reloading settings and index.
 *
 * Returns the `NoteboxInfo`, or `null` when the notebox is open in another
 * window, which is focused instead and this one is left alone. Callers must
 * treat `null` as "no switch".
 */
export async function openNotebox(path: string) {
  // A notebox can be open in only one window; the backend's `open_notebox`
  // check is the race-safe backstop.
  if (await focusNoteboxWindow(path, true)) return null;

  setIsLoading(true);
  setIndexReady(false);

  // Close the old notebox's tabs before switching, which saves pending edits,
  // and wait for every write so it lands in the old notebox (writes go to
  // whichever notebox is active).
  const switchingNoteboxes = noteboxInfo() !== null && !pathEquals(noteboxInfo()?.path, path);
  if (switchingNoteboxes) {
    // Save the outgoing notebox's tabs, then pause recording until the new
    // notebox is open.
    await recordTabSession();
    suspendTabSessionRecording();
    closeAllTabs();
    await awaitAllPendingWrites();
  }

  // A successful open clears the missing-notebox state.
  setNoteboxLost(null);
  // Discard any alias refresh from the previous notebox.
  bumpAliasGeneration();
  try {
    await ensureIndexEventListeners();
    await ensureGitListeners();
    const info = await ipc.openNotebox(path);
    setNoteboxInfo(info);
    // Build the quick-open list in the background; the sidebar fetches the tree
    // itself.
    ipc.getFileTree().then((tree) => {
      buildFileList(tree);
    }).catch(console.error);
    // Load per-notebox property type registry so PropertyEditor sees
    // the right types from the first render onward.
    reloadPropertyTypes().catch(console.error);
    // Load this notebox's settings before components render against them.
    await loadNoteboxSettings();
    // Creation rules are per notebox, so reload them; otherwise the toolbar and
    // palette keep the previous notebox's rules (or none on a fresh install,
    // hiding Daily Note and breaking New Note). Awaited so the first render and
    // click see them.
    await loadCreationRules();
    // Remount components that copied settings at mount (the collaboration
    // forms).
    setNoteboxUiKey((v) => v + 1);
    // Reset the git state and, if collaborative, fetch its status. The backend
    // also emits `notebox:git-status` on open.
    resetGitOnOpen().catch(console.error);
    // Pre-warm Tinymist LSP so completions/hover are ready by the
    // time the user opens a file (~425ms cold start).
    startLsp(path).catch(console.error);
    // Refresh the notebox registry since open_notebox upserts the entry
    loadNoteboxRegistry().catch(console.error);
    // Open what the startup setting asks for, on launch and on every switch.
    await applyStartupBehavior();
    // Tab changes from here on are the user's, so resume recording. Not in a
    // `finally`: after a failed open there's no notebox to record against.
    resumeTabSessionRecording();
    // A notebox always has at least one tab; if startup left none, add an empty
    // one.
    if (tabs.length === 0) {
      createEmptyTab();
    }
    return info;
  } finally {
    setIsLoading(false);
  }
}

export async function pickAndOpenNotebox(): Promise<NoteboxInfo | null> {
  // Start the folder dialog in the home folder: adding a notebox is a new task,
  // not navigation from the current one.
  let defaultPath: string | undefined;
  try {
    defaultPath = await homeDir();
  } catch {
    defaultPath = undefined;
  }
  const selected = await open({
    directory: true,
    multiple: false,
    title: t("settings.notebox.selectFolderTitle"),
    defaultPath,
  });
  if (!selected) return null;

  // Offer the seed-from-existing prompt before opening. Skips silently
  // when the folder isn't fresh or there are no other noteboxes.
  await maybeSeedNotebox(selected, noteboxRegistry());

  return openNotebox(selected);
}

/**
 * Open this window's first notebox: `preferredPath` (from an `inkycap://` link
 * at startup), otherwise the one open when InkyCap last closed.
 */
export async function initNotebox(preferredPath?: string): Promise<void> {
  await loadNoteboxRegistry();
  const savedPath = preferredPath ?? (await ipc.getSavedNoteboxPath());
  if (savedPath) {
    try {
      await openNotebox(savedPath);
    } catch (e) {
      console.warn("Saved notebox failed to open:", e);
    }
  }
  // If nothing opened, `NoteboxRequiredOverlay` takes over and helps the user
  // open or create one.
  setInitAttempted(true);
}

/**
 * Show the notebox picker without restoring the saved notebox, so a new window
 * lets the user choose.
 */
export async function showNoteboxPicker(): Promise<void> {
  await loadNoteboxRegistry();
  setInitAttempted(true);
}

/**
 * Unload the active notebox without opening another, leaving
 * `NoteboxRequiredOverlay` showing. Used when it is removed from the list, so
 * it can't still be edited. Pending writes are flushed first.
 */
export async function closeActiveNotebox(): Promise<void> {
  // Save the tabs, then stop recording, so the empty workspace isn't saved as
  // "no tabs".
  await recordTabSession();
  suspendTabSessionRecording();
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
 * Throw if the active notebox has been reported missing. Call at the top of
 * every IPC wrapper that writes inside the notebox (notes, collections,
 * attachments). App-wide config (settings, bookmarks) lives in
 * `$CONFIG_DIR/inkycap/` and keeps working.
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
