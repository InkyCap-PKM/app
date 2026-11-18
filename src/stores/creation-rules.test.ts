import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreationRule } from "../lib/types";

// A literature-note scaffold (one using `{{ref…}}` variables) asks which
// reference the note is about before anything is created, and a blank name
// pattern then names the note after the reference's title.

const execute = vi.fn();
const listRules = vi.fn();
const listScaffolds = vi.fn();
const pick = vi.fn();
const prompt = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  executeCreationRule: (...args: unknown[]) => execute(...args),
  listCreationRules: () => listRules(),
  listScaffoldEntries: () => listScaffolds(),
}));
vi.mock("./referencePicker", () => ({ pickReference: () => pick() }));
vi.mock("./prompt", () => ({ promptText: () => prompt() }));
vi.mock("./tabs", () => ({ activeNotePath: () => undefined }));

import { triggerCreationRule } from "./creation-rules";

const NEW_NOTE: CreationRule = {
  id: "new-note",
  name: "New Note",
  icon_emoji: "",
  scaffold_path: "new-note.typ",
  target_folder: "",
  filename_pattern: "",
  creation_mode: "create_and_open",
  hotkey: null,
  show_in_toolbar: false,
  description: "",
  builtin: true,
  typst_template: "",
  disabled: false,
};

const OTLET = { key: "otlet1934", title: "Traité de documentation" };

function scaffold(name: string, usesReference: boolean) {
  return { name, path: `/nb/.inkycap/scaffolds/${name}.typ`, kind: "scaffold", builtin: false, uses_reference: usesReference };
}

beforeEach(() => {
  vi.clearAllMocks();
  listRules.mockResolvedValue([NEW_NOTE]);
  listScaffolds.mockResolvedValue([scaffold("new-note", false), scaffold("literature-note-sample", true)]);
  execute.mockResolvedValue({ path: "/nb/Traité de documentation.typ", cursor_offset: null });
});

describe("triggerCreationRule with a literature-note scaffold", () => {
  it("asks for the reference first and names the note after its title", async () => {
    pick.mockResolvedValue(OTLET);
    await triggerCreationRule("new-note", { scaffoldOverride: "literature-note-sample" });
    expect(prompt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "new-note",
      "Traité de documentation",
      undefined,
      "literature-note-sample",
      undefined,
      "otlet1934",
    );
  });

  it("creates nothing when the reference picker is closed", async () => {
    pick.mockResolvedValue(null);
    const result = await triggerCreationRule("new-note", { scaffoldOverride: "literature-note-sample" });
    expect(result).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses a given reference without asking", async () => {
    await triggerCreationRule("new-note", {
      scaffoldOverride: "literature-note-sample",
      reference: OTLET,
    });
    expect(pick).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][5]).toBe("otlet1934");
  });

  it("asks and retries when the backend reports the scaffold needs a reference", async () => {
    // e.g. a rule whose own scaffold wasn't known to use one.
    listScaffolds.mockResolvedValue([]);
    prompt.mockResolvedValue("Reading");
    pick.mockResolvedValue(OTLET);
    execute.mockRejectedValueOnce({ code: "reference-required", message: "A reference is required" });
    await triggerCreationRule("new-note");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][5]).toBe("otlet1934");
  });

  it("leaves other scaffolds alone", async () => {
    prompt.mockResolvedValue("Plain note");
    await triggerCreationRule("new-note");
    expect(pick).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][5]).toBeUndefined();
  });
});
