// Keyboard control for every pop-up menu in the app, in one place.
//
// A menu opened with the mouse has to be finishable with the keyboard — that
// is how every menu on the desktop behaves, and the app has around thirty of
// them: panel sort menus, right-click menus in the file tree and collection
// table, the notebox switcher, the visual editor's pill and table menus, the
// spellcheck suggestions. Wiring arrow keys into each one separately would be
// thirty chances to do it differently, so this module does it once for all of
// them and new menus inherit it by using one of the surfaces below.
//
//   ↑ ↓         move through the items, wrapping at the ends
//   Home End    first / last item
//   Enter Space activate the item the keyboard is on
//   → ←         enter / leave a submenu
//   Escape      dismiss (owned by the menu itself — see clickOutside.ts)
//
// It listens on the document in capture phase because a menu is usually opened
// while the focus is somewhere else entirely: a right-click in the editor
// leaves the caret focused, so there is no element on the menu that would
// receive the first arrow key. Capture also means the key never reaches the
// editor underneath, so ↓ moves through the menu instead of moving the caret.
// That editor is a contentEditable element, so being in a text field is not
// by itself a reason to stand aside: only a field *inside* the menu (a filter
// box) keeps its own keys.
//
// Navigation moves real DOM focus onto the item. Menu items are buttons, so
// focus is what announces them to a screen reader and what makes Enter mean
// "this one". The focus that was in place before the menu was entered is put
// back when the menu closes, so picking a sort order does not leave the
// writer's cursor behind.
//
// The item you are on is marked with `.is-kbd-active`, mirrored onto whatever
// holds focus inside the menu. That class, not `:focus-visible`, is what the
// stylesheets paint. `:focus-visible` is a browser guess about whether focus
// "should" be shown, and after a mouse click it answers no — including for
// focus moved by script, which is every step of this navigation. The result
// was arrow keys that worked silently: the focus really was moving, nothing
// drew it, and the first Tab suddenly revealed a cursor several rows down
// from where the user thought they were. A class we set ourselves cannot
// disagree with where the focus actually is.

/**
 * The menu surfaces, as (container, item) selector pairs. A menu whose markup
 * uses one of these class pairs gets keyboard control for free. Keep this list
 * in step when a new kind of menu appears — it is the one registry.
 */
const MENU_SURFACES: ReadonlyArray<{ menu: string; item: string }> = [
  // The shared app menu: panel sort menus, right-click menus, Dropdown's
  // popup, the wikilink and spellcheck menus drawn from CodeMirror.
  { menu: ".context-menu", item: ".context-menu__item" },
  // Visual editor: the pill menu and the selection toolbar's overflow menu.
  { menu: ".cm-typst-pill-menu", item: ".cm-typst-pill-menu-item" },
  { menu: ".selection-toolbar__menu", item: ".selection-toolbar__menu-item" },
  // Table cell menu, drawn as plain DOM with inline styles.
  { menu: ".cm-table-context-menu", item: "button" },
  // Pane/tab bar menu and the mycelial graph's node menu.
  { menu: ".tab-bar__menu-popup", item: ".tab-bar__menu-item" },
  { menu: ".mycelial-context-menu", item: ".mycelial-context-menu__item" },
];

/** A menu can opt out with `data-menu-nav="off"` when it drives its own keys. */
const OPT_OUT = '[data-menu-nav="off"]';

/** Marks the item the keyboard is on. The same class the file tree and the
 *  list panels use for their keyboard cursor (see lib/list-nav.ts). */
const ACTIVE_CLASS = "is-kbd-active";

/** Where focus was before the keyboard entered a menu, so it can be restored. */
let focusBeforeMenu: HTMLElement | null = null;
/** Watches for the entered menu leaving the DOM, to restore focus. */
let closeWatcher: MutationObserver | null = null;

/** Install the menu keyboard controller. Call once, from App.tsx. */
export function initMenuNav(): void {
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("focusin", handleFocusIn, true);
}

export function destroyMenuNav(): void {
  document.removeEventListener("keydown", handleKeyDown, true);
  document.removeEventListener("focusin", handleFocusIn, true);
  clearActiveMarks();
  stopWatching();
}

/** Is any menu on one of the surfaces above open right now? Lets a
 *  dismissal handler that outlives its menu tell whether Escape has
 *  something to close (see clickOutside.ts). */
export function menuIsOpen(): boolean {
  return openMenu() !== null;
}

/** Keep the visible mark on whatever holds focus inside a menu. Driven by
 *  focus rather than by the arrow keys themselves so it stays right when the
 *  user reaches an item some other way — Tab, or a click. */
function handleFocusIn(e: FocusEvent): void {
  clearActiveMarks();
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
 * The menu the keys belong to. When the focus is inside a menu, that menu —
 * the innermost one, so a submenu the keyboard has entered wins over the menu
 * that holds it, but a submenu merely open beside the item the keyboard is on
 * does not. Otherwise the last visible menu in document order, which is the
 * one opened most recently; a submenu nested inside another menu's item is
 * passed over there, since the keyboard enters the outer menu first.
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

/** Move focus onto a menu item, making it focusable first if it is a plain
 *  `<div>` rather than a button. */
function focusItem(item: HTMLElement): void {
  if (!item.hasAttribute("tabindex") && item.tagName !== "BUTTON" && item.tagName !== "A") {
    item.tabIndex = -1;
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
  // A filter box or other field inside the menu owns its own keys. A field
  // underneath the menu — the editor a right-click menu was opened from — does
  // not: the menu is what the user is looking at.
  if (inTextField(e.target) && menu.el.contains(e.target as Node)) return;

  const items = itemsOf(menu);
  if (items.length === 0) return;

  const active = document.activeElement;
  const current = items.findIndex((el) => el === active || el.contains(active as Node));

  // Enter, Space and the sideways arrows are only claimed once the keyboard is
  // actually on an item — otherwise they still belong to whatever the user
  // was typing in.
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
