// Keyboard region navigation — the backbone of full keyboard access.
//
// The app is divided into a handful of focusable "regions": the left sidebar,
// each editor pane, the right panel, and the status bar. F6 / Shift+F6 cycle
// focus forward / back through whichever regions are currently on screen
// (registered as commands in commands.ts), Ctrl+Shift+0 jumps straight to the
// active editor, and Escape from a non-editor region returns to the editor.
//
// A region is any element tagged `data-focus-region="<kind>"`. Tagging by DOM
// attribute (rather than a hand-maintained list of refs) means the cycle order
// is just document order, collapsed panels drop out automatically (their
// elements leave the DOM / have no layout box), and split panes each
// participate as their own "editor" region with zero extra bookkeeping.

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

/** Move keyboard focus into a region. Prefers, in order: the editable editor
 *  surface, a designated entry element, the first naturally focusable child,
 *  then the region root itself (made programmatically focusable). */
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

/** Cycle focus to the next (`dir: 1`) or previous (`dir: -1`) visible region,
 *  wrapping around. With no region currently focused, enters the first
 *  (forward) or last (back) region. */
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

// Per-region tab strips that Ctrl+PageDown / Ctrl+PageUp cycle once the region
// has focus: the left sidebar's mode bar and the right panel's tab row. Each is
// a uniform set of tab buttons with an `--active` modifier on the current one,
// inside a `[data-panel-tablist]` container, so cycling is just "click the
// next/prev sibling".
const PANEL_TABLISTS: Record<string, { tab: string; activeClass: string }> = {
  sidebar: { tab: ".left-sidebar__mode-btn", activeClass: "left-sidebar__mode-btn--active" },
  "right-panel": { tab: ".right-panel__tab", activeClass: "right-panel__tab--active" },
};

/** Cycle the focused panel's own tab strip (sidebar modes / right-panel tabs).
 *  Returns true if it acted, so the caller knows whether to preventDefault.
 *  No-ops (returns false) when focus isn't in a panel with a tablist — so the
 *  same key keeps its default behaviour everywhere else. */
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

/** Contextual navigation keys handled in the bubble phase so anything that
 *  legitimately consumes them first wins:
 *   - Escape in distraction-free mode returns to the regular layout.
 *   - Escape from a non-editor region returns focus to the editor (but text
 *     inputs keep their own clear/blur Escape semantics).
 *   - Ctrl+PageDown / Ctrl+PageUp cycle the focused panel's tab strip; left
 *     alone (no preventDefault) anywhere without one, so the editor keeps any
 *     default behaviour. */
function handleNavKeys(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;

  // Distraction-free mode: a bare Escape returns to the regular layout. The
  // bubble phase plus the `defaultPrevented` guard above means open overlays
  // (command palette, quick open, settings) and the editor's own
  // autocomplete/search keymaps — all of which preventDefault on Escape —
  // keep priority. Genuine text inputs keep their own clear/blur semantics;
  // the CodeMirror editor (contentEditable, the usual focus here) does not, so
  // writing-then-Escape exits as expected. Escape only ever exits, never
  // enters, distraction-free mode.
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

/** Register the contextual navigation handler (Escape-to-editor, Ctrl+PageUp/
 *  Down tab cycling). Call once from App.tsx; F6 / Shift+F6 / Ctrl+Shift+0 are
 *  registry commands and need no listener here. */
export function initFocusRegions(): () => void {
  document.addEventListener("keydown", handleNavKeys);
  return () => document.removeEventListener("keydown", handleNavKeys);
}
