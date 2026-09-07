// Which reference view the Help panel shows.
//
// The signal lives here rather than inside HelpPanel so any part of the UI can
// send the user straight to a particular view (e.g. the empty-tab link that
// opens the Typst markup cheat-sheet). Opening the panel itself is App's job,
// so `openHelpView` sets the view and fires the event App listens for.

import { createSignal } from "solid-js";

export type HelpView = "ui" | "visual" | "markup";

const [helpView, setHelpView] = createSignal<HelpView>("ui");

export { helpView, setHelpView };

/** Reveal the Help panel in the left sidebar, showing `view`. */
export function openHelpView(view: HelpView): void {
  setHelpView(view);
  document.dispatchEvent(new CustomEvent("inkycap:open-help"));
}
