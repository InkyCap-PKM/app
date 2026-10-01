// Asks the Changes & History pane to show one annotation. The visual editor
// marks an annotation with only a pill, so clicking the pill opens the pane on
// that comment; the pane listens for the request, scrolls the row into view
// and highlights it.

import { createSignal } from "solid-js";
import { setRightPanelTab, setRightCollapsed } from "../../stores/layout";

/** The annotation to show, by the source offset of its `#annotation` call
 *  (the same offset the pane keys its rows on). */
export interface AnnotationRevealRequest {
  from: number;
}

// `equals: false` so clicking the same pill twice asks again (e.g. after the
// user scrolled the pane away from the row).
const [annotationRevealRequest, setAnnotationRevealRequest] =
  createSignal<AnnotationRevealRequest | null>(null, { equals: false });
export { annotationRevealRequest };

/** Open the right panel on Changes & History and show the annotation whose
 *  call starts at `from`. */
export function revealAnnotation(from: number): void {
  setRightPanelTab("annotations");
  setRightCollapsed(false);
  setAnnotationRevealRequest({ from });
}

/** Mark the current request handled, so the pane doesn't act on it again the
 *  next time it mounts. */
export function clearAnnotationRevealRequest(): void {
  setAnnotationRevealRequest(null);
}
