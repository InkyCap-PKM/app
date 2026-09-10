import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionTab } from "../lib/types";

// The store talks to the backend for the record itself; everything else under
// test is the mapping between a recorded session and the tab store.
vi.mock("../lib/ipc", () => ({
  getNoteboxTabSession: vi.fn(),
  saveNoteboxTabSession: vi.fn(async () => {}),
  clearAllNoteboxTabSessions: vi.fn(async () => {}),
  updateSettings: vi.fn(async () => {}),
  updateNoteboxSettings: vi.fn(async () => {}),
}));

import { createRoot } from "solid-js";
import * as ipc from "../lib/ipc";
import {
  installTabSessionRecorder,
  recordTabSession,
  restorePreviousTabs,
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

function givenRecord(session: SessionTab[]): void {
  vi.mocked(ipc.getNoteboxTabSession).mockResolvedValue({ tabs: session });
}

describe("restorePreviousTabs", () => {
  beforeEach(() => {
    closeAllTabs();
    vi.mocked(ipc.getNoteboxTabSession).mockReset();
  });

  it("reopens every recorded tab, in the order they were left", async () => {
    givenRecord([recorded("/nb/one.typ"), recorded("/nb/two.typ")]);

    await restorePreviousTabs();

    expect(tabs.map((t) => t.path)).toEqual(["/nb/one.typ", "/nb/two.typ"]);
  });

  it("brings back the tab that was in the foreground", async () => {
    givenRecord([
      recorded("/nb/one.typ"),
      recorded("/nb/two.typ", { active: true }),
    ]);

    await restorePreviousTabs();

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

    await restorePreviousTabs();

    expect(tabs[0].editingMode).toBe("reading");
    expect(tabs[0].readingFormat).toBe("html");
    expect(tabs[0].readingZoom).toBe(1.5);
  });

  it("ignores entries the app has no way to open", async () => {
    // The record is a plain file on disk, so it may have been hand-edited.
    givenRecord([recorded("/nb/one.typ", { kind: "nonsense" })]);

    await restorePreviousTabs();
    expect(tabs).toHaveLength(0);
  });

  it("restores nothing when the backend has no record", async () => {
    givenRecord([]);

    await restorePreviousTabs();
    expect(tabs).toHaveLength(0);
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
