import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionTab } from "../lib/types";

// The store talks to the backend for the record itself; everything else under
// test is the mapping between a recorded session and the tab store.
vi.mock("../lib/ipc", () => ({
  getNoteboxTabSession: vi.fn(),
  saveNoteboxTabSession: vi.fn(async () => {}),
  clearNoteboxTabSession: vi.fn(async () => {}),
  updateSettings: vi.fn(async () => {}),
  updateNoteboxSettings: vi.fn(async () => {}),
}));

import * as ipc from "../lib/ipc";
import { restorePreviousTabs } from "./tab-session";
import { tabs, activeTabId, closeAllTabs } from "./tabs";

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

    const count = await restorePreviousTabs();

    expect(count).toBe(2);
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

    expect(await restorePreviousTabs()).toBe(0);
    expect(tabs).toHaveLength(0);
  });

  it("restores nothing when the backend has no record", async () => {
    givenRecord([]);

    expect(await restorePreviousTabs()).toBe(0);
    expect(tabs).toHaveLength(0);
  });
});
