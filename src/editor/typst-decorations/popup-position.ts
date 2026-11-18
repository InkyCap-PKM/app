// Placement for editor popups anchored to a rectangle: the wikilink and
// citation suggestions, the `/` palette and the paste-as-URL menu (at the
// caret), and the selection toolbar and its two submenus. Each is a `position:
// fixed` element in `document.body`. The popup is measured, moved to the other
// side when it doesn't fit, and kept on screen on both axes.
//
// The geometry is in `computePlacement`, which can be unit-tested without
// layout (jsdom measures everything as 0×0); `positionPopupAtAnchor` measures
// and applies it.

/** Anchor rectangle — e.g. a caret rect from `EditorView.coordsAtPos`. */
export interface AnchorCoords {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Measured size of the popup being placed. */
export interface PopupSize {
  width: number;
  height: number;
}

/** Available space to stay inside — the browser viewport in practice. */
export interface Viewport {
  width: number;
  height: number;
}

/** Which side of the anchor the popup opens on. */
export type PlacementSide = "above" | "below";

export interface PlacementOptions {
  /** Side to open on when it fits. Default `"below"`. */
  prefer?: PlacementSide;
  /**
   * Horizontal alignment: `"start"` lines up the left edges, `"center"` centres
   * on the anchor. Default `"start"`.
   */
  align?: "start" | "center";
  /** Distance between the anchor edge and the popup. Default `GAP`. */
  gap?: number;
  /** Minimum breathing room from the viewport edge. Default `MARGIN`. */
  margin?: number;
  /**
   * Limit the popup's height to the room on the side it opens on, so a long
   * popup scrolls rather than covering the anchor or running off screen. The
   * popup needs `overflow-y: auto` in CSS. Default `false`.
   */
  fitHeight?: boolean;
}

export interface Placement {
  top: number;
  left: number;
  /** Side actually used, after any flip. */
  side: PlacementSide;
  /** With `fitHeight`: the height the popup may take on that side. */
  maxHeight?: number;
}

const GAP = 4; // distance between the anchor and the popup edge
const MARGIN = 8; // minimum breathing room from the viewport edge

function clamp(value: number, min: number, max: number): number {
  // When the popup is larger than the viewport, `max` is below `min`; using
  // `min` keeps the top-left corner visible.
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where a popup of `size` should go relative to `anchor` to stay in `viewport`.
 *
 * Opens on the preferred side, flips when that side can't fit it and the other
 * has more room, then keeps both axes within the margins. A popup larger than
 * the viewport is pinned to the top-left margin; popups that can be that large
 * should set `fitHeight`, or `max-height` and `overflow-y: auto` in CSS.
 */
export function computePlacement(
  anchor: AnchorCoords,
  size: PopupSize,
  viewport: Viewport,
  options: PlacementOptions = {},
): Placement {
  const {
    prefer = "below",
    align = "start",
    gap = GAP,
    margin = MARGIN,
    fitHeight = false,
  } = options;

  const spaceBelow = viewport.height - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;

  // Flip only when the preferred side can't fit and the other has more room;
  // otherwise stay and let the clamp keep it on screen.
  let side = prefer;
  if (prefer === "below" && spaceBelow < size.height && spaceAbove > spaceBelow) {
    side = "above";
  } else if (prefer === "above" && spaceAbove < size.height && spaceBelow > spaceAbove) {
    side = "below";
  }

  const room = Math.max(0, (side === "above" ? spaceAbove : spaceBelow) - gap);
  const height = fitHeight ? Math.min(size.height, room) : size.height;

  const rawTop = side === "above" ? anchor.top - height - gap : anchor.bottom + gap;
  const top = clamp(rawTop, margin, viewport.height - height - margin);

  const rawLeft =
    align === "center" ? (anchor.left + anchor.right) / 2 - size.width / 2 : anchor.left;
  const left = clamp(rawLeft, margin, viewport.width - size.width - margin);

  return fitHeight ? { top, left, side, maxHeight: room } : { top, left, side };
}

/**
 * Measure `el` and place it against `coords` with {@link computePlacement}. The
 * element must already have its content. It is shown first (`display`,
 * `"block"` by default; `"flex"` for flex surfaces) so `max-height` applies to
 * the measurement, and `top`/`left` are set in the same task, so the
 * intermediate position is never painted. With `fitHeight`, any earlier height
 * limit is cleared before measuring and the new one is set as `max-height`.
 */
export function positionPopupAtAnchor(
  el: HTMLElement,
  coords: AnchorCoords,
  options: PlacementOptions & { display?: string } = {},
): Placement {
  el.style.display = options.display ?? "block";
  if (options.fitHeight) el.style.maxHeight = "";

  const placement = computePlacement(
    coords,
    { width: el.offsetWidth, height: el.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    options,
  );

  el.style.top = `${placement.top}px`;
  el.style.left = `${placement.left}px`;
  if (placement.maxHeight !== undefined) el.style.maxHeight = `${placement.maxHeight}px`;
  return placement;
}
