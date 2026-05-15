// ---------------------------------------------------------------------------
// Zotero integration helpers shared across panels.
// ---------------------------------------------------------------------------

import { open as shellOpen } from "@tauri-apps/plugin-shell";

/** Open a Zotero library item in the desktop Zotero application via the
 *  `zotero://` URL scheme. Shared by the References sidebar and the Scroll
 *  Context citation list so both behave identically. */
export function openZoteroItem(itemKey: string): void {
  void shellOpen(`zotero://select/library/items/${itemKey}`);
}
