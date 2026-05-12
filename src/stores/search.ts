// Module-level search state. Hoisted out of `SearchPanel.tsx` so the
// query, results, and view options survive while the user clicks over
// to the file tree, bookmarks, or any other sidebar mode and comes back.
//
// Solid signals at module scope are shared across all consumers, so this
// works exactly like a typical Solid store without the ceremony.

import { createSignal } from "solid-js";
import type { SearchResult, ReplaceResult } from "../lib/types";

export type SortMode =
  | "relevance"
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc";

// Query and results.
export const [searchQuery, setSearchQuery] = createSignal<string>("");
export const [searchResults, setSearchResults] = createSignal<SearchResult[]>([]);
export const [searchResultCount, setSearchResultCount] = createSignal<number>(0);
export const [searchError, setSearchError] = createSignal<string | null>(null);

// Search options.
export const [caseSensitive, setCaseSensitive] = createSignal<boolean>(false);
export const [useRegex, setUseRegex] = createSignal<boolean>(false);

// Display options.
export const [collapseResults, setCollapseResults] = createSignal<boolean>(true);
export const [showMoreContext, setShowMoreContext] = createSignal<boolean>(false);
export const [sortMode, setSortMode] = createSignal<SortMode>("relevance");

// Per-file expand override. A path appears here when the user has
// explicitly inverted the global `collapseResults` setting for that
// file via its row's chevron. Cleared when the query changes so a new
// search starts with a clean slate.
export const [expandOverrides, setExpandOverrides] = createSignal<Set<string>>(
  new Set(),
);

// Replace state.
export const [showReplace, setShowReplace] = createSignal<boolean>(false);
export const [replacement, setReplacement] = createSignal<string>("");
export const [replaceResults, setReplaceResults] = createSignal<
  ReplaceResult[] | null
>(null);

/// Reset only the volatile state (results, errors, overrides). Called
/// when the user clears the search box so the next query starts fresh.
export function resetSearchVolatileState() {
  setSearchResults([]);
  setSearchResultCount(0);
  setSearchError(null);
  setReplaceResults(null);
  setExpandOverrides(new Set<string>());
}
