// ---------------------------------------------------------------------------
// Zotero integration helpers shared across panels.
// ---------------------------------------------------------------------------

import * as ipc from "./ipc";

/** Open a Zotero library item in the desktop Zotero application via the
 *  `zotero://` URL scheme. Shared by the References sidebar and the Scroll
 *  Context citation list so both behave identically. */
export function openZoteroItem(itemKey: string): void {
  const url = `zotero://select/library/items/${encodeURIComponent(itemKey)}`;
  ipc.openUrlExternally(url).catch((err) => console.error("[zotero] failed to open item:", err));
}
