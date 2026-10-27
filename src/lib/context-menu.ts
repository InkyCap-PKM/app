// Right-click menu built as plain DOM, for places that show a menu at the pointer without
// a Solid component tree: CodeMirror widgets (wikilink pills, embedded images and media)
// and Solid components that want the same menu. Every caller gets the same markup
// (`.context-menu` / `.context-menu__item`, which also gives keyboard control through
// lib/menu-nav.ts and on-screen placement through lib/menu-placement.ts) and the same
// closing rules: outside click, Escape, scroll, or running an item.

/** An actionable row. `label` is already translated. */
export interface ContextMenuItem {
  label: string;
  run: () => void;
  /** Styled as destructive (`.context-menu__item--danger`). */
  danger?: boolean;
}

/** A non-interactive explanatory line (`.context-menu__hint`) — for saying
 *  why there is nothing to do, rather than showing an empty menu. */
export interface ContextMenuHint {
  hint: string;
}

/** A visual divider between groups of items. */
export type ContextMenuEntry = ContextMenuItem | ContextMenuHint | "separator";

/** Closes the menu currently open, if any. Only one is open at a time. */
let closeOpenMenu: (() => void) | null = null;

/**
 * Show a context menu at `(x, y)`. Only one is open at a time; another
 * right-click moves it. Closes on outside click, Escape, scroll, or after an
 * item runs; `onDismiss` runs when it closes without an item running.
 */
export function showContextMenu(
  x: number,
  y: number,
  entries: ContextMenuEntry[],
  options: { onDismiss?: () => void } = {},
): void {
  closeOpenMenu?.();
  // Set once an item runs; otherwise closing the menu is a dismissal.
  let chosen = false;

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDocMouse, true);
    document.removeEventListener("keydown", onDocKey, true);
    window.removeEventListener("scroll", close, true);
    if (closeOpenMenu === close) closeOpenMenu = null;
    if (!chosen) options.onDismiss?.();
  };
  closeOpenMenu = close;

  for (const entry of entries) {
    if (entry === "separator") {
      const sep = document.createElement("div");
      sep.className = "context-menu__separator";
      menu.appendChild(sep);
    } else if ("hint" in entry) {
      const hint = document.createElement("span");
      hint.className = "context-menu__hint";
      hint.textContent = entry.hint;
      menu.appendChild(hint);
    } else {
      const item = document.createElement("button");
      item.type = "button";
      item.className = entry.danger
        ? "context-menu__item context-menu__item--danger"
        : "context-menu__item";
      item.setAttribute("role", "menuitem");
      item.textContent = entry.label;
      item.addEventListener("click", () => {
        chosen = true;
        close();
        entry.run();
      });
      menu.appendChild(item);
    }
  }

  const onDocMouse = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  // Placed at the cursor; lib/menu-placement.ts keeps it inside the window.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    menu.querySelector<HTMLElement>(".context-menu__item")?.focus();
  });

  document.addEventListener("mousedown", onDocMouse, true);
  document.addEventListener("keydown", onDocKey, true);
  window.addEventListener("scroll", close, true);
}
