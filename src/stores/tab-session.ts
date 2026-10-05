// Records which tabs are open so the "Open previous tabs" startup behaviour can
// put them back, the way a web browser reopens the tabs you left.
//
// Recording is reactive rather than tied to app quit, since nothing runs on the
// frontend when the window closes. Which tabs are open, in what order, and
// which is in front is written as soon as it changes, so quitting right after
// opening a note still leaves that note in the record; how a tab is being
// viewed (its mode, format and zoom) is written a moment later, so a run of
// zoom steps is one write. Nothing is recorded unless the user has chosen the
// "previous tabs" startup behaviour, and switching away from it forgets what
// was stored for every notebox. The record lives on this machine only — see
// `src-tauri/src/tab_sessions.rs`.
//
// A reopen has to prove it worked: the backend marks it in progress, and the
// mark is cleared here only once the window has kept drawing smoothly for a
// while. If a reopened tab freezes or crashes the app, the mark survives, and
// the next start holds the tabs back (`heldBackTabs`) for the user to reopen
// by hand from the empty tab, instead of freezing again.

import { batch, createEffect, createSignal, onCleanup } from "solid-js";
import * as ipc from "../lib/ipc";
import type { SessionTab, TabRestoreHeldBack } from "../lib/types";
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
const RESTORABLE: readonly Tab["type"][] = ["file", "collection", "mycelial", "attachment"];

/** How long to wait after a change to how a tab is viewed before writing, so
 *  a run of zoom steps is one write. Changes to which tabs are open are
 *  written at once. */
const WRITE_DELAY_MS = 500;

let writeTimer: ReturnType<typeof setTimeout> | undefined;
/** The shape last written, or scheduled: which tabs, in what order, which in
 *  front. A change here is written immediately. */
let lastShape: string | null = null;
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
 *  pane in this order.
 *
 *  The same note can be open in two panes at once — an editor beside its
 *  preview, say. A restore opens one tab per note, so only one record is kept
 *  for it: the one in front if either is, otherwise the first. Keeping both
 *  would let the second overwrite the first's editor mode on restore. */
function snapshot(): SessionTab[] {
  const active = activeTabId();
  const out: SessionTab[] = [];
  const seen = new Map<string, number>();
  for (const leaf of allLeaves()) {
    for (const id of leaf.tabIds) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab || !isRestorable(tab.type)) continue;
      const record: SessionTab = {
        kind: tab.type,
        title: tab.title,
        path: tab.path,
        editing_mode: tab.editingMode ?? null,
        reading_format: tab.readingFormat ?? null,
        reading_zoom: tab.readingZoom ?? null,
        active: tab.id === active,
      };
      const key = `${tab.type}\u0000${tab.path}`;
      const earlier = seen.get(key);
      if (earlier === undefined) {
        seen.set(key, out.length);
        out.push(record);
      } else if (record.active) {
        out[earlier] = record;
      }
    }
  }
  return out;
}

/** What a snapshot says about which tabs are open, apart from how each is
 *  being viewed. */
function shapeOf(tabsNow: SessionTab[]): string {
  return JSON.stringify(tabsNow.map((t) => [t.kind, t.path, t.active]));
}

/** Write the tabs as they stand right now. Safe to call at any time — it is a
 *  no-op unless the user has asked for the behaviour, and a failure (no notebox
 *  open yet, unwritable config dir) is logged rather than surfaced. */
export async function recordTabSession(): Promise<void> {
  if (settings.startup.behavior !== "previous-tabs") return;
  clearTimeout(writeTimer);
  const tabsNow = snapshot();
  lastShape = shapeOf(tabsNow);
  try {
    await ipc.saveNoteboxTabSession({ tabs: tabsNow });
  } catch (err) {
    console.error("Failed to record the open tabs:", err);
  }
}

/** Write now if which tabs are open has changed; otherwise a little later,
 *  since only how a tab is viewed has. */
function recordOnChange(): void {
  if (shapeOf(snapshot()) !== lastShape) {
    void recordTabSession();
    return;
  }
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
  // Held-back tabs belong to the notebox being left.
  setHeldBack(null);
  clearTimeout(writeTimer);
  lastShape = null;
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
    const wasRecording = previousBehavior === "previous-tabs";
    previousBehavior = behavior;

    if (behavior !== "previous-tabs") {
      // Turning the behaviour off forgets what was stored, for every notebox,
      // rather than leaving a record of open files behind for a preference no
      // longer in use. Nothing below reads the tabs, so while the behaviour is
      // off this effect does not re-run as they change.
      if (wasRecording) {
        clearTimeout(writeTimer);
        lastShape = null;
        ipc.clearAllNoteboxTabSessions().catch((err) =>
          console.error("Failed to clear the recorded tabs:", err),
        );
      }
      return;
    }
    // Reading the tabs here is what makes the effect re-run whenever they are
    // opened, closed, reordered, switched, or viewed differently.
    snapshot();
    if (suspended) return;
    recordOnChange();
  });

  onCleanup(() => clearTimeout(writeTimer));
}

