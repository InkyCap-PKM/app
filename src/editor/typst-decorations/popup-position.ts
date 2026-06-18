// Shared viewport-aware placement for editor popups that anchor to a document
// position (wikilink/citation suggestions, the `/` command palette, the
// paste-as-URL menu). Each of these is a `position: fixed` element appended to
// `document.body` and pinned next to a caret coordinate from
// `EditorView.coordsAtPos`. Left to its own devices a popup that always opens
// downward gets clipped when the caret sits near the bottom of the viewport, so
// this helper measures the popup's real height and flips it above the caret
// when there isn't room below.

/** Caret rectangle as returned by `EditorView.coordsAtPos`. */
export interface AnchorCoords {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const GAP = 4; // distance between the caret line and the popup edge
const MARGIN = 8; // minimum breathing room from the viewport edge

/**
 * Position `el` next to a caret coordinate, opening downward by default and
 * flipping above the caret when the popup would otherwise be clipped at the
 * bottom of the viewport. Also clamps horizontally so the popup never runs off
 * the right or left edge.
 *
 * The element must already hold its final content (so its measured height is
 * accurate); this helper sets `display: block` and measures before placing.
 */
export function positionPopupAtAnchor(el: HTMLElement, coords: AnchorCoords): void {
  // Make the element measurable. Callers previously set `display = "block"`
  // themselves at the end of placement; doing it up front lets us read the laid
  // out height (honouring any CSS `max-height`) before deciding which way to open.
  el.style.display = "block";
  const height = el.offsetHeight;
  const width = el.offsetWidth;

  const spaceBelow = window.innerHeight - coords.bottom - MARGIN;
  const spaceAbove = coords.top - MARGIN;

  // Open downward unless it won't fit and there's more room above. When it fits
  // neither way, fall back to the side with more space and let the clamp below
  // keep it on screen.
  const placeAbove = spaceBelow < height && spaceAbove > spaceBelow;

  let top = placeAbove ? coords.top - height - GAP : coords.bottom + GAP;
  // Keep the popup within the viewport even after flipping (e.g. a tall popup
  // with a short caret-to-edge gap on both sides).
  top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, window.innerHeight - height - MARGIN));

  let left = coords.left;
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, window.innerWidth - width - MARGIN));

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}
