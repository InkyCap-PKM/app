// Wikilink navigation and right-click menu. Wikilinks appear in several places
// (visual editor widgets, callout and quote bodies, the property editor, the
// journal scroll); this is the one place that resolves a target to a note and
// opens it, so every right-click gets the same menu and destinations (new tab,
// Journal Scroll tab, Mycelial View tab).

import * as ipc from "./ipc";
import { t } from "./i18n";
import { showContextMenu } from "./context-menu";
import { activeNotePath, openTab } from "../stores/tabs";
import { isEnabled as isScrollEnabled, toggleScroll } from "../stores/journal-scroll";

/** A wikilink destination resolved (or freshly created) to a concrete note. */
interface ResolvedWikilink {
  path: string;
  name: string;
}

/**
 * Create a note for an unresolved link target, named after it. Runs the
 * built-in "New Note" creation rule rather than writing an empty file, so it
 * gets the same scaffold (title, date, zid, heading) and folder as Ctrl+N. The
 * target is used as the file name (overriding the rule's pattern) so
 * `[[target]]` then resolves to it. Returns the new note's path.
 */
export async function createNoteForTarget(target: string): Promise<string> {
  const result = await ipc.executeCreationRule(
    "new-note",
    target,
    undefined,
    undefined,
    activeNotePath(),
  );
  return result.path;
}

/**
 * Resolve a wikilink target to a note, creating it if needed, as a plain
 * left-click in the editor does.
 */
async function resolveOrCreateWikilink(target: string): Promise<ResolvedWikilink> {
  const resolved = await ipc.resolveWikilink(target);
  const path = resolved ?? (await createNoteForTarget(target));
  const name = path.replace(/\.typ$/, "").split("/").pop() ?? target;
  return { path, name };
}

/**
 * Open a wikilink in the active tab (or a new tab with `newTab`). For left and
 * middle clicks; right-click uses {@link showWikilinkContextMenu}.
 */
export async function navigateWikilink(
  target: string,
  label?: string,
  newTab = false,
): Promise<void> {
  try {
    const { path, name } = await resolveOrCreateWikilink(target);
    openTab(
      { type: "file", title: name, path },
      { forceNewTab: newTab, newTabAction: newTab, headingLabel: label },
    );
  } catch (err) {
    console.error("[wikilink-nav] navigate failed:", err);
  }
}

/** Open the wikilink target as a fresh file tab. */
async function openInNewTab(target: string, label?: string): Promise<void> {
  try {
    const { path, name } = await resolveOrCreateWikilink(target);
    openTab(
      { type: "file", title: name, path },
      { forceNewTab: true, newTabAction: true, headingLabel: label },
    );
  } catch (err) {
    console.error("[wikilink-nav] open in new tab failed:", err);
  }
}

/** Open the wikilink target as the anchor of a new Journal Scroll tab. */
async function openInJournalScroll(target: string): Promise<void> {
  try {
    const { path, name } = await resolveOrCreateWikilink(target);
    const tabId = openTab(
      { type: "file", title: name, path },
      { forceNewTab: true, newTabAction: true },
    );
    if (!isScrollEnabled(tabId)) await toggleScroll(tabId, path);
  } catch (err) {
    console.error("[wikilink-nav] open in journal scroll failed:", err);
  }
}

/** Open the wikilink target as the centre of a new Mycelial View tab. */
async function openInMycelialView(target: string): Promise<void> {
  try {
    const { path, name } = await resolveOrCreateWikilink(target);
    openTab(
      { type: "mycelial", title: name, path },
      { forceNewTab: true, newTabAction: true },
    );
  } catch (err) {
    console.error("[wikilink-nav] open in mycelial view failed:", err);
  }
}

/**
 * Show the right-click menu for a wikilink at `(x, y)`, with the three "open
 * as…" destinations. Uses the plain-DOM menu (lib/context-menu.ts), so it works
 * from CodeMirror widgets and Solid components alike.
 */
export function showWikilinkContextMenu(
  x: number,
  y: number,
  target: string,
  label?: string,
): void {
  showContextMenu(x, y, [
    { label: t("wikilink.menu.openNewTab"), run: () => void openInNewTab(target, label) },
    { label: t("wikilink.menu.openScroll"), run: () => void openInJournalScroll(target) },
    { label: t("wikilink.menu.openMycelial"), run: () => void openInMycelialView(target) },
  ]);
}
