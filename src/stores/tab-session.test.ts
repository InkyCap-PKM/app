import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionTab, TabRestoreHeldBack } from "../lib/types";

// The store talks to the backend for the record itself; everything else under
// test is the mapping between a recorded session and the tab store.
vi.mock("../lib/ipc", () => ({
  startTabRestore: vi.fn(),
  setTabRestorePending: vi.fn(async () => {}),
  saveNoteboxTabSession: vi.fn(async () => {}),
  clearAllNoteboxTabSessions: vi.fn(async () => {}),
  updateSettings: vi.fn(async () => {}),
  updateNoteboxSettings: vi.fn(async () => {}),
}));

import { createRoot } from "solid-js";
import * as ipc from "../lib/ipc";
import {
  dismissHeldBackTabs,
  heldBackTabs,
  installTabSessionRecorder,
  recordTabSession,
  reopenHeldBackTabs,
  restorePreviousTabs,
  whenWindowSettles,
  resumeTabSessionRecording,
  suspendTabSessionRecording,
} from "./tab-session";
import { tabs, activeTabId, closeAllTabs, openTab, setTabReadingZoom } from "./tabs";
import { updateSetting } from "./settings";

function recorded(path: string, over: Partial<SessionTab> = {}): SessionTab {
  return {
    kind: "file",
    title: path.split("/").pop() ?? path,
    path,
    editing_mode: null,
    reading_format: null,
    reading_zoom: null,
    active: false,
    ...over,
  };
}

function givenRecord(session: SessionTab[], heldBack: TabRestoreHeldBack | null = null): void {
  vi.mocked(ipc.startTabRestore).mockResolvedValue({ tabs: session, held_back: heldBack });
}

// The reopen check waits on animation frames; these tests don't need it to run.
vi.stubGlobal("requestAnimationFrame", () => 0);

describe("restorePreviousTabs", () => {
  beforeEach(() => {
    closeAllTabs();
    dismissHeldBackTabs();
    vi.mocked(ipc.startTabRestore).mockReset();
    vi.mocked(ipc.setTabRestorePending).mockClear();
  });

  it("reopens every recorded tab, in the order they were left", async () => {
    givenRecord([recorded("/nb/one.typ"), recorded("/nb/two.typ")]);

    await restorePreviousTabs("/nb");

    expect(tabs.map((t) => t.path)).toEqual(["/nb/one.typ", "/nb/two.typ"]);
  });

  it("brings back the tab that was in the foreground", async () => {
    givenRecord([
      recorded("/nb/one.typ"),
      recorded("/nb/two.typ", { active: true }),
    ]);

    await restorePreviousTabs("/nb");

    const active = tabs.find((t) => t.id === activeTabId());
    expect(active?.path).toBe("/nb/two.typ");
  });

  it("carries each tab's editor mode and reading zoom back with it", async () => {
    givenRecord([
      recorded("/nb/one.typ", {
        editing_mode: "reading",
        reading_format: "html",
        reading_zoom: 1.5,
      }),
    ]);

    await restorePreviousTabs("/nb");

    expect(tabs[0].editingMode).toBe("reading");
    expect(tabs[0].readingFormat).toBe("html");
    expect(tabs[0].readingZoom).toBe(1.5);
  });

  it("ignores entries the app has no way to open", async () => {
    // The record is a plain file on disk, so it may have been hand-edited.
    givenRecord([recorded("/nb/one.typ", { kind: "nonsense" })]);

    await restorePreviousTabs("/nb");
    expect(tabs).toHaveLength(0);
  });

  it("restores nothing when the backend has no record", async () => {
    givenRecord([]);

    await restorePreviousTabs("/nb");
    expect(tabs).toHaveLength(0);
  });
});

