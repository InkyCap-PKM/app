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

const MENU_MARGIN = 4;

interface Limits {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/// The box a menu has to stay inside: the viewport, less a small margin and
/// less any right-edge scrollbar.
///
/// `bounds` narrows that to a region within the window — the graph canvas, for
/// instance — so a menu opened near its right or bottom edge turns inward
/// rather than spilling over the side panel or the status bar beyond it. The
/// narrowing is dropped per axis whenever the menu is simply too big to fit
/// inside it (a narrow split pane, say), since clamping into a box smaller
/// than the menu would push it out the opposite side.
function placementLimits(menuEl: HTMLElement, bounds?: HTMLElement): Limits {
  const viewport: Limits = {
    left: MENU_MARGIN,
    top: MENU_MARGIN,
    right: window.innerWidth - MENU_MARGIN - scrollbarWidth(),
    bottom: window.innerHeight - MENU_MARGIN,
  };
  if (!bounds) return viewport;
  const r = bounds.getBoundingClientRect();
  const left = Math.max(viewport.left, r.left + MENU_MARGIN);
  const right = Math.min(viewport.right, r.right - MENU_MARGIN);
  const top = Math.max(viewport.top, r.top + MENU_MARGIN);
  const bottom = Math.min(viewport.bottom, r.bottom - MENU_MARGIN);
  const fitsX = right - left >= menuEl.offsetWidth;
  const fitsY = bottom - top >= menuEl.offsetHeight;
  return {
    left: fitsX ? left : viewport.left,
    right: fitsX ? right : viewport.right,
    top: fitsY ? top : viewport.top,
    bottom: fitsY ? bottom : viewport.bottom,
  };
}

/// Pull a candidate position back until the whole menu is inside `v`. Applied
/// last by both anchors, after each has tried its own preferred placement.
function clampToLimits(
  left: number,
  top: number,
  width: number,
  height: number,
  v: Limits,
): { left: number; top: number } {
  if (left + width > v.right) left = v.right - width;
  if (left < v.left) left = v.left;
  if (top + height > v.bottom) top = v.bottom - height;
  if (top < v.top) top = v.top;
  return { left, top };
}

/// Measure `menuEl` once it has been attached, then position it. Shared by the
/// anchors below: Solid `ref` callbacks fire before the element is in the
/// document, so `offsetWidth`/`offsetHeight` read 0 if measured synchronously,
/// which silently disables every clamp. The menu is held `visibility: hidden`
/// until measured so it never paints at the wrong position.
function placeWhenMeasurable(
  menuEl: HTMLElement,
  stillValid: () => boolean,
  resolve: (width: number, height: number) => { left: number; top: number },
): void {
  menuEl.style.position = "fixed";
  menuEl.style.visibility = "hidden";
  requestAnimationFrame(() => {
    if (!menuEl.isConnected || !stillValid()) return;
    const { left, top } = resolve(menuEl.offsetWidth, menuEl.offsetHeight);
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
    menuEl.style.visibility = "visible";
  });
}

/// Place a `.context-menu` at a pointer position — a right-click in a canvas
/// or any other point with no trigger element to anchor to. `x`/`y` are client
/// coordinates (`MouseEvent.clientX`/`clientY`).
///
/// The menu's top-left goes at the point. If that would run past an edge it
/// flips to the other side of the point, so the cursor stays on a corner of the
/// menu rather than ending up inside it; anything still overhanging is clamped.
/// Fixed positioning is what lets it escape a parent's `overflow: hidden` and
/// sit above panels that come later in the grid — see `anchorPanelMenu` below.
///
/// Pass `bounds` to keep the menu inside a region rather than the whole window,
/// so it stays over the content it belongs to. See `placementLimits`.
export function anchorPointMenu(
  x: number,
  y: number,
  menuEl: HTMLElement,
  bounds?: HTMLElement,
): void {
  placeWhenMeasurable(menuEl, () => true, (width, height) => {
    const v = placementLimits(menuEl, bounds);
    const left = x + width > v.right ? x - width : x;
    const top = y + height > v.bottom ? y - height : y;
    return clampToLimits(left, top, width, height, v);
  });
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
  // `triggerEl` may have unmounted (menu closed) before the measuring frame.
  placeWhenMeasurable(menuEl, () => triggerEl.isConnected, (width, height) => {
    const tr = triggerEl.getBoundingClientRect();
    const v = placementLimits(menuEl);
    // Left-aligned under the trigger; right-align to it if that overflows.
    const left = tr.left + width > v.right ? tr.right - width : tr.left;
    // Below the trigger; above it if that overflows.
    const top =
      tr.bottom + MENU_MARGIN + height > v.bottom
        ? tr.top - height - MENU_MARGIN
        : tr.bottom + MENU_MARGIN;
    return clampToLimits(left, top, width, height, v);
  });
}