/** How long the window must keep drawing without a stall before a reopen
 *  counts as having worked, and how long a gap between frames counts as a
 *  stall. A frozen window draws nothing, so its reopen never counts. */
const SETTLE_MS = 10_000;
const STALL_MS = 2_000;

/**
 * Call `onSettled` once the window has drawn frames for `SETTLE_MS` with no
 * gap longer than `STALL_MS`. A stall starts the count again, and a hidden
 * window (which draws nothing) simply waits. `frame` is injectable for tests.
 */
export function whenWindowSettles(
  onSettled: () => void,
  frame: (cb: (now: number) => void) => void = requestAnimationFrame,
): void {
  let start: number | null = null;
  let last = 0;
  const tick = (now: number) => {
    if (start === null || now - last > STALL_MS) start = now;
    last = now;
    if (now - start >= SETTLE_MS) {
      onSettled();
      return;
    }
    frame(tick);
  };
  frame(tick);
}

/** Clear the notebox's "reopen in progress" mark once the window settles. */
function confirmReopenWhenSettled(noteboxPath: string): void {
  whenWindowSettles(() => {
    ipc.setTabRestorePending(noteboxPath, false).catch((err) =>
      console.error("Failed to clear the reopen mark:", err),
    );
  });
}

/** Tabs that were not reopened at startup, offered on the empty tab instead,
 *  and why: the last reopen never finished, or InkyCap was started with
 *  `--no-restore`. `null` when nothing is held back. */
export interface HeldBackTabs {
  noteboxPath: string;
  reason: TabRestoreHeldBack;
  tabs: SessionTab[];
}

const [heldBack, setHeldBack] = createSignal<HeldBackTabs | null>(null);
export const heldBackTabs = heldBack;

/** Open recorded tabs, putting back how each was viewed and which was in
 *  front. The first takes over a placeholder empty tab rather than leaving it
 *  behind as a stray. */
function openRecordedTabs(records: SessionTab[], newTab = false): void {
  let reuseActive = !newTab && getActiveTab()?.type === "empty";
  let activeId: string | null = null;

  batch(() => {
    for (const rec of records) {
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
}

/**
 * Reopen the tabs recorded for the notebox at `noteboxPath`, which just
 * opened, or hold them back when the backend says the last reopen never
 * finished (or InkyCap was started with `--no-restore`). Does nothing when
 * there is no record, leaving the fresh notebox's empty workspace as it is.
 */
export async function restorePreviousTabs(noteboxPath: string): Promise<void> {
  let restore;
  try {
    restore = await ipc.startTabRestore();
  } catch (err) {
    console.error("Failed to read the previously open tabs:", err);
    return;
  }

  // The record is a plain file a user could edit by hand, so only types this
  // app knows how to open are honoured.
  const restorable = restore.tabs.filter((rec) =>
    isRestorable(rec.kind as Tab["type"]),
  );
  if (restorable.length === 0) return;

  if (restore.held_back) {
    setHeldBack({ noteboxPath, reason: restore.held_back, tabs: restorable });
    return;
  }
  openRecordedTabs(restorable);
  confirmReopenWhenSettled(noteboxPath);
}

/**
 * Reopen held-back tabs by hand: `record` alone, or all of them when omitted.
 * Guarded like a startup reopen, so a tab that freezes the app again is held
 * back again at the next start. Ctrl/Cmd-click (`newTab`) keeps the current
 * tab.
 */
export async function reopenHeldBackTabs(record?: SessionTab, newTab = false): Promise<void> {
  const held = heldBack();
  if (!held) return;
  const chosen = record ? [record] : held.tabs;
  try {
    await ipc.setTabRestorePending(held.noteboxPath, true);
  } catch (err) {
    console.error("Failed to mark the reopen:", err);
  }
  const left = held.tabs.filter((t) => !chosen.includes(t));
  setHeldBack(left.length > 0 ? { ...held, tabs: left } : null);
  openRecordedTabs(chosen, newTab);
  confirmReopenWhenSettled(held.noteboxPath);
}

/** Stop offering the held-back tabs. */
export function dismissHeldBackTabs(): void {
  setHeldBack(null);
}
