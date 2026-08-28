// Shared viewport-aware placement for editor popups that anchor to a rectangle
// on screen: the wikilink/citation suggestions, the `/` command palette and the
// paste-as-URL menu (all anchored to a caret coordinate), plus the selection
// format toolbar and its two sub-menus (anchored to the selection and to the
// toolbar itself). Each of these is a `position: fixed` element appended to
// `document.body`. Left to its own devices a popup that always opens in one
// direction gets clipped when its anchor sits near a viewport edge, so this
// module measures the popup and flips it to the opposite side when there isn't
// room, then clamps on both axes so it can never run off screen.
//
// The geometry lives in the pure `computePlacement` so it can be unit-tested
// without a layout engine (jsdom reports every element as 0×0);
// `positionPopupAtAnchor` is the thin DOM wrapper that measures and applies.

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
   * Horizontal alignment against the anchor: `"start"` lines the popup's left
   * edge up with the anchor's, `"center"` centres it on the anchor. Default
   * `"start"`.
   */
  align?: "start" | "center";
  /** Distance between the anchor edge and the popup. Default `GAP`. */
  gap?: number;
  /** Minimum breathing room from the viewport edge. Default `MARGIN`. */
  margin?: number;
}

export interface Placement {
  top: number;
  left: number;
  /** Side actually used, after any flip. */
  side: PlacementSide;
}

const GAP = 4; // distance between the anchor and the popup edge
const MARGIN = 8; // minimum breathing room from the viewport edge

function clamp(value: number, min: number, max: number): number {
  // `max` can fall below `min` when the popup is larger than the viewport;
  // biasing to `min` then keeps the top-left corner visible rather than
  // pushing the whole popup off the leading edge.
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Work out where a popup of `size` should sit relative to `anchor` so that it
 * stays inside `viewport`.
 *
 * Opens on the preferred side, flips to the other side when the preferred one
 * can't fit it *and* the other side has more room, then clamps both axes to the
 * viewport margins. A popup taller or wider than the viewport ends up pinned to
 * the top/left margin — callers that can overflow should cap themselves in CSS
 * (`max-height` + `overflow-y: auto`) so the measured size stays sane.
 */
export function computePlacement(
  anchor: AnchorCoords,
  size: PopupSize,
  viewport: Viewport,
  options: PlacementOptions = {},
): Placement {
  const { prefer = "below", align = "start", gap = GAP, margin = MARGIN } = options;

  const spaceBelow = viewport.height - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;

  // Only flip when the preferred side genuinely can't fit the popup and the
  // other side is roomier. When it fits neither way we stay on the preferred
  // side and let the clamp below keep the popup on screen.
  let side = prefer;
  if (prefer === "below" && spaceBelow < size.height && spaceAbove > spaceBelow) {
    side = "above";
  } else if (prefer === "above" && spaceAbove < size.height && spaceBelow > spaceAbove) {
    side = "below";
  }

  const rawTop = side === "above" ? anchor.top - size.height - gap : anchor.bottom + gap;
  const top = clamp(rawTop, margin, viewport.height - size.height - margin);

  const rawLeft =
    align === "center" ? (anchor.left + anchor.right) / 2 - size.width / 2 : anchor.left;
  const left = clamp(rawLeft, margin, viewport.width - size.width - margin);

  return { top, left, side };
}

/**
 * Measure `el` and place it against `coords` via {@link computePlacement}.
 *
 * The element must already hold its final content so the measurement is
 * accurate. This helper reveals it first (`display`, `"block"` by default —
 * pass `"flex"` for flex surfaces) so the measured size honours any CSS
 * `max-height`, then writes `top`/`left` in the same synchronous task, so the
 * browser never paints the intermediate position.
 */
export function positionPopupAtAnchor(
  el: HTMLElement,
  coords: AnchorCoords,
  options: PlacementOptions & { display?: string } = {},
): Placement {
  el.style.display = options.display ?? "block";

  const placement = computePlacement(
    coords,
    { width: el.offsetWidth, height: el.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    options,
  );

  el.style.top = `${placement.top}px`;
  el.style.left = `${placement.left}px`;
  return placement;
}
