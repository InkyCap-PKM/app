// Keeps every pop-up menu fully on screen.
//
// Menus opened at the pointer are placed with `position: fixed` and an inline
// `left` / `top` at the click. Near the bottom or right edge of the window that
// pushes part of the menu out of view. Each caller used to guess its menu's
// size to pull it back in, and the guesses went stale as menus grew items.
// This module watches for menus appearing (or being moved) and measures the
// real size instead, so callers only say where the menu was asked for.
//
// A menu that would run past the bottom opens upwards from the requested point;
// past the right edge, it opens to the left. If there is not room that way
// either, it is pushed against the far edge, keeping a small margin.
//
// Only fixed-position menus with an inline pixel `left` / `top` are touched.
// Menus anchored inside another element (dropdowns, submenus) lay themselves
// out relative to that element and are left alone.

import { MENU_SELECTOR } from "./menu-nav";

/** Gap kept between a menu and the window edge. */
const VIEWPORT_MARGIN = 8;

/** The position this module last wrote to each menu. A style change that
 *  leaves these values in place is our own write echoing back; any other value
 *  is a new position requested by the menu's owner. */
const placed = new WeakMap<HTMLElement, { left: string; top: string }>();

let observer: MutationObserver | null = null;

/** Install the menu placement watcher. Call once, from App.tsx. */
export function initMenuPlacement(): void {
  if (observer) return;
  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
}

export function destroyMenuPlacement(): void {
  observer?.disconnect();
  observer = null;
}

function handleMutations(records: MutationRecord[]): void {
  const menus = new Set<HTMLElement>();
  for (const record of records) {
    if (record.type === "attributes") {
      const el = record.target;
      if (el instanceof HTMLElement && el.matches(MENU_SELECTOR)) menus.add(el);
      continue;
    }
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches(MENU_SELECTOR)) menus.add(node);
      for (const el of node.querySelectorAll<HTMLElement>(MENU_SELECTOR)) menus.add(el);
    }
  }
  for (const menu of menus) placeMenu(menu);
}

/** Move `menu` so it fits in the window. Exported for tests. */
export function placeMenu(menu: HTMLElement): void {
  if (!menu.isConnected) return;
  const last = placed.get(menu);
  if (last && last.left === menu.style.left && last.top === menu.style.top) return;
  if (getComputedStyle(menu).position !== "fixed") return;

  const rect = menu.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const left = pixels(menu.style.left);
  const top = pixels(menu.style.top);
  if (left !== null) {
    menu.style.left = `${fit(left, rect.width, window.innerWidth)}px`;
  }
  if (top !== null) {
    menu.style.top = `${fit(top, rect.height, window.innerHeight)}px`;
  }
  placed.set(menu, { left: menu.style.left, top: menu.style.top });
}

/** Where a menu of `size` asked for at `start` should begin along an axis of
 *  length `limit`: at `start` if it fits, ending at `start` if that fits
 *  instead, otherwise as close to the far edge as the margin allows. */
export function fit(start: number, size: number, limit: number): number {
  const max = limit - VIEWPORT_MARGIN;
  if (start + size <= max) return Math.max(VIEWPORT_MARGIN, start);
  if (start - size >= VIEWPORT_MARGIN) return start - size;
  return Math.max(VIEWPORT_MARGIN, max - size);
}

function pixels(value: string): number | null {
  if (!value.endsWith("px")) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
