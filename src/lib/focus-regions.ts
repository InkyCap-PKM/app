// Keyboard navigation between regions: the left sidebar, each editor pane, the
// right panel and the status bar. F6 / Shift+F6 cycle through the visible
// regions (commands in commands.ts), Ctrl+Shift+0 goes to the active editor,
// and Escape in another region returns to the editor.
//
// A region is an element with `data-focus-region="<kind>"`. The order is
// document order, hidden panels drop out, and each split pane is its own
// "editor" region.

import { activeEditorView } from "../stores/editor";
import { distractionFree, setDistractionFree } from "../stores/layout";

export type FocusRegionKind = "sidebar" | "editor" | "right-panel" | "status-bar";

/** Visible focus regions in document order. Off-screen ones (collapsed
 *  sidebar/panel) have no client rects and are filtered out. */
function regions(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-focus-region]"),
  ).filter((el) => el.getClientRects().length > 0);
}

/** Index of the region currently containing focus, or -1. */
function currentRegionIndex(list: HTMLElement[]): number {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return -1;
  return list.findIndex((r) => r === active || r.contains(active));
}

/**
 * Focus a region: its editor, a designated entry element, its first focusable
 * child, or else the region itself (made focusable).
 */
function focusRegion(el: HTMLElement): void {
  const cm = el.querySelector<HTMLElement>(".cm-content");
  if (cm) {
    cm.focus();
    return;
  }
  const entry =
    el.querySelector<HTMLElement>("[data-focus-entry]") ??
    el.querySelector<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
  if (entry) {
    entry.focus();
    return;
  }
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  el.focus();
}

/**
 * Focus the next (`dir: 1`) or previous (`dir: -1`) visible region, wrapping.
 * With no region focused, go to the first (forward) or last (back).
 */
export function cycleRegion(dir: 1 | -1): void {
  const list = regions();
  if (list.length === 0) return;
  const cur = currentRegionIndex(list);
  const next =
    cur < 0
      ? dir === 1
        ? 0
        : list.length - 1
      : (cur + dir + list.length) % list.length;
  focusRegion(list[next]);
}

/** Focus the active editor. Uses the live editor handle so it targets the
 *  focused pane's editor specifically (not merely the first one in the DOM). */
export function focusEditor(): void {
  const handle = activeEditorView();
  if (handle) {
    handle.view.focus();
    return;
  }
  const editor = regions().find((r) => r.dataset.focusRegion === "editor");
  if (editor) focusRegion(editor);
}

// Tab strips that Ctrl+PageDown / Ctrl+PageUp cycle when their region has
// focus: the sidebar's mode bar and the right panel's tabs. Each is a row of
// tab buttons in a `[data-panel-tablist]` container with an `--active` class on
// the current one, so cycling clicks the next or previous one.
const PANEL_TABLISTS: Record<string, { tab: string; activeClass: string }> = {
  sidebar: { tab: ".left-sidebar__mode-btn", activeClass: "left-sidebar__mode-btn--active" },
  "right-panel": { tab: ".right-panel__tab", activeClass: "right-panel__tab--active" },
};

/**
 * Cycle the focused panel's tab strip. Returns true if it did (so the caller
 * prevents the default); false outside a panel with tabs, leaving the key's
 * default behaviour.
 */
function cyclePanelTabs(dir: 1 | -1): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const region = active.closest<HTMLElement>("[data-focus-region]");
  const cfg = region?.dataset.focusRegion ? PANEL_TABLISTS[region.dataset.focusRegion] : undefined;
  if (!region || !cfg) return false;
  const list = region.querySelector<HTMLElement>("[data-panel-tablist]");
  if (!list) return false;
  const tabs = Array.from(list.querySelectorAll<HTMLElement>(cfg.tab)).filter(
    (b) => b.tagName === "BUTTON" && b.getClientRects().length > 0,
  );
  if (tabs.length === 0) return false;
  let idx = tabs.findIndex((b) => b.classList.contains(cfg.activeClass));
  if (idx < 0) idx = 0;
  const target = tabs[(idx + dir + tabs.length) % tabs.length];
  target.click();
  target.focus();
  return true;
}

/**
 * Navigation keys, handled in the bubble phase so anything that uses them first
 * wins:
 * - Escape in distraction-free mode returns to the regular layout.
 * - Escape in a region other than the editor returns to the editor (text inputs
 *   keep their own Escape).
 * - Ctrl+PageDown / Ctrl+PageUp cycle the focused panel's tabs, and are left
 *   alone elsewhere.
 */
function handleNavKeys(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;

  // Distraction-free mode: Escape returns to the regular layout. Overlays and
  // the editor's popups prevent the default on Escape, so they still win (the
  // `defaultPrevented` check above). Text inputs keep their own Escape; the
  // editor doesn't, so Escape while writing exits. Escape never enters this
  // mode.
  if (e.key === "Escape" && distractionFree() && active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") {
    e.preventDefault();
    setDistractionFree(false);
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "PageDown" || e.key === "PageUp")) {
    if (cyclePanelTabs(e.key === "PageDown" ? 1 : -1)) e.preventDefault();
    return;
  }

  if (e.key === "Escape") {
    if (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable) return;
    const region = active.closest<HTMLElement>("[data-focus-region]");
    if (!region || region.dataset.focusRegion === "editor") return;
    e.preventDefault();
    focusEditor();
  }
}

/**
 * Register the navigation key handler (Escape to editor, Ctrl+PageUp/Down).
 * Call once from App.tsx; F6, Shift+F6 and Ctrl+Shift+0 are commands and need
 * nothing here.
 */
export function initFocusRegions(): () => void {
  document.addEventListener("keydown", handleNavKeys);
  return () => document.removeEventListener("keydown", handleNavKeys);
}
