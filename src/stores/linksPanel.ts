// Saved display state for the right panel's Links tab: open sections (Inbound /
// Outbound / Potential), sort, "more context" and filter visibility, kept
// across sessions and notes. The filter text is kept too, so switching tabs and
// back doesn't lose it; it clears only when the user clears it.

import { createSignal } from "solid-js";

const STORAGE_KEY = "inkycap.linksPanel";

/// The same sort options as the file tree (Name / Modified / Created, both
/// directions), since the Links pane is also a list of files.
export type LinksSortMode =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc"
  | "zid-asc"
  | "zid-desc";

// `labelKey` rather than text, so the label is translated where shown and
// shares the `sort.*` keys in en.json with the file tree menu.
export const LINKS_SORT_OPTIONS: { value: LinksSortMode; labelKey: string }[] = [
  { value: "name-asc", labelKey: "sort.name.asc" },
  { value: "name-desc", labelKey: "sort.name.desc" },
  { value: "modified-desc", labelKey: "sort.modified.desc" },
  { value: "modified-asc", labelKey: "sort.modified.asc" },
  { value: "created-desc", labelKey: "sort.created.desc" },
  { value: "created-asc", labelKey: "sort.created.asc" },
  { value: "zid-asc", labelKey: "sort.zid.asc" },
  { value: "zid-desc", labelKey: "sort.zid.desc" },
];

export type LinksSection = "inbound" | "outbound" | "potential";

interface LinksPanelState {
  sortMode: LinksSortMode;
  /// Whether each link's context preview is collapsed by default, like the
  /// Search panel's `collapseResults`. Per-item overrides (`expandOverrides`)
  /// aren't saved.
  collapsePreviews: boolean;
  /// Widen previews: an inbound passage gains the paragraph before and after
  /// it, and search and potential-link lines gain the lines around them.
  showMoreContext: boolean;
  showFilter: boolean;
  filterQuery: string;
  expanded: Record<LinksSection, boolean>;
}

const DEFAULTS: LinksPanelState = {
  sortMode: "name-asc",
  collapsePreviews: true,
  showMoreContext: false,
  showFilter: false,
  filterQuery: "",
  expanded: { inbound: true, outbound: true, potential: true },
};

function load(): LinksPanelState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(DEFAULTS);
    const parsed = JSON.parse(raw) ?? {};
    return {
      sortMode: parsed.sortMode ?? DEFAULTS.sortMode,
      // Saved under `hidePreviews`. An older `collapsePreviews` value is
      // ignored on purpose, so the default (hidden) applies.
      collapsePreviews: parsed.hidePreviews ?? DEFAULTS.collapsePreviews,
      showMoreContext: !!parsed.showMoreContext,
      showFilter: !!parsed.showFilter,
      filterQuery: typeof parsed.filterQuery === "string" ? parsed.filterQuery : "",
      expanded: {
        inbound: parsed.expanded?.inbound ?? DEFAULTS.expanded.inbound,
        outbound: parsed.expanded?.outbound ?? DEFAULTS.expanded.outbound,
        potential: parsed.expanded?.potential ?? DEFAULTS.expanded.potential,
      },
    };
  } catch {
    return clone(DEFAULTS);
  }
}

function clone(s: LinksPanelState): LinksPanelState {
  return { ...s, expanded: { ...s.expanded } };
}

const initial = load();

const [sortMode, setSortModeInternal] = createSignal<LinksSortMode>(initial.sortMode);
const [collapsePreviews, setCollapsePreviewsInternal] = createSignal(initial.collapsePreviews);
const [showMoreContext, setShowMoreContextInternal] = createSignal(initial.showMoreContext);
const [showFilter, setShowFilterInternal] = createSignal(initial.showFilter);
const [filterQuery, setFilterQueryInternal] = createSignal(initial.filterQuery);
const [expanded, setExpandedInternal] = createSignal<Record<LinksSection, boolean>>(
  initial.expanded,
);

/// Per-item overrides of `collapsePreviews`, keyed `${section}::${path}` so a
/// path in two sections can differ. Not saved, as in SearchPanel.
const [expandOverrides, setExpandOverridesInternal] = createSignal<Set<string>>(
  new Set<string>(),
);

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortMode: sortMode(),
        hidePreviews: collapsePreviews(),
        showMoreContext: showMoreContext(),
        showFilter: showFilter(),
        filterQuery: filterQuery(),
        expanded: expanded(),
      }),
    );
  } catch {
    /* no-op: localStorage may be unavailable in some webview contexts */
  }
}

export function setLinksSortMode(mode: LinksSortMode) {
  setSortModeInternal(mode);
  persist();
}

export function setLinksCollapsePreviews(v: boolean) {
  setCollapsePreviewsInternal(v);
  // Changing the default clears the overrides (as SearchPanel does); otherwise
  // inverted items would flip to the opposite of what the user set.
  setExpandOverridesInternal(new Set<string>());
  persist();
}

export function toggleLinksPreviewOverride(key: string) {
  setExpandOverridesInternal((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}

export function setLinksShowMoreContext(v: boolean) {
  setShowMoreContextInternal(v);
  persist();
}

export function setLinksShowFilter(v: boolean) {
  setShowFilterInternal(v);
  persist();
}

export function setLinksFilterQuery(q: string) {
  setFilterQueryInternal(q);
  persist();
}

export function setLinksSectionExpanded(section: LinksSection, v: boolean) {
  setExpandedInternal((prev) => ({ ...prev, [section]: v }));
  persist();
}

export {
  sortMode as linksSortMode,
  collapsePreviews as linksCollapsePreviews,
  showMoreContext as linksShowMoreContext,
  showFilter as linksShowFilter,
  filterQuery as linksFilterQuery,
  expanded as linksSectionExpanded,
  expandOverrides as linksExpandOverrides,
};
