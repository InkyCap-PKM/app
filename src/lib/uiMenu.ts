// Shared pop-up menu utilities. Both the left sidebar's filetree-sort/
// new-file/tag-sort menus and the right panel's link-sort menu use the
// exact same placement algorithm — pulling it out of LeftSidebar so we
// don't fork two copies that drift.

/// Width of a classic (non-overlay) scrollbar, measured once from a
/// throwaway element. Used to keep menus clear of a panel's vertical
/// scrollbar rather than hardcoding a gutter guess. Returns 0 for
/// overlay scrollbars (the menu can sit flush with the viewport edge).
let cachedScrollbarWidth: number | null = null;
function scrollbarWidth(): number {
  if (cachedScrollbarWidth !== null) return cachedScrollbarWidth;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;overflow:scroll;width:80px;height:80px";
  document.body.appendChild(probe);
  cachedScrollbarWidth = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return cachedScrollbarWidth;
}

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
///
/// Placement is deferred to the next animation frame: Solid `ref`
/// callbacks fire before the element is attached to the document, so
/// `offsetWidth`/`offsetHeight` read 0 if measured synchronously — which
/// silently disables the viewport clamps and lets the menu run off-screen
/// (notably for right-anchored menus like the References sort control).
/// The menu is held `visibility: hidden` until measured so it never
/// paints at the wrong position.
export function anchorPanelMenu(
  triggerEl: HTMLElement | undefined,
  menuEl: HTMLElement,
): void {
  if (!triggerEl) return;
  menuEl.style.position = "fixed";
  menuEl.style.visibility = "hidden";
  requestAnimationFrame(() => {
    // `triggerEl` may have unmounted (menu closed) before this frame.
    if (!triggerEl.isConnected || !menuEl.isConnected) return;
    const tr = triggerEl.getBoundingClientRect();
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    const margin = 4;
    // A panel docked at the viewport's right edge places its vertical
    // scrollbar against that edge, so keep the menu clear of it.
    const rightLimit = window.innerWidth - margin - scrollbarWidth();
    let left = tr.left;
    if (left + mw > rightLimit) {
      left = tr.right - mw;
    }
    if (left < margin) left = margin;
    if (left + mw > rightLimit) {
      left = rightLimit - mw;
    }
    let top = tr.bottom + 4;
    if (top + mh > window.innerHeight - margin) {
      top = tr.top - mh - 4;
    }
    if (top < margin) top = margin;
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
    menuEl.style.visibility = "visible";
  });
}
