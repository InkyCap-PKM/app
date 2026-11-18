import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render } from "solid-js/web";
import QuickOpen from "./QuickOpen";
import { buildFileList } from "../stores/filelist";
import type { FileTreeNode } from "../lib/types";

// Quick Open's "Create note" row: offered when no note has the typed name,
// and run by Shift+Enter (or Enter when nothing matches) without the mouse.

const trigger = vi.hoisted(() => vi.fn());
const openTab = vi.hoisted(() => vi.fn());
const openCreatedNote = vi.hoisted(() => vi.fn());

vi.mock("../stores/creation-rules", () => ({ triggerCreationRule: trigger }));
vi.mock("../stores/tabs", () => ({ openTab, openCreatedNote }));
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  getNoteIdentifiers: vi.fn(async () => []),
}));

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  trigger.mockReset();
  trigger.mockResolvedValue({ path: "/nb/Athena Otlet.typ", cursor_offset: 12 });
  openTab.mockReset();
  openCreatedNote.mockReset();
});

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

function note(name: string): FileTreeNode {
  return { name, path: `/nb/${name}`, is_dir: false, modified_time: 0 } as FileTreeNode;
}

function mount(names: string[]) {
  buildFileList(names.map(note));
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <QuickOpen visible onClose={() => {}} />, host);
  const input = host.querySelector<HTMLInputElement>(".quick-open__input")!;
  return {
    type(text: string) {
      input.value = text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    },
    press(key: string, shiftKey = false) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
    },
    createRow: () => host!.querySelector<HTMLButtonElement>(".quick-open__create"),
  };
}

describe("QuickOpen create note", () => {
  it("offers the typed name when no note has it", () => {
    const q = mount(["Athena Otlet reading list.typ"]);
    q.type("Athena Otlet");
    expect(q.createRow()?.textContent).toContain("Athena Otlet");
  });

  it("hides the row when a note has the typed name, ignoring case", () => {
    const q = mount(["Athena Otlet.typ"]);
    q.type("athena otlet");
    expect(q.createRow()).toBeNull();
  });

  it("hides the row while the box is empty", () => {
    const q = mount(["Athena Otlet reading list.typ"]);
    expect(q.createRow()).toBeNull();
  });

  it("creates the note on Shift+Enter even with matches listed", async () => {
    const q = mount(["Athena Otlet reading list.typ"]);
    q.type("Athena Otlet");
    q.press("Enter", true);
    await vi.waitFor(() => expect(openCreatedNote).toHaveBeenCalled());
    expect(trigger).toHaveBeenCalledWith("new-note", { name: "Athena Otlet" });
    expect(openCreatedNote.mock.calls[0][0]).toMatchObject({
      title: "Athena Otlet",
      path: "/nb/Athena Otlet.typ",
    });
    expect(openTab).not.toHaveBeenCalled();
  });

  it("opens the highlighted match on plain Enter", () => {
    const q = mount(["Athena Otlet reading list.typ"]);
    q.type("Athena Otlet");
    q.press("Enter");
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/nb/Athena Otlet reading list.typ" }),
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it("creates the note on plain Enter when nothing matches", async () => {
    const q = mount(["Athena Otlet reading list.typ"]);
    q.type("Zettel");
    q.press("Enter");
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledWith("new-note", { name: "Zettel" }));
  });
});
