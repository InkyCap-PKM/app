// A reusable Solid directive that keeps a floating surface (sort menu,
// dropdown, popup) open until the user deliberately interacts away from it —
// an outside mouse-down, the Escape key, or a viewport resize.
//
// It replaces the older `onMouseLeave` dismissal scattered across the panel
// sort menus, which closed the menu the instant the pointer drifted off it.
// Users found that fragile: nudging the mouse while reaching for an item made
// the menu vanish. Click-outside is the expected desktop behaviour.
//
// Modelled on the dismissal listener inside `Dropdown` (capture-phase
// mousedown, so an inner `stopPropagation` on a trigger button can't swallow
// the dismiss). Because it's a directive, its listener is torn down
// automatically when the menu element unmounts — no manual cleanup at the
// call site.
//
// Usage:
//   <div use:clickOutside={{ onDismiss: () => setOpen(false), ignore: triggerRef }}>
//
// `ignore` is the toggle trigger (or any element) whose clicks must NOT count
// as "outside". Without it, clicking the trigger while the menu is open would
// dismiss the menu via this listener and then immediately reopen it via the
// trigger's own toggle handler, leaving the menu flickering open.

import { onCleanup } from "solid-js";

export interface ClickOutsideOptions {
  onDismiss: () => void;
  /** Element(s) — typically the toggle trigger — whose clicks don't dismiss. */
  ignore?: HTMLElement | undefined | (HTMLElement | undefined)[];
}

export function clickOutside(
  el: HTMLElement,
  value: () => ClickOutsideOptions,
): void {
  const isIgnored = (target: Node, opts: ClickOutsideOptions): boolean => {
    const ignore = opts.ignore;
    if (!ignore) return false;
    const list = Array.isArray(ignore) ? ignore : [ignore];
    return list.some(
      (node) => !!node && (node === target || node.contains(target)),
    );
  };

  const onMouseDown = (e: MouseEvent) => {
    const opts = value();
    const target = e.target as Node;
    if (el.contains(target) || isIgnored(target, opts)) return;
    opts.onDismiss();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") value().onDismiss();
  };
  const onResize = () => value().onDismiss();

  // Capture phase mirrors Dropdown's listener so a trigger's `stopPropagation`
  // can't prevent the dismiss. Resize closes fixed-positioned menus that would
  // otherwise drift away from their anchor.
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize);
  onCleanup(() => {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
  });
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
