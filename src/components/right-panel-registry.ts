// Right-panel registry — the additive seam for contributing extra right-panel
// tabs at runtime (plugins, the declarative manifest loader's query-views).
//
// This is *additive*: the built-in panes (Properties, Outline, Links,
// References, Annotations, …) stay exactly where they are in RightPanel.tsx.
// Contributed tabs render alongside them. When nothing is registered — the
// default — RightPanel renders byte-for-byte as before, because the
// contribution list is empty.

import { createSignal, type Component } from "solid-js";

/** A right-panel tab contributed at runtime. */
export interface RightPanelContribution {
  /** Unique, namespaced id (e.g. `"myplugin:tasks"`). Also the active-tab key,
   *  stored in the layout `rightPanelTab` signal when this tab is selected. */
  id: string;
  /** Tooltip / aria label for the tab button (already localized by the
   *  contributor — the host does not translate plugin strings). */
  label: string;
  /** Tab-button icon — a component taking a `size` prop, Lucide-shaped. */
  icon: Component<{ size?: number }>;
  /** The pane body, rendered when this tab is active. */
  component: Component;
  /** Optional gate: show the tab only when this returns true (reactive).
   *  Defaults to always shown. */
  when?: () => boolean;
}

const contributions = new Map<string, RightPanelContribution>();
// Bumped on every register/unregister so reactive readers re-run.
const [rev, setRev] = createSignal(0);

/** Register (or replace, by `id`) a right-panel tab. Returns a disposer. */
export function registerRightPanel(contribution: RightPanelContribution): () => void {
  contributions.set(contribution.id, contribution);
  setRev((n) => n + 1);
  return () => {
    if (contributions.get(contribution.id) === contribution) {
      contributions.delete(contribution.id);
      setRev((n) => n + 1);
    }
  };
}

/** All contributed tabs, in registration order. Reactive. */
export function rightPanelContributions(): RightPanelContribution[] {
  rev();
  return [...contributions.values()];
}

/** Look up a contributed tab by id (e.g. to render its pane). Reactive. */
export function rightPanelContribution(id: string): RightPanelContribution | undefined {
  rev();
  return contributions.get(id);
}
