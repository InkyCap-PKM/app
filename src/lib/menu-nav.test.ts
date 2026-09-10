import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initMenuNav, destroyMenuNav } from "./menu-nav";

// The menu controller works off the DOM alone (it has to — half the app's
// menus are drawn by CodeMirror as plain elements), so these tests build the
// same markup a menu renders and press keys at the document.

function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

/** A menu of `labels`, plus an outside button that starts with the focus. */
function buildMenu(
  labels: string[],
  opts: { menuClass?: string; itemClass?: string; disabled?: string[] } = {},
) {
  const outside = document.createElement("button");
  outside.textContent = "trigger";
  document.body.appendChild(outside);

  const menu = document.createElement("div");
  menu.className = opts.menuClass ?? "context-menu";
  for (const label of labels) {
    const item = document.createElement("button");
    item.className = opts.itemClass ?? "context-menu__item";
    item.textContent = label;
    if (opts.disabled?.includes(label)) item.disabled = true;
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  outside.focus();
  return { menu, outside };
}

// jsdom reports no layout boxes, so every element would look invisible to the
// controller's visibility filter. Give elements a box for the duration.
let originalRects: (() => DOMRectList) | undefined;

beforeEach(() => {
  originalRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function (this: Element) {
    const list = [{ width: 100, height: 20 }] as unknown as DOMRectList;
    return this.isConnected ? list : ([] as unknown as DOMRectList);
  };
  initMenuNav();
});

afterEach(() => {
  destroyMenuNav();
  if (originalRects) Element.prototype.getClientRects = originalRects;
  document.body.innerHTML = "";
});

const focusedLabel = () => (document.activeElement as HTMLElement)?.textContent;
/** The item carrying the visible keyboard cursor. */
const markedLabel = () =>
  document.querySelector(".is-kbd-active")?.textContent ?? null;

describe("menu keyboard navigation", () => {
  it("enters the menu from wherever the focus was", () => {
    buildMenu(["One", "Two"]);
    expect(focusedLabel()).toBe("trigger");
    press("ArrowDown");
    expect(focusedLabel()).toBe("One");
  });

  it("moves down and up, wrapping at both ends", () => {
    buildMenu(["One", "Two", "Three"]);
    press("ArrowDown");
    press("ArrowDown");
    expect(focusedLabel()).toBe("Two");
    press("ArrowUp");
    expect(focusedLabel()).toBe("One");
    press("ArrowUp");
    expect(focusedLabel()).toBe("Three");
    press("ArrowDown");
    expect(focusedLabel()).toBe("One");
  });

  it("enters at the last item when opened with ArrowUp", () => {
    buildMenu(["One", "Two", "Three"]);
    press("ArrowUp");
    expect(focusedLabel()).toBe("Three");
  });

  it("jumps to the ends with Home and End", () => {
    buildMenu(["One", "Two", "Three"]);
    press("ArrowDown");
    press("End");
    expect(focusedLabel()).toBe("Three");
    press("Home");
    expect(focusedLabel()).toBe("One");
  });

  it("skips disabled items", () => {
    buildMenu(["One", "Two", "Three"], { disabled: ["Two"] });
    press("ArrowDown");
    press("ArrowDown");
    expect(focusedLabel()).toBe("Three");
  });

  it("activates the focused item with Enter", () => {
    const { menu } = buildMenu(["One", "Two"]);
    let clicked = "";
    menu.addEventListener("click", (e) => {
      clicked = (e.target as HTMLElement).textContent ?? "";
    });
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    expect(clicked).toBe("Two");
  });

  it("activates with Space too", () => {
    const { menu } = buildMenu(["One"]);
    let clicks = 0;
    menu.addEventListener("click", () => clicks++);
    press("ArrowDown");
    press(" ");
    expect(clicks).toBe(1);
  });

  it("leaves Enter alone until the keyboard is on an item", () => {
    const { menu } = buildMenu(["One"]);
    let clicks = 0;
    menu.addEventListener("click", () => clicks++);
    const e = press("Enter"); // focus is still on the trigger outside the menu
    expect(clicks).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("stops the arrow key reaching what is underneath the menu", () => {
    buildMenu(["One"]);
    const e = press("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores keys when no menu is open", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const e = press("ArrowDown");
    expect(e.defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe("");
  });

  it("drives the innermost menu when a submenu is open", () => {
    buildMenu(["Parent"]);
    const sub = document.createElement("div");
    sub.className = "context-menu context-menu--submenu";
    const item = document.createElement("button");
    item.className = "context-menu__item";
    item.textContent = "Child";
    sub.appendChild(item);
    document.body.appendChild(sub);
    press("ArrowDown");
    expect(focusedLabel()).toBe("Child");
  });

  it("leaves a menu that drives its own keys alone", () => {
    const { menu } = buildMenu(["One"]);
    menu.setAttribute("data-menu-nav", "off");
    const e = press("ArrowDown");
    expect(e.defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe("trigger");
  });

  it("lets a text field inside a menu keep its own keys", () => {
    const { menu } = buildMenu(["One"]);
    const input = document.createElement("input");
    menu.insertBefore(input, menu.firstChild);
    input.focus();
    const e = press("ArrowDown");
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("drives the menu from a text field underneath it", () => {
    // The spellcheck and selection-toolbar menus open while the editor, a
    // contentEditable element, still holds the focus.
    buildMenu(["One", "Two"]);
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    const e = press("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(focusedLabel()).toBe("One");
  });

  describe("a submenu nested inside an item", () => {
    /** A menu whose middle item holds an open submenu, the way the property
     *  key menu's "Property type" row does. */
    function buildNested() {
      const { menu } = buildMenu(["Rename"]);
      const row = document.createElement("div");
      row.className = "context-menu__item context-menu__item--submenu";
      row.append("Type");
      const sub = document.createElement("div");
      sub.className = "context-menu context-menu--submenu";
      for (const label of ["Auto", "Date"]) {
        const item = document.createElement("button");
        item.className = "context-menu__item";
        item.textContent = label;
        sub.appendChild(item);
      }
      row.appendChild(sub);
      menu.appendChild(row);
      const del = document.createElement("button");
      del.className = "context-menu__item";
      del.textContent = "Delete";
      menu.appendChild(del);
      return { menu, row, sub };
    }

    const focusedText = () => (document.activeElement as HTMLElement)?.firstChild?.textContent;

    it("moves through the outer menu's own items, skipping the submenu's", () => {
      buildNested();
      press("ArrowDown");
      expect(focusedText()).toBe("Rename");
      press("ArrowDown");
      expect(focusedText()).toBe("Type");
      press("ArrowDown");
      expect(focusedText()).toBe("Delete");
    });

    it("enters the submenu with Right and leaves it with Left", () => {
      buildNested();
      press("ArrowDown");
      press("ArrowDown");
      expect(focusedText()).toBe("Type");
      press("ArrowRight");
      expect(focusedText()).toBe("Auto");
      press("ArrowDown");
      expect(focusedText()).toBe("Date");
      press("ArrowUp");
      press("ArrowUp");
      expect(focusedText()).toBe("Date"); // wraps inside the submenu
      press("ArrowLeft");
      expect(focusedText()).toBe("Type");
    });

    it("enters the submenu with Enter instead of clicking the row", () => {
      const { row } = buildNested();
      let clicks = 0;
      row.addEventListener("click", () => clicks++);
      press("ArrowDown");
      press("ArrowDown");
      press("Enter");
      expect(focusedText()).toBe("Auto");
      expect(clicks).toBe(0);
    });

    it("leaves the sideways arrows alone until the keyboard is on an item", () => {
      buildNested();
      const e = press("ArrowRight");
      expect(e.defaultPrevented).toBe(false);
      expect(focusedLabel()).toBe("trigger");
    });
  });

  it("works for a menu that is not the shared .context-menu surface", () => {
    buildMenu(["One", "Two"], {
      menuClass: "cm-typst-pill-menu",
      itemClass: "cm-typst-pill-menu-item",
    });
    press("ArrowDown");
    expect(focusedLabel()).toBe("One");
  });

  // The cue has to be a class we set: browsers do not treat focus moved by
  // script after a mouse click as ":focus-visible", so relying on that left the
  // arrow keys moving an invisible cursor until the first Tab revealed it.
  it("marks the item the keyboard is on", () => {
    buildMenu(["One", "Two", "Three"]);
    press("ArrowDown");
    expect(markedLabel()).toBe("One");
    press("ArrowDown");
    expect(markedLabel()).toBe("Two");
  });

  it("keeps the mark on exactly one item", () => {
    buildMenu(["One", "Two", "Three"]);
    press("ArrowDown");
    press("ArrowDown");
    press("End");
    expect(document.querySelectorAll(".is-kbd-active")).toHaveLength(1);
    expect(markedLabel()).toBe("Three");
  });

  // A menu that focuses its first item as it opens must not show a cursor the
  // user never asked for, beside the row the mouse is on and the checked row.
  it("does not mark an item a menu focuses by script as it opens", () => {
    const { menu } = buildMenu(["One", "Two"]);
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    (menu.firstChild as HTMLElement).focus();
    expect(markedLabel()).toBe(null);
    expect(menu.classList.contains("is-kbd-nav")).toBe(false);
  });

  it("takes the cursor for the keyboard once the arrows are used", () => {
    const { menu } = buildMenu(["One", "Two"]);
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    (menu.firstChild as HTMLElement).focus();
    press("ArrowDown");
    expect(markedLabel()).toBe("Two");
    expect(menu.classList.contains("is-kbd-nav")).toBe(true);
  });

  it("hands the cursor back to the mouse when it moves", () => {
    const { menu } = buildMenu(["One", "Two"]);
    press("ArrowDown");
    expect(markedLabel()).toBe("One");
    menu.children[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(markedLabel()).toBe(null);
    expect(menu.classList.contains("is-kbd-nav")).toBe(false);
    // The keys pick up from where the focus still is.
    press("ArrowDown");
    expect(markedLabel()).toBe("Two");
  });

  it("follows the focus when Tab moves it instead of the arrows", () => {
    const { menu } = buildMenu(["One", "Two"]);
    press("ArrowDown");
    expect(markedLabel()).toBe("One");
    // Tab is the browser's to handle; the mark follows wherever focus lands.
    (menu.children[1] as HTMLElement).focus();
    expect(markedLabel()).toBe("Two");
  });

  it("drops the mark when focus leaves the menu", () => {
    const { outside } = buildMenu(["One"]);
    press("ArrowDown");
    expect(markedLabel()).toBe("One");
    outside.focus();
    expect(markedLabel()).toBe(null);
  });

  it("gives the focus back to the trigger when the menu closes", async () => {
    const { menu, outside } = buildMenu(["One"]);
    press("ArrowDown");
    expect(focusedLabel()).toBe("One");
    menu.remove(); // what closing a menu does
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(outside);
  });
});
