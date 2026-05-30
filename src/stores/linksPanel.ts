// Persisted UI state for the right-panel Links tab.
//
// Section expansion (Inbound / Outbound / Potential), sort mode, "more
// context" toggle, and filter visibility survive across sessions and across
// note switches — these are user preferences for *how* the Links tab is
// displayed, not data about any one note. The transient filter text is
// kept here too so the user can step over to another tab and come back
// without retyping; it resets only when the user clears the field.

import { createSignal } from "solid-js";

const STORAGE_KEY = "inkycap.linksPanel";

/// Mirrors the file-tree's sort options exactly. The Links pane is a list
/// of files, so it uses the same vocabulary the user already learned from
/// the left sidebar — Name / Modified / Created in both directions.
export type LinksSortMode =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc";

// `labelKey` (not a resolved string) so the label is translated at the render
// site and these modes share one vocabulary with the file-tree sort menu —
// see the `sort.*` keys in en.json.
export const LINKS_SORT_OPTIONS: { value: LinksSortMode; labelKey: string }[] = [
  { value: "name-asc", labelKey: "sort.name.asc" },
  { value: "name-desc", labelKey: "sort.name.desc" },
  { value: "modified-desc", labelKey: "sort.modified.desc" },
  { value: "modified-asc", labelKey: "sort.modified.asc" },
  { value: "created-desc", labelKey: "sort.created.desc" },
  { value: "created-asc", labelKey: "sort.created.asc" },
];

export type LinksSection = "inbound" | "outbound" | "potential";

interface LinksPanelState {
  sortMode: LinksSortMode;
  /// Default visibility of each link row's context preview, mirroring
  /// the Search panel's `collapseResults`. Per-item overrides
  /// (`expandOverrides`) live in-memory only — they're scoped to a
  /// single session because they describe what the user is currently
  /// looking at, not how they like the pane configured.
  collapsePreviews: boolean;
  showMoreContext: boolean;
  showFilter: boolean;
  filterQuery: string;
  expanded: Record<LinksSection, boolean>;
}

const DEFAULTS: LinksPanelState = {
  sortMode: "name-asc",
  collapsePreviews: false,
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
      collapsePreviews: !!parsed.collapsePreviews,
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

/// Per-item overrides on top of the global `collapsePreviews` setting.
/// Keys are `${section}::${path}` so the same path appearing in multiple
/// sections (rare but possible) can be flipped independently. This set
/// is intentionally *not* persisted — like SearchPanel's `expandOverrides`,
/// it's a short-lived "I want to peek at this one" state that resets
/// between sessions.
const [expandOverrides, setExpandOverridesInternal] = createSignal<Set<string>>(
  new Set<string>(),
);

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortMode: sortMode(),
        collapsePreviews: collapsePreviews(),
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
  // Flipping the global default invalidates any per-item overrides — same
  // logic the SearchPanel uses for `expandOverrides`. Without this, items
  // the user explicitly inverted would suddenly behave opposite to what
  // they expected.
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
