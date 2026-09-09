// Records which tabs are open so the "Open previous tabs" startup behaviour can
// put them back, the way a web browser reopens the tabs you left.
//
// Recording is reactive and debounced rather than tied to app quit: the tabs are
// written shortly after they change, so an unclean exit (or a crash) still
// leaves an accurate record. Nothing is recorded unless the user has chosen the
// "previous tabs" startup behaviour, and switching away from it forgets what was
// stored. The record lives on this machine only — see
// `src-tauri/src/tab_sessions.rs`.

import { batch, createEffect, onCleanup } from "solid-js";
import * as ipc from "../lib/ipc";
import type { SessionTab } from "../lib/types";
import { settings } from "./settings";
import { allLeaves } from "./panes";
import {
  tabs,
  activeTabId,
  setActiveTabId,
  getActiveTab,
  openTab,
  setTabReadingFormat,
  setTabReadingZoom,
  type EditingMode,
  type Tab,
} from "./tabs";

/** Tab types worth restoring. An empty tab has nothing to restore, and a
 *  version-diff is a transient compare view whose version metadata doesn't
 *  survive a {type, title, path} record. */
const RESTORABLE: readonly Tab["type"][] = ["file", "collection", "mycelial"];

/** How long to wait after a tab change before writing. Long enough to collapse
 *  a burst (closing several tabs in a row), short enough that the record is
 *  current by the time the user quits. */
const WRITE_DELAY_MS = 500;

let writeTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while there is no settled notebox to record for: before the first one
 *  opens, and while a switch tears the old one's tabs down. Without it, the
 *  empty workspace those moments pass through would be recorded as "the user
 *  closed everything". Starts true, since nothing is open at launch. */
let suspended = true;

function isRestorable(type: Tab["type"]): boolean {
  return RESTORABLE.includes(type);
}

/** Accept a recorded editor mode only if it is one this app knows, so a
 *  hand-edited record can't pin a tab to a mode that doesn't exist. */
function asEditingMode(value: string | null): EditingMode | undefined {
  return value === "source" || value === "live" || value === "reading"
    ? value
    : undefined;
}

/** The open tabs in display order across every pane. Pane layout itself is
 *  session-only (see `stores/panes.ts`), so a restore lays the tabs out in one
 *  pane in this order. */
function snapshot(): SessionTab[] {
  const active = activeTabId();
  const out: SessionTab[] = [];
  for (const leaf of allLeaves()) {
    for (const id of leaf.tabIds) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab || !isRestorable(tab.type)) continue;
      out.push({
        kind: tab.type,
        title: tab.title,
        path: tab.path,
        editing_mode: tab.editingMode ?? null,
        reading_format: tab.readingFormat ?? null,
        reading_zoom: tab.readingZoom ?? null,
        active: tab.id === active,
      });
    }
  }
  return out;
}

/** Write the tabs as they stand right now. Safe to call at any time — it is a
 *  no-op unless the user has asked for the behaviour, and a failure (no notebox
 *  open yet, unwritable config dir) is logged rather than surfaced. */
export async function recordTabSession(): Promise<void> {
  if (settings.startup.behavior !== "previous-tabs") return;
  try {
    await ipc.saveNoteboxTabSession({ tabs: snapshot() });
  } catch (err) {
    console.error("Failed to record the open tabs:", err);
  }
}

function scheduleWrite(): void {
  clearTimeout(writeTimer);
  // The snapshot is taken when the timer fires, not when it is scheduled, so
  // coalesced changes always write the current state.
  writeTimer = setTimeout(() => {
    if (suspended) return;
    void recordTabSession();
  }, WRITE_DELAY_MS);
}

/** Pause recording across a notebox switch. The workspace is emptied before the
 *  new notebox loads, and that empty state must not overwrite either notebox's
 *  record. */
export function suspendTabSessionRecording(): void {
  suspended = true;
  clearTimeout(writeTimer);
}

export function resumeTabSessionRecording(): void {
  suspended = false;
}

/**
 * Start watching the open tabs. Called once from the app root, where it has a
 * reactive owner to live under.
 */
export function installTabSessionRecorder(): void {
  let previousBehavior: string | null = null;

  createEffect(() => {
    const behavior = settings.startup.behavior;
    // Read the tab shape so this effect re-runs whenever tabs are opened,
    // closed, reordered, or switched.
    snapshot();

    const wasRecording = previousBehavior === "previous-tabs";
    previousBehavior = behavior;

    if (behavior !== "previous-tabs") {
      // Turning the behaviour off forgets what was stored, rather than leaving
      // a record of open files behind for a preference no longer in use.
      if (wasRecording) {
        clearTimeout(writeTimer);
        ipc.clearNoteboxTabSession().catch((err) =>
          console.error("Failed to clear the recorded tabs:", err),
        );
      }
      return;
    }
    if (suspended) return;
    scheduleWrite();
  });

  onCleanup(() => clearTimeout(writeTimer));
}

/**
 * Reopen the tabs recorded for the notebox that just opened. Returns the number
 * of tabs restored, so the caller can fall back to its usual empty-workspace
 * handling when there was nothing to restore.
 */
export async function restorePreviousTabs(): Promise<number> {
  let recorded: SessionTab[];
  try {
    recorded = (await ipc.getNoteboxTabSession()).tabs;
  } catch (err) {
    console.error("Failed to read the previously open tabs:", err);
    return 0;
  }

  // The record is a plain file a user could edit by hand, so only types this
  // app knows how to open are honoured.
  const restorable = recorded.filter((rec) =>
    isRestorable(rec.kind as Tab["type"]),
  );
  if (restorable.length === 0) return 0;

  // A fresh notebox opens on a placeholder empty tab; the first restored tab
  // takes it over rather than leaving it behind as a stray.
  let reuseActive = getActiveTab()?.type === "empty";
  let activeId: string | null = null;

  batch(() => {
    for (const rec of restorable) {
      const id = openTab(
        {
          type: rec.kind as Tab["type"],
          title: rec.title,
          path: rec.path,
          editingMode: asEditingMode(rec.editing_mode),
        },
        { forceNewTab: !reuseActive },
      );
      reuseActive = false;
      if (rec.reading_format === "svg" || rec.reading_format === "html") {
        setTabReadingFormat(id, rec.reading_format);
      }
      if (rec.reading_zoom) setTabReadingZoom(id, rec.reading_zoom);
      if (rec.active) activeId = id;
    }
    if (activeId) setActiveTabId(activeId);
  });

  return restorable.length;
}
