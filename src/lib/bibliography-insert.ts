// Builds the `#bibliography(...)` call that the `/` menu and the command
// palette insert, pointing at the bibliography this notebox is configured to
// use (Settings › Citations). Both entry points share this so they can never
// disagree about the path.

import { noteboxSettings } from "../stores/settings";
import { normalizePath } from "./paths";

/** Where InkyCap writes the Zotero export; the compiler reads the same file. */
const ZOTERO_EXPORT_PATH = "/.inkycap/zotero-export.bib";
const CALL_PREFIX = '#bibliography("';

/** Notebox-root-absolute path of the configured bibliography. Empty when the
 *  source is a file but no file has been chosen yet, so the caret lands
 *  inside the quotes for the user to type one. */
export function bibliographyInsertPath(): string {
  const citations = noteboxSettings.citations;
  if (citations.source === "zotero") return ZOTERO_EXPORT_PATH;
  const path = normalizePath(citations.bibliography_path?.trim() ?? "");
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

/** The call to insert and where to leave the caret (just after the path). */
export function bibliographyInsert(): { insert: string; cursorOffset: number } {
  const path = bibliographyInsertPath();
  return { insert: `${CALL_PREFIX}${path}")`, cursorOffset: CALL_PREFIX.length + path.length };
}
