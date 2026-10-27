// Keyboard control for every pop-up menu in the app. A menu opened with the
// mouse must be usable from the keyboard, and there are dozens of menus (sort
// menus, right-click menus, the notebox switcher, pill and table menus,
// spellcheck), so this handles all of them; a new menu gets it by using one of
// the surfaces below.
//
//   ↑ ↓         move through the items, wrapping at the ends
//   Home End    first / last item
//   Enter Space activate the current item
//   → ←         enter / leave a submenu
//   Escape      close (handled by the menu itself; see clickOutside.ts)
//
// It listens on the document in the capture phase, because focus is usually
// elsewhere when a menu opens (a right-click in the editor leaves the caret
// focused), and so keys don't reach the editor underneath. Only a text field
// inside the menu (a filter box) keeps its own keys.
//
// Navigation moves real focus onto the items, which are buttons, so screen
// readers announce them and Enter means "this one". Focus returns where it was
// when the menu closes.
//
// The current item is marked `.is-kbd-active`, which the stylesheets paint
// instead of `:focus-visible`: browsers don't treat focus moved by script after
// a click as visible, so arrow keys would move focus with nothing drawn. The
// mark appears only for keyboard-caused focus, so a menu that focuses its first
// item on opening (the pill menu) shows no stray cursor. While the arrows are
// in use the menu has `.is-kbd-nav`, which turns off the hover highlight;
// moving the mouse ends it.

/**
 * Menu surfaces as (container, item) selector pairs; a menu using one of these
 * gets keyboard control. The only list, apart from the hover rule in
 * styles/layout/context-menu.css.
 */
const MENU_SURFACES: ReadonlyArray<{ menu: string; item: string }> = [
  // The shared app menu: panel sort menus, right-click menus, Dropdown's
  // popup, the wikilink and spellcheck menus drawn from CodeMirror.
  { menu: ".context-menu", item: ".context-menu__item" },
  // Visual editor: the pill menu and the selection toolbar's overflow menu.
  { menu: ".cm-typst-pill-menu", item: ".cm-typst-pill-menu-item" },
  { menu: ".selection-toolbar__menu", item: ".selection-toolbar__menu-item" },
  // Pane/tab bar menu and the mycelial graph's node menu.
  { menu: ".tab-bar__menu-popup", item: ".tab-bar__menu-item" },
  { menu: ".mycelial-context-menu", item: ".mycelial-context-menu__item" },
];

/** Matches the container of any menu surface above. lib/menu-placement.ts
 *  uses it to keep the same menus on screen. */
export const MENU_SELECTOR = MENU_SURFACES.map((s) => s.menu).join(", ");

/** A menu can opt out with `data-menu-nav="off"` when it drives its own keys. */
const OPT_OUT = '[data-menu-nav="off"]';

/** Marks the item the keyboard is on. The same class the file tree and the
 *  list panels use for their keyboard cursor (see lib/list-nav.ts). */
const ACTIVE_CLASS = "is-kbd-active";

/** Marks a menu the keyboard is driving, so the stylesheets can stand the
 *  hover highlight down until the mouse moves again. */
const KBD_NAV_CLASS = "is-kbd-nav";

/** Where focus was before the keyboard entered a menu, so it can be restored. */
let focusBeforeMenu: HTMLElement | null = null;
/** Watches for the entered menu leaving the DOM, to restore focus. */
let closeWatcher: MutationObserver | null = null;
/**
 * Whether the last input was a key. Focus inside a menu is marked only then,
 * not for focus set by script or a click.
 */
let lastInputWasKey = false;
/** Set while a menu carries the keyboard-driving class, so the mousemove
 *  listener has nothing to do the rest of the time. */
let keyboardDriving = false;

/** Install the menu keyboard controller. Call once, from App.tsx. */
export function initMenuNav(): void {
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("focusin", handleFocusIn, true);
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("mousemove", handleMouseMove, true);
}

export function destroyMenuNav(): void {
  document.removeEventListener("keydown", handleKeyDown, true);
  document.removeEventListener("focusin", handleFocusIn, true);
  document.removeEventListener("pointerdown", handlePointerDown, true);
  document.removeEventListener("mousemove", handleMouseMove, true);
  clearActiveMarks();
  releaseToMouse();
  stopWatching();
  lastInputWasKey = false;
}

