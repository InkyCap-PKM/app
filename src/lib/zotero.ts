// Zotero helpers shared by several panels.

import * as ipc from "./ipc";

/**
 * Open a Zotero item in the Zotero app through the `zotero://` scheme. Shared
 * by the References sidebar and the Scroll Context citation list.
 */
export function openZoteroItem(itemKey: string): void {
  const url = `zotero://select/library/items/${encodeURIComponent(itemKey)}`;
  ipc.openUrlExternally(url).catch((err) => console.error("[zotero] failed to open item:", err));
}
