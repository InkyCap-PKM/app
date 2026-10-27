// A Solid directive that keeps a floating surface (sort menu, dropdown, popup) open
// until the user clicks outside it, presses Escape or resizes the window. Like
// `Dropdown`'s listener, it listens for mousedown in the capture phase, so a
// trigger's `stopPropagation` can't block it. As a directive it is removed when the
// element unmounts.
//
//   <div use:clickOutside={{ onDismiss: () => setOpen(false), ignore: triggerRef }}>
//
// `ignore` is the trigger (or any element) whose clicks don't count as outside;
// otherwise clicking the trigger would close the menu here and reopen it in the
// trigger's own handler.

import { onCleanup } from "solid-js";
import { menuIsOpen } from "./menu-nav";

export interface ClickOutsideOptions {
  onDismiss: () => void;
  /** Element(s) — typically the toggle trigger — whose clicks don't dismiss. */
  ignore?: HTMLElement | undefined | (HTMLElement | undefined)[];
  /**
   * Selectors for surfaces elsewhere in the DOM that don't count as outside,
   * such as a portalled popup inside this one (a DatePicker's calendar).
   * Matched with `target.closest(selector)`.
   */
  ignoreSelector?: string | string[];
}

export function clickOutside(
  el: HTMLElement,
  value: () => ClickOutsideOptions,
): void {
  const isIgnored = (target: Node, opts: ClickOutsideOptions): boolean => {
    const ignore = opts.ignore;
    const list = ignore ? (Array.isArray(ignore) ? ignore : [ignore]) : [];
    if (list.some((node) => !!node && (node === target || node.contains(target)))) {
      return true;
    }
    const sel = opts.ignoreSelector;
    if (sel) {
      const selectors = Array.isArray(sel) ? sel : [sel];
      const elem =
        target instanceof Element ? target : (target as ChildNode).parentElement;
      if (elem && selectors.some((s) => elem.closest(s))) return true;
    }
    return false;
  };

  const onMouseDown = (e: MouseEvent) => {
    const opts = value();
    const target = e.target as Node;
    if (el.contains(target) || isIgnored(target, opts)) return;
    opts.onDismiss();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // The element exists only while open, so claim the Escape; otherwise the
    // sidebar's Escape-to-editor would also move focus.
    e.preventDefault();
    value().onDismiss();
  };
  const onResize = () => value().onDismiss();

  // Capture phase, as in Dropdown. Resizing closes fixed-position menus that
  // would drift from their anchor.
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize);
  onCleanup(() => {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
  });
}

/**
 * Escape closes a transient surface that can't use the directive: a right-click
 * menu opened by a signal and closed by its component's own click handler. Call
 * once beside that handler with the same close function; it lasts as long as
 * the component.
 *
 * Since it outlives the menu, it asks the menu controller whether one is open:
 * if so the Escape is claimed (so Escape-to-editor and distraction-free mode
 * leave focus alone), otherwise it passes through.
 */
export function dismissOnEscape(close: () => void): void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (menuIsOpen()) e.preventDefault();
    close();
  };
  document.addEventListener("keydown", onKeyDown, true);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
}

// Register `use:clickOutside` with Solid's JSX directive typing so call sites
// type-check (and so TS sees the imported symbol as used).
declare module "solid-js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface Directives {
      clickOutside: ClickOutsideOptions;
    }
  }
}
