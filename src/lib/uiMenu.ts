// Shared pop-up menu utilities. Both the left sidebar's filetree-sort/
// new-file/tag-sort menus and the right panel's link-sort menu use the
// exact same placement algorithm — pulling it out of LeftSidebar so we
// don't fork two copies that drift.

/// Anchor a `.context-menu` element to its trigger button using fixed
/// viewport coordinates. Default placement: directly below the trigger,
/// left-aligned to it. The menu is flipped or clamped if the natural
/// position would clip the viewport.
///
/// Using fixed-position placement (rather than `position: absolute` on a
/// wrapper) is important: it lets the menu escape parent `overflow: hidden`
/// regions and size itself to its content rather than to a narrow sidebar
/// column. That's why the right panel's sort menu was wrapping its
/// labels before — `absolute` inherited the panel width.
export function anchorPanelMenu(
  triggerEl: HTMLElement | undefined,
  menuEl: HTMLElement,
): void {
  if (!triggerEl) return;
  const tr = triggerEl.getBoundingClientRect();
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  const margin = 4;
  let left = tr.left;
  if (left + mw > window.innerWidth - margin) {
    left = tr.right - mw;
  }
  if (left < margin) left = margin;
  if (left + mw > window.innerWidth - margin) {
    left = window.innerWidth - mw - margin;
  }
  let top = tr.bottom + 4;
  if (top + mh > window.innerHeight - margin) {
    top = tr.top - mh - 4;
  }
  menuEl.style.position = "fixed";
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
}
