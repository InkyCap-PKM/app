// Builds the `#bibliography(...)` call that the `/` menu, the command palette
// and the References panel insert, pointing at the bibliography this notebox
// is configured to use (Settings › Citations). They share this so they can
// never disagree about the path. The call names no style: InkyCap gives it the
// default style when compiling, and the bibliography pill can set its own.

import type { EditorView } from "@codemirror/view";
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

/** Whether `source` already calls `#bibliography(...)` outside a `//`
 *  comment. Matches the backend's `already_declares_bibliography`, which
 *  decides whether InkyCap adds a bibliography when compiling. */
export function declaresBibliography(source: string): boolean {
  return source
    .split("\n")
    .some((line) => /#\s*bibliography\s*\(/.test(line.split("//")[0]));
}

/**
 * Add the bibliography call to the end of the note in `view`, on its own line
 * after a blank one, with the caret after it so the new pill is in view. With
 * no bibliography file chosen yet, the caret goes inside the empty quotes
 * instead, for the path. Typst prints the reference list where the call is,
 * so the end of the note is where it reads as a "References" section.
 */
export function appendBibliography(view: EditorView): void {
  const { insert, cursorOffset } = bibliographyInsert();
  const doc = view.state.doc;
  const body = doc.toString();
  const from = body.trimEnd().length;
  const prefix = from === 0 ? "" : "\n\n";
  const text = `${prefix}${insert}\n`;
  const anchor = bibliographyInsertPath() === ""
    ? from + prefix.length + cursorOffset
    : from + text.length;
  view.dispatch({
    changes: { from, to: doc.length, insert: text },
    selection: { anchor },
    scrollIntoView: true,
  });
  view.focus();
}
