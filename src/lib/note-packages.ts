// Adding, removing and fixing a note's Typst package imports from the
// interface (Properties pane, `/` menu, clash warnings). The backend rewrites
// the file, as for property edits; this saves the editor first and reloads it
// and the reading view after.

import * as ipc from "./ipc";
import { flushEditorsAt } from "../stores/editor-writes";

async function rewriteNote(path: string, change: () => Promise<void>): Promise<void> {
  await flushEditorsAt(path);
  await change();
  // The editor reloads the file; the reading view and panes recompile.
  document.dispatchEvent(new CustomEvent("inkycap:note-property-changed", { detail: { path } }));
  document.dispatchEvent(new CustomEvent("inkycap:note-saved", { detail: { path } }));
}

/** Import everything from `spec` in the note, above InkyCap's own import. */
export function addPackageToNote(path: string, spec: string): Promise<void> {
  return rewriteNote(path, () => ipc.addNotePackage(path, spec));
}

/** Remove the note's imports of `spec`, and the template rules that need it. */
export function removePackageFromNote(path: string, spec: string): Promise<void> {
  return rewriteNote(path, () => ipc.removeNotePackage(path, spec));
}

/** Move a clashing `*` import of `spec` above InkyCap's own import. */
export function fixPackageImport(path: string, spec: string): Promise<void> {
  return rewriteNote(path, () => ipc.fixNotePackageImport(path, spec));
}