describe("holding back tabs after a reopen that never finished", () => {
  beforeEach(() => {
    closeAllTabs();
    dismissHeldBackTabs();
    vi.mocked(ipc.setTabRestorePending).mockClear();
  });

  it("offers the tabs instead of opening them", async () => {
    givenRecord([recorded("/nb/one.typ"), recorded("/nb/big.mp4", { kind: "attachment" })], "interrupted");

    await restorePreviousTabs("/nb");

    expect(tabs).toHaveLength(0);
    expect(heldBackTabs()?.reason).toBe("interrupted");
    expect(heldBackTabs()?.tabs.map((t) => t.path)).toEqual(["/nb/one.typ", "/nb/big.mp4"]);
  });

  it("reopens one held-back tab by hand, guarded like a startup reopen", async () => {
    givenRecord([recorded("/nb/one.typ"), recorded("/nb/big.mp4", { kind: "attachment" })], "no-restore");
    await restorePreviousTabs("/nb");

    await reopenHeldBackTabs(heldBackTabs()!.tabs[0]);

    expect(ipc.setTabRestorePending).toHaveBeenCalledWith("/nb", true);
    expect(tabs.map((t) => t.path)).toEqual(["/nb/one.typ"]);
    expect(heldBackTabs()?.tabs.map((t) => t.path)).toEqual(["/nb/big.mp4"]);
  });

  it("reopens them all and stops offering them", async () => {
    givenRecord([recorded("/nb/one.typ"), recorded("/nb/two.typ")], "interrupted");
    await restorePreviousTabs("/nb");

    await reopenHeldBackTabs();

    expect(tabs.map((t) => t.path)).toEqual(["/nb/one.typ", "/nb/two.typ"]);
    expect(heldBackTabs()).toBeNull();
  });
});

describe("whenWindowSettles", () => {
  /** Drives `whenWindowSettles` with frames at the given times (ms). */
  function runFrames(times: number[]): boolean {
    let settled = false;
    const queue: ((now: number) => void)[] = [];
    whenWindowSettles(
      () => (settled = true),
      (cb) => queue.push(cb),
    );
    for (const now of times) {
      const cb = queue.shift();
      if (!cb) break;
      cb(now);
    }
    return settled;
  }

  const every = (from: number, to: number, step: number) =>
    Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

  it("settles after ten seconds of steady frames", () => {
    expect(runFrames(every(0, 9_900, 100))).toBe(false);
    expect(runFrames(every(0, 10_000, 100))).toBe(true);
  });

  it("starts counting again after a stall", () => {
    // Steady for 6 s, frozen for 3 s, then steady for another 6 s: never ten
    // unbroken seconds, so the reopen hasn't proved itself yet.
    const frames = [...every(0, 6_000, 100), ...every(9_000, 15_000, 100)];
    expect(runFrames(frames)).toBe(false);
    expect(runFrames([...frames, ...every(15_100, 19_000, 100)])).toBe(true);
  });
});

describe("recording the open tabs", () => {
  /** The tabs handed to the backend by the most recent write. */
  const lastWritten = () =>
    vi.mocked(ipc.saveNoteboxTabSession).mock.lastCall?.[0].tabs ?? [];

  beforeEach(() => {
    closeAllTabs();
    // What a notebox switch does: forget what was last written, so the next
    // change is judged against a clean slate.
    suspendTabSessionRecording();
    vi.mocked(ipc.saveNoteboxTabSession).mockClear();
    updateSetting("startup", "behavior", "previous-tabs");
  });

  it("keeps one record for a note open in two views, the one in front", async () => {
    // An editor beside its preview: same note, two tabs. Restoring both would
    // let the second overwrite the first's editor mode.
    openTab({ type: "file", title: "one", path: "/nb/one.typ", editingMode: "live" });
    openTab(
      { type: "file", title: "one", path: "/nb/one.typ", editingMode: "reading" },
      { allowDuplicate: true },
    );

    await recordTabSession();

    expect(lastWritten()).toHaveLength(1);
    expect(lastWritten()[0].editing_mode).toBe("reading");
    expect(lastWritten()[0].active).toBe(true);
  });

  it("writes at once when a tab opens, and a moment later when only its zoom changes", async () => {
    vi.useFakeTimers();
    try {
      const dispose = createRoot((d) => {
        installTabSessionRecorder();
        return d;
      });
      resumeTabSessionRecording();

      const id = openTab({ type: "file", title: "one", path: "/nb/one.typ" });
      expect(ipc.saveNoteboxTabSession).toHaveBeenCalledTimes(1);

      setTabReadingZoom(id, 1.25);
      expect(ipc.saveNoteboxTabSession).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(ipc.saveNoteboxTabSession).toHaveBeenCalledTimes(2);
      expect(lastWritten()[0].reading_zoom).toBe(1.25);

      dispose();
      suspendTabSessionRecording();
    } finally {
      vi.useRealTimers();
    }
  });
});
