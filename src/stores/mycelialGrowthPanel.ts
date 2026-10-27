// Saved display state for the Mycelial View's Growth pane: whether
// "Under-developed pages" and "Open questions" are expanded, kept across
// sessions and notes. In localStorage like the Links tab's `linksPanel` store,
// since it's only a display preference.

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