function handlePointerDown(): void {
  lastInputWasKey = false;
}

/** The mouse moving hands the cursor back to it: the keyboard's mark goes,
 *  and the hover highlight is allowed to show again. */
function handleMouseMove(): void {
  if (!keyboardDriving) return;
  lastInputWasKey = false;
  clearActiveMarks();
  releaseToMouse();
}

function releaseToMouse(): void {
  keyboardDriving = false;
  for (const el of document.querySelectorAll<HTMLElement>(`.${KBD_NAV_CLASS}`)) {
    el.classList.remove(KBD_NAV_CLASS);
  }
}

/**
 * Whether any menu is open, so a dismiss handler can tell whether Escape has
 * something to close (see clickOutside.ts).
 */
export function menuIsOpen(): boolean {
  return openMenu() !== null;
}

/**
 * Keep the mark on whatever has focus in a menu, so it stays right when an item
 * is reached by Tab or a click.
 */
function handleFocusIn(e: FocusEvent): void {
  clearActiveMarks();
  if (!lastInputWasKey) return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  for (const surface of MENU_SURFACES) {
    const menu = target.closest<HTMLElement>(surface.menu);
    if (!menu || menu.closest(OPT_OUT)) continue;
    const item = target.closest<HTMLElement>(surface.item);
    if (item && menu.contains(item)) item.classList.add(ACTIVE_CLASS);
    return;
  }
}

/** Drop the mark wherever it is. Cheap: at most one item carries it. */
function clearActiveMarks(): void {
  for (const el of document.querySelectorAll<HTMLElement>(`.${ACTIVE_CLASS}`)) {
    // Leave the list panels' own cursor alone — they own the same class on
    // rows that are not menu items (lib/list-nav.ts).
    if (MENU_SURFACES.some((s) => el.closest(s.menu))) el.classList.remove(ACTIVE_CLASS);
  }
}

/** Is the element on screen? Menus are removed when closed, but a menu waiting
 *  to be measured is hidden rather than absent (see uiMenu.ts). */
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && el.style.visibility !== "hidden";
}

/** A menu on screen, with the selector that finds its items. */
interface OpenMenu {
  el: HTMLElement;
  menuSelector: string;
  itemSelector: string;
}

/**
 * The menu the keys belong to: with focus inside a menu, the innermost (a
 * submenu the keyboard entered, not one merely open beside the current item);
 * otherwise the last visible menu, the most recently opened, skipping submenus
 * nested in another menu's item.
 */
function openMenu(): OpenMenu | null {
  const active = document.activeElement;
  let last: OpenMenu | null = null;
  let focused: OpenMenu | null = null;
  for (const surface of MENU_SURFACES) {
    for (const el of document.querySelectorAll<HTMLElement>(surface.menu)) {
      if (el.closest(OPT_OUT)) continue;
      if (!isVisible(el)) continue;
      const candidate = { el, menuSelector: surface.menu, itemSelector: surface.item };
      if (!isNested(el) && (!last || follows(last.el, el))) last = candidate;
      if (active && el.contains(active) && (!focused || follows(focused.el, el))) {
        focused = candidate;
      }
    }
  }
  return focused ?? last;
}

/** Is this menu drawn inside another menu, as a nested submenu is? */
function isNested(menu: HTMLElement): boolean {
  const parent = menu.parentElement;
  return !!parent && MENU_SURFACES.some((s) => parent.closest(s.menu));
}

/** Does `b` come after `a` in document order? A nested element follows its
 *  ancestor, so "later" also means "deeper". */
function follows(a: HTMLElement, b: HTMLElement): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** The items the keyboard can land on: visible, not disabled, and this
 *  menu's own rather than a submenu's nested inside one of its items. */
function itemsOf(menu: OpenMenu): HTMLElement[] {
  return Array.from(menu.el.querySelectorAll<HTMLElement>(menu.itemSelector)).filter(
    (el) =>
      el.closest(menu.menuSelector) === menu.el &&
      el.getClientRects().length > 0 &&
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-disabled") !== "true" &&
      !el.classList.contains("is-disabled"),
  );
}

