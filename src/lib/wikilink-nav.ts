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
 * `(x, y)`. Offers the three "open as…" destinations. Dismisses on outside
 * click, Escape, scroll, or after an action runs.
 *
 * Built as plain DOM (not a Solid component) so it can be summoned identically
 * from CodeMirror widgets and Solid components. Reuses the shared `.context-menu`
 * styling from styles/layout/context-menu.css.
 */
export function showWikilinkContextMenu(
  x: number,
  y: number,
  target: string,
  label?: string,
): void {
  // Only one wikilink menu at a time — a second right-click moves it.
  document.querySelectorAll(".wikilink-context-menu").forEach((m) => m.remove());

  const menu = document.createElement("div");
  menu.className = "context-menu wikilink-context-menu";
  menu.setAttribute("role", "menu");

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDocMouse, true);
    document.removeEventListener("keydown", onDocKey, true);
    window.removeEventListener("scroll", close, true);
  };

  const addItem = (textKey: string, run: () => void) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "context-menu__item";
    item.setAttribute("role", "menuitem");
    item.textContent = t(textKey);
    item.addEventListener("click", () => {
      close();
      run();
    });
    menu.appendChild(item);
  };

  addItem("wikilink.menu.openNewTab", () => void openInNewTab(target, label));
  addItem("wikilink.menu.openScroll", () => void openInJournalScroll(target));
  addItem("wikilink.menu.openMycelial", () => void openInMycelialView(target));

  const onDocMouse = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  // Position at the cursor, then clamp into the viewport once measured.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
    }
    if (r.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, y - r.height)}px`;
    }
    menu.style.visibility = "";
    menu.querySelector<HTMLElement>(".context-menu__item")?.focus();
  });

  document.addEventListener("mousedown", onDocMouse, true);
  document.addEventListener("keydown", onDocKey, true);
  window.addEventListener("scroll", close, true);
}
