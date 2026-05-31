// Left-sidebar registry — the additive seam for contributing extra sidebar
// modes (a toolbar button + its pane) at runtime: plugins, and the declarative
// manifest loader's saved query-views.
//
// Additive, like the right-panel and palette registries: built-in modes
// (filetree, search, tags, collections, …) are untouched. When nothing is
// registered, the toolbar and sidebar render exactly as before.

import { createSignal, type Component } from "solid-js";

/** A sidebar mode contributed at runtime. */
export interface SidebarContribution {
  /** Unique, namespaced id (e.g. `"myplugin:inbox"`). Also the mode key set on
   *  the sidebar `mode` signal when this mode is selected. */
  id: string;
  /** Tooltip / aria label for the toolbar button (already localized by the
   *  contributor). */
  label: string;
  /** Toolbar-button icon — a component taking a `size` prop, Lucide-shaped. */
  icon: Component<{ size?: number }>;
  /** The sidebar pane body, rendered when this mode is active. */
  component: Component;
}

const contributions = new Map<string, SidebarContribution>();
const [rev, setRev] = createSignal(0);

/** Register (or replace, by `id`) a sidebar mode. Returns a disposer. */
export function registerSidebar(contribution: SidebarContribution): () => void {
  contributions.set(contribution.id, contribution);
  setRev((n) => n + 1);
  return () => {
    if (contributions.get(contribution.id) === contribution) {
      contributions.delete(contribution.id);
      setRev((n) => n + 1);
    }
  };
}

/** All contributed sidebar modes, in registration order. Reactive. */
export function sidebarContributions(): SidebarContribution[] {
  rev();
  return [...contributions.values()];
}

/** Look up a contributed sidebar mode by id. Reactive. */
export function sidebarContribution(id: string): SidebarContribution | undefined {
  rev();
  return contributions.get(id);
}