/** The visible submenu an item holds, if any: the menu the → key enters. */
function submenuOf(item: HTMLElement): OpenMenu | null {
  for (const surface of MENU_SURFACES) {
    const el = item.querySelector<HTMLElement>(surface.menu);
    if (el && isVisible(el) && !el.closest(OPT_OUT)) {
      return { el, menuSelector: surface.menu, itemSelector: surface.item };
    }
  }
  return null;
}

/** The item of an outer menu that holds `menu`, if it is a submenu: where the
 *  ← key goes back to. */
function parentItemOf(menu: OpenMenu): HTMLElement | null {
  for (const surface of MENU_SURFACES) {
    const item = menu.el.parentElement?.closest<HTMLElement>(surface.item) ?? null;
    if (item && item.closest(surface.menu) !== menu.el) return item;
  }
  return null;
}

/** True when the key should be left to a text field the user is typing in. */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
  );
}

/**
 * Focus a menu item, making a plain `<div>` focusable first. The menu stays
 * keyboard-driven until the mouse moves.
 */
function focusItem(item: HTMLElement): void {
  if (!item.hasAttribute("tabindex") && item.tagName !== "BUTTON" && item.tagName !== "A") {
    item.tabIndex = -1;
  }
  for (const surface of MENU_SURFACES) {
    const menu = item.closest<HTMLElement>(surface.menu);
    if (menu) {
      menu.classList.add(KBD_NAV_CLASS);
      keyboardDriving = true;
      break;
    }
  }
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest" });
}

/** Remember where focus was, and put it back when `menu` leaves the DOM. */
function watchForClose(menu: HTMLElement): void {
  stopWatching();
  const active = document.activeElement;
  focusBeforeMenu = active instanceof HTMLElement && !menu.contains(active) ? active : null;
  const parent = menu.parentNode;
  if (!parent) return;
  closeWatcher = new MutationObserver(() => {
    if (menu.isConnected) return;
    const previous = focusBeforeMenu;
    stopWatching();
    // Only reclaim focus if the closing menu took it with it; a menu item that
    // moved focus somewhere deliberate (back into the editor, say) keeps it.
    const now = document.activeElement;
    if (previous?.isConnected && (now === null || now === document.body)) {
      previous.focus({ preventScroll: true });
    }
  });
  closeWatcher.observe(parent, { childList: true });
}

function stopWatching(): void {
  closeWatcher?.disconnect();
  closeWatcher = null;
  focusBeforeMenu = null;
}

function handleKeyDown(e: KeyboardEvent): void {
  // Any key, Tab included: focus that moves from here on is the keyboard's.
  lastInputWasKey = true;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const navKey =
    e.key === "ArrowDown" ||
    e.key === "ArrowUp" ||
    e.key === "ArrowRight" ||
    e.key === "ArrowLeft" ||
    e.key === "Home" ||
    e.key === "End" ||
    e.key === "Enter" ||
    e.key === " ";
  if (!navKey) return;

  const menu = openMenu();
  if (!menu) {
    stopWatching();
    return;
  }
  // A field inside the menu keeps its keys; the editor under it doesn't.
  if (inTextField(e.target) && menu.el.contains(e.target as Node)) return;

  const items = itemsOf(menu);
  if (items.length === 0) return;

  const active = document.activeElement;
  const current = items.findIndex((el) => el === active || el.contains(active as Node));

  // Enter, Space and the side arrows are only taken once the keyboard is on an
  // item.
  if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
    if (current < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const submenu = submenuOf(items[current]);
    if (submenu) {
      const first = itemsOf(submenu)[0];
      if (first) focusItem(first);
      return;
    }
    if (e.key !== "ArrowRight") items[current].click();
    return;
  }
  if (e.key === "ArrowLeft") {
    if (current < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const parent = parentItemOf(menu);
    if (parent) focusItem(parent);
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  if (current < 0) watchForClose(menu.el);

  let next: number;
  switch (e.key) {
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    case "ArrowDown":
      next = current < 0 ? 0 : (current + 1) % items.length;
      break;
    default: // ArrowUp
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      break;
  }
  focusItem(items[next]);
}
