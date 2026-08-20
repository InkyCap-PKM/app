import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCommand,
  unregisterCommand,
  getAllCommands,
  setKeybindingOverrides,
  defaultKeybinding,
  effectiveKeybinding,
  isKeybindingCustomized,
  findCommandByKeybinding,
  primaryKeybinding,
} from "./command-registry";
import { editorReservedCombos } from "../editor/typst-decorations/keymaps";
import { findShortcutConflict } from "./shortcuts";

// A no-op command factory; `execute` is irrelevant to binding resolution.
function cmd(id: string, keybinding?: string | string[]) {
  return {
    id,
    title: id,
    category: "View" as const,
    keybinding,
    execute: () => {},
  };
}

function reset() {
  for (const c of getAllCommands()) unregisterCommand(c.id);
  setKeybindingOverrides(new Map());
}

describe("command registry keybinding override layer", () => {
  beforeEach(reset);

  it("uses the declared keybinding as the effective binding with no override", () => {
    registerCommand(cmd("test:a", "Ctrl+O"));
    expect(effectiveKeybinding("test:a")).toBe("Ctrl+O");
    expect(defaultKeybinding("test:a")).toBe("Ctrl+O");
    expect(isKeybindingCustomized("test:a")).toBe(false);
  });

  it("applies a user override and keeps the default recoverable", () => {
    registerCommand(cmd("test:a", "Ctrl+O"));
    setKeybindingOverrides(new Map([["test:a", "Ctrl+Shift+O"]]));

    expect(effectiveKeybinding("test:a")).toBe("Ctrl+Shift+O");
    expect(defaultKeybinding("test:a")).toBe("Ctrl+O");
    expect(isKeybindingCustomized("test:a")).toBe(true);
    // The dispatcher looks up by effective binding, so the new combo fires and
    // the old one no longer resolves to the command.
    expect(findCommandByKeybinding("Ctrl+Shift+O")?.id).toBe("test:a");
    expect(findCommandByKeybinding("Ctrl+O")).toBeNull();
  });

  it("restores the default when the override is cleared (reset)", () => {
    registerCommand(cmd("test:a", "Ctrl+O"));
    setKeybindingOverrides(new Map([["test:a", "Ctrl+Shift+O"]]));
    setKeybindingOverrides(new Map()); // reset

    expect(effectiveKeybinding("test:a")).toBe("Ctrl+O");
    expect(isKeybindingCustomized("test:a")).toBe(false);
    expect(findCommandByKeybinding("Ctrl+O")?.id).toBe("test:a");
  });

  it("treats a null override as an explicit unbind (default still recoverable)", () => {
    registerCommand(cmd("test:a", "Ctrl+O"));
    setKeybindingOverrides(new Map([["test:a", null]]));

    expect(effectiveKeybinding("test:a")).toBeUndefined();
    expect(isKeybindingCustomized("test:a")).toBe(true);
    expect(defaultKeybinding("test:a")).toBe("Ctrl+O");
    expect(findCommandByKeybinding("Ctrl+O")).toBeNull();
  });

  it("replaces a multi-alias default with a single combo, and reset brings the aliases back", () => {
    registerCommand(cmd("edit:zoom-in", ["Ctrl+=", "Ctrl++", "Ctrl+Shift+="]));
    // All aliases resolve to the command by default.
    expect(findCommandByKeybinding("Ctrl++")?.id).toBe("edit:zoom-in");

    setKeybindingOverrides(new Map([["edit:zoom-in", "Ctrl+Alt+="]]));
    expect(primaryKeybinding(effectiveKeybinding("edit:zoom-in"))).toBe("Ctrl+Alt+=");
    expect(findCommandByKeybinding("Ctrl++")).toBeNull(); // alias dropped while overridden

    setKeybindingOverrides(new Map()); // reset
    expect(findCommandByKeybinding("Ctrl++")?.id).toBe("edit:zoom-in"); // aliases restored
  });

  it("re-applies overrides across a re-registration (locale switch path)", () => {
    registerCommand(cmd("test:a", "Ctrl+O"));
    setKeybindingOverrides(new Map([["test:a", "Ctrl+Shift+O"]]));
    // Simulate the locale-switch re-registration with a fresh (translated) title.
    registerCommand({ ...cmd("test:a", "Ctrl+O"), title: "Ouvrir" });
    expect(effectiveKeybinding("test:a")).toBe("Ctrl+Shift+O");
  });
});

describe("editorReservedCombos", () => {
  it("derives canonical combos from the editor keymap", () => {
    const combos = editorReservedCombos();
    expect(combos).toContain("Ctrl+B"); // Mod-b bold
    expect(combos).toContain("Ctrl+Shift+M"); // Mod-Shift-m inline math
    expect(combos).toContain("Ctrl+Shift+Up"); // heading level up
    // Bare keys (Home, Enter, Tab) never normalize to a bindable global combo.
    expect(combos).not.toContain("Home");
    expect(combos).not.toContain("Enter");
    expect(combos).not.toContain("Tab");
  });
});

describe("findShortcutConflict", () => {
  beforeEach(reset);

  it("reports another command that already owns the combo", () => {
    registerCommand({ ...cmd("file:quick-open", "Ctrl+O"), title: "Quick Open" });
    const conflict = findShortcutConflict("Ctrl+O", "some:other");
    expect(conflict).not.toBeNull();
    expect(conflict!.reserved).toBe(false);
    expect(conflict!.label).toContain("Quick Open");
  });

  it("does not conflict with the command being edited itself", () => {
    registerCommand({ ...cmd("file:quick-open", "Ctrl+O"), title: "Quick Open" });
    expect(findShortcutConflict("Ctrl+O", "file:quick-open")).toBeNull();
  });

  it("flags reserved editor and tab-switch combos", () => {
    const editorConflict = findShortcutConflict("Ctrl+B", "x");
    expect(editorConflict?.reserved).toBe(true);
    const tabConflict = findShortcutConflict("Ctrl+1", "x");
    expect(tabConflict?.reserved).toBe(true);
  });

  it("returns null for a free combo", () => {
    expect(findShortcutConflict("Ctrl+Alt+J", "x")).toBeNull();
  });
});
