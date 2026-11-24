// The notebox bibliography's revision: a counter that goes up each time the
// bibliography file is rewritten (the References panel's Refresh re-exports
// the Zotero library). Reading views compile again when it changes, and the
// editor's caches of bibliography keys read the entries again.

import { createSignal } from "solid-js";
import * as ipc from "../lib/ipc";

const [bibliographyRevision, setBibliographyRevision] = createSignal(0);

/** The current revision. Reactive: read it in a resource's source or an
 *  effect to rerun when the bibliography changes. */
export { bibliographyRevision };

/** Rewrite the notebox's bibliography file (re-exporting the Zotero library)
 *  and tell everything that shows citations to read it again. */
export async function refreshBibliography(): Promise<void> {
  await ipc.refreshBibliography();
  setBibliographyRevision((n) => n + 1);
}
