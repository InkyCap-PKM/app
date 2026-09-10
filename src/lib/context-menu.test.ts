import { describe, it, expect, afterEach, vi } from "vitest";
import { showContextMenu } from "./context-menu";

// The menu is plain DOM so CodeMirror widgets and Solid components can share
// it; these tests exercise it the same way — build one, poke the document.

const menu = () => document.querySelector<HTMLElement>(".context-menu");
const items = () => [...document.querySelectorAll<HTMLButtonElement>(".context-menu__item")];

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.innerHTML = "";
});

describe("showContextMenu", () => {
  it("renders items, hints and separators with the shared menu markup", () => {
    showContextMenu(10, 20, [
      { label: "Open", run: () => {} },
      "separator",
      { hint: "Nothing here" },
      { label: "Delete", run: () => {}, danger: true },
    ]);
    const m = menu();
    expect(m).not.toBeNull();
    expect(m!.getAttribute("role")).toBe("menu");
    expect(m!.style.left).toBe("10px");
    expect(m!.style.top).toBe("20px");
    expect(items().map((i) => i.textContent)).toEqual(["Open", "Delete"]);
    expect(items()[1].classList.contains("context-menu__item--danger")).toBe(true);
    expect(items().every((i) => i.getAttribute("role") === "menuitem")).toBe(true);
    expect(m!.querySelector(".context-menu__separator")).not.toBeNull();
    expect(m!.querySelector(".context-menu__hint")?.textContent).toBe("Nothing here");
  });

  it("runs the clicked item and closes", () => {
    const run = vi.fn();
    showContextMenu(0, 0, [{ label: "Go", run }]);
    items()[0].click();
    expect(run).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("closes on Escape without running anything", () => {
    const run = vi.fn();
    showContextMenu(0, 0, [{ label: "Go", run }]);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(esc);
    expect(menu()).toBeNull();
    expect(esc.defaultPrevented).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("closes on a mousedown outside but not inside", () => {
    showContextMenu(0, 0, [{ label: "Go", run: () => {} }]);
    items()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it("replaces an open menu instead of stacking a second one", () => {
    showContextMenu(0, 0, [{ label: "A", run: () => {} }]);
    showContextMenu(0, 0, [{ label: "B", run: () => {} }]);
    const all = document.querySelectorAll(".context-menu");
    expect(all.length).toBe(1);
    expect(all[0].textContent).toBe("B");
  });
});
