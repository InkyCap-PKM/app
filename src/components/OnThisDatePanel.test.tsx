import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render } from "solid-js/web";
import OnThisDatePanel from "./OnThisDatePanel";
import type { AgendaItem } from "../lib/types";

// On This Date lists the day's agenda items with the Agenda's own rows, and
// explains the date property when the note has none.

const getDay = vi.hoisted(() => vi.fn());

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  getNoteDayAgenda: getDay,
}));
vi.mock("../stores/notebox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/notebox")>()),
  indexReady: () => true,
  propertyVersion: () => 0,
  fileTreeVersion: () => 0,
}));

function item(over: Partial<AgendaItem>): AgendaItem {
  return {
    id: "a#m0",
    source: "task",
    is_task: true,
    note_path: "/nb/a.typ",
    note_title: "a",
    text: "",
    date: "2026-11-19",
    created: null,
    done: false,
    tags: [],
    zid: null,
    recurring: false,
    occurrence_index: null,
    recurrence: null,
    ...over,
  };
}

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => getDay.mockReset());

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <OnThisDatePanel path="/nb/Day.typ" />, host);
  await vi.waitFor(() => expect(getDay).toHaveBeenCalledWith("/nb/Day.typ"));
  await new Promise((r) => setTimeout(r, 0));
}

describe("OnThisDatePanel", () => {
  it("lists open tasks before done ones, crossing out the done", async () => {
    getDay.mockResolvedValue({
      date: "2026-11-19",
      items: [
        item({ id: "a#m0", text: "Send draft", done: true }),
        item({ id: "b#m0", text: "Book room" }),
      ],
    });
    await mount();
    const rows = [...host!.querySelectorAll<HTMLElement>(".agenda__item")];
    expect(rows.map((r) => r.querySelector(".agenda__item-text")?.textContent)).toEqual([
      "Book room",
      "Send draft",
    ]);
    expect(rows[1].classList.contains("agenda__item--done")).toBe(true);
  });

  it("explains the date property when the note has none", async () => {
    getDay.mockResolvedValue({ date: null, items: [] });
    await mount();
    expect(host!.textContent).toContain("no date property");
    expect(host!.querySelector(".agenda__item")).toBeNull();
  });
});
