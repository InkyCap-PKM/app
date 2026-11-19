// Asks the Changes & History pane to show one annotation or suggestion. The
// pill menus of both offer "Show in side panel"; the pane listens for the
// request, scrolls the row into view and highlights it.

import { createSignal } from "solid-js";
import { setRightPanelTab, setRightCollapsed } from "../../stores/layout";

/** The row to show, by the source offset of its `#annotation` or
 *  `#suggestion` call (the same offset the pane keys its rows on). */
export interface AnnotationRevealRequest {
  from: number;
  /** Move keyboard focus to the row, rather than leaving it in the editor. */
  focus: boolean;
}

// `equals: false` so clicking the same pill twice asks again (e.g. after the
// user scrolled the pane away from the row).
const [annotationRevealRequest, setAnnotationRevealRequest] =
  createSignal<AnnotationRevealRequest | null>(null, { equals: false });
export { annotationRevealRequest };

/** Open the right panel on Changes & History and show the annotation or
 *  suggestion whose call starts at `from`. With `focus`, keyboard focus moves
 *  to that row. */
export function revealAnnotation(from: number, opts: { focus?: boolean } = {}): void {
  setRightPanelTab("annotations");
  setRightCollapsed(false);
  setAnnotationRevealRequest({ from, focus: opts.focus === true });
}

/** Mark the current request handled, so the pane doesn't act on it again the
 *  next time it mounts. */
export function clearAnnotationRevealRequest(): void {
  setAnnotationRevealRequest(null);
}
