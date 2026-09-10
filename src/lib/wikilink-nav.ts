// Shared wikilink navigation + right-click context menu.
//
// Wikilinks are rendered in several unrelated surfaces — CodeMirror visual
// widgets, callout/quote bodies, the property editor, the journal scroll —
// each previously hand-rolling its own "open" behaviour. This module is the
// single place that resolves a wikilink target to a note and opens it, so
// every surface routes a right-click through the same context menu and the
// same set of destinations (new tab, Journal Scroll tab, Mycelial View tab).

import * as ipc from "./ipc";
import { t } from "./i18n";
import { showContextMenu } from "./context-menu";
import { openTab } from "../stores/tabs";
import { isEnabled as isScrollEnabled, toggleScroll } from "../stores/journal-scroll";

/** A wikilink destination resolved (or freshly created) to a concrete note. */
interface ResolvedWikilink {
  path: string;
  name: string;
}

/**
 * Create a brand-new note for an unresolved wikilink/link target, named after
 * the target. Runs the built-in "New Note" creation rule rather than writing a
 * blank file, so a note born from a wikilink gets the same scaffold — title,
 * date, zid, heading — and folder placement as one made from Ctrl+N or the New
 * Note button. The target is forced as the filename so `[[target]]` resolves
 * to it afterwards (the rule's own filename pattern / ZID auto-title is
 * bypassed). Returns the created note's path.
 */
export async function createNoteForTarget(target: string): Promise<string> {
  const result = await ipc.executeCreationRule("new-note", target);
  return result.path;
}

/** Resolve a wikilink target to a note path, creating the note if it does
 *  not yet exist. Mirrors the resolution the editor performs on plain
 *  left-click so every entry point behaves identically. */
async function resolveOrCreateWikilink(target: string): Promise<ResolvedWikilink> {
  const resolved = await ipc.resolveWikilink(target);
  const path = resolved ?? (await createNoteForTarget(target));
  const name = path.replace(/\.typ$/, "").split("/").pop() ?? target;
  return { path, name };
}

/**
 * Open a wikilink in the active tab (or a new tab when `newTab` is set).
 * This is the plain left-click / middle-click path; right-click goes through
 * {@link showWikilinkContextMenu} instead.
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
 * Show the right-click context menu for a wikilink at viewport coordinates
 * `(x, y)`. Offers the three "open as…" destinations. Built on the shared
 * plain-DOM menu (lib/context-menu.ts) so it can be summoned identically from
 * CodeMirror widgets and Solid components.
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
