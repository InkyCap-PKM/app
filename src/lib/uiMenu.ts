// Shared placement for pop-up menus (the left sidebar's sort and new-file
// menus, the right panel's link sort, …).

/// Width of a classic scrollbar, measured once, so menus keep clear of it. 0
/// for overlay scrollbars.
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

/// The box a menu must stay in: the viewport less a margin and any right-edge
/// scrollbar. `bounds` narrows it to a region (e.g. the graph canvas), so a
/// menu near its edge turns inward rather than spilling over a side panel. The
/// narrowing is dropped per axis when the menu doesn't fit inside it (a narrow
/// split pane), since clamping into a smaller box would push it out the other
/// side.
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

/// Measure `menuEl` once attached, then place it. Solid `ref` callbacks run
/// before attachment, when sizes read 0 and every clamp would be skipped. The
/// menu stays hidden until placed.
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

/// Place a `.context-menu` at a pointer position (`clientX` / `clientY`), e.g.
/// a right-click with no trigger element. The top-left goes at the point; if
/// that overflows an edge, it flips to the other side of the point (so the
/// cursor stays at a corner), then any overhang is clamped. Fixed positioning
/// lets it escape `overflow: hidden` and sit above later panels (see
/// `anchorPanelMenu`). `bounds` keeps it inside a region (see
/// `placementLimits`).
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

/// Anchor a `.context-menu` to its trigger with fixed positioning: below the
/// trigger, left-aligned, flipped or clamped if it would leave the viewport.
/// Fixed positioning lets the menu escape `overflow: hidden` and size to its
/// content rather than to a narrow column.
///
/// A trigger inside an element with `data-menu-bounds` (the editor column)
/// keeps its menu inside it, as `bounds` does for `anchorPointMenu`.
///
/// Placed on the next frame: `ref` callbacks run before attachment, when sizes
/// read 0 and the clamps would be skipped. The menu stays hidden until placed.
export function anchorPanelMenu(
  triggerEl: HTMLElement | undefined,
  menuEl: HTMLElement,
): void {
  if (!triggerEl) return;
  // `triggerEl` may have unmounted (menu closed) before the measuring frame.
  placeWhenMeasurable(menuEl, () => triggerEl.isConnected, (width, height) => {
    const tr = triggerEl.getBoundingClientRect();
    const bounds = triggerEl.closest<HTMLElement>("[data-menu-bounds]") ?? undefined;
    const v = placementLimits(menuEl, bounds);
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
