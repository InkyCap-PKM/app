import { describe, it, expect } from "vitest";
import { formatKeyCombo } from "./keybindings";

// `formatKeyCombo` turns a KeyboardEvent into the registry's canonical combo
// string. The dispatcher looks the result up in the command registry, so what
// this returns is exactly what a command's `keybinding` must match.
function combo(init: Partial<KeyboardEvent> & { key: string }): string | null {
  return formatKeyCombo(new KeyboardEvent("keydown", init));
}

describe("formatKeyCombo", () => {
  it("formats modifier combos with canonical names and uppercase letters", () => {
    expect(combo({ key: "n", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+N");
    expect(combo({ key: "/", ctrlKey: true })).toBe("Ctrl+/");
    expect(combo({ key: "\\", ctrlKey: true })).toBe("Ctrl+\\");
  });

  it("folds Cmd (metaKey) into Ctrl for cross-platform parity", () => {
    expect(combo({ key: "0", metaKey: true, shiftKey: true })).toBe("Ctrl+Shift+0");
  });

  it("expands arrow keys", () => {
    expect(combo({ key: "ArrowUp", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Up");
  });

  it("returns null for a bare, non-function key (so typing isn't a shortcut)", () => {
    expect(combo({ key: "a" })).toBeNull();
    expect(combo({ key: "Escape" })).toBeNull();
    expect(combo({ key: "PageDown" })).toBeNull();
  });

  it("allows bare function keys as shortcuts (F2 = rename, F6 = cycle regions)", () => {
    expect(combo({ key: "F2" })).toBe("F2");
    expect(combo({ key: "F6" })).toBe("F6");
    expect(combo({ key: "F6", shiftKey: true })).toBe("Shift+F6");
    expect(combo({ key: "F12" })).toBe("F12");
  });

  it("returns null for a bare modifier press", () => {
    expect(combo({ key: "Control", ctrlKey: true })).toBeNull();
    expect(combo({ key: "Shift", shiftKey: true })).toBeNull();
  });
});
