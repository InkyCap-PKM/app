// Persisted UI state for the Mycelial View's Growth pane.
//
// Whether the "Under-developed pages" and "Open questions" sections are
// expanded or collapsed survives across sessions and across note switches —
// it's a preference for *how* the pane is displayed, not data about any one
// note. Mirrors the Links tab's `linksPanel` store (localStorage-backed,
// module-level singleton so every pane shares the same choice) rather than a
// Tauri settings round-trip, since it's purely a webview display preference.

import { createSignal } from "solid-js";

const STORAGE_KEY = "inkycap.mycelialGrowthPanel";

export type MycelialGrowthSection = "hubs" | "questions";

interface MycelialGrowthPanelState {
  expanded: Record<MycelialGrowthSection, boolean>;
}

const DEFAULTS: MycelialGrowthPanelState = {
  expanded: { hubs: true, questions: true },
};

function load(): MycelialGrowthPanelState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(DEFAULTS);
    const parsed = JSON.parse(raw) ?? {};
    return {
      expanded: {
        hubs: parsed.expanded?.hubs ?? DEFAULTS.expanded.hubs,
        questions: parsed.expanded?.questions ?? DEFAULTS.expanded.questions,
      },
    };
  } catch {
    return clone(DEFAULTS);
  }
}

function clone(s: MycelialGrowthPanelState): MycelialGrowthPanelState {
  return { expanded: { ...s.expanded } };
}

const initial = load();

const [expanded, setExpandedInternal] = createSignal<Record<MycelialGrowthSection, boolean>>(
  initial.expanded,
);

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ expanded: expanded() }));
  } catch {
    /* no-op: localStorage may be unavailable in some webview contexts */
  }
}

export function setMycelialGrowthExpanded(section: MycelialGrowthSection, v: boolean) {
  setExpandedInternal((prev) => ({ ...prev, [section]: v }));
  persist();
}

export { expanded as mycelialGrowthExpanded };
