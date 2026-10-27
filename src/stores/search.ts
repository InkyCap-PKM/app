// Search state at module level (not in `SearchPanel.tsx`), so the query,
// results and options survive switching to another sidebar mode and back.

import { createSignal } from "solid-js";
import type { SearchResult, ReplaceResult, AnnotationScope } from "../lib/types";

export type SortMode =
  | "relevance"
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc"
  | "zid-asc"
  | "zid-desc";

// Query and results.
export const [searchQuery, setSearchQuery] = createSignal<string>("");
export const [searchResults, setSearchResults] = createSignal<SearchResult[]>([]);
export const [searchResultCount, setSearchResultCount] = createSignal<number>(0);
export const [searchTotalCount, setSearchTotalCount] = createSignal<number>(0);
export const [searchOffset, setSearchOffset] = createSignal<number>(0);
export const [searchError, setSearchError] = createSignal<string | null>(null);

// Search options.
export const [caseSensitive, setCaseSensitive] = createSignal<boolean>(false);
export const [useRegex, setUseRegex] = createSignal<boolean>(false);
// How search treats text in `#annotation[…]` / `#suggestion[…]` marks:
//   "all"     search body text and annotations alike (default)
//   "only"    only annotation/suggestion lines (an empty query lists every
//             annotation in the notebox)
//   "exclude" leave out annotation/suggestion text
// The SearchPanel's three-way toggle; `AnnotationScope` matches the Rust enum
// and is sent as is.
export const [annotationScope, setAnnotationScope] =
  createSignal<AnnotationScope>("all");

// Whether "Search Options" is open. Module-level so it survives the panel
// remounting on a sidebar switch.
export const [showSettings, setShowSettings] = createSignal<boolean>(false);

// Display options.
export const [collapseResults, setCollapseResults] = createSignal<boolean>(true);
export const [showMoreContext, setShowMoreContext] = createSignal<boolean>(false);
export const [sortMode, setSortMode] = createSignal<SortMode>("relevance");

// Files whose result row the user expanded or collapsed against
// `collapseResults`. Cleared when the query changes.
export const [expandOverrides, setExpandOverrides] = createSignal<Set<string>>(
  new Set(),
);

// Ranges to highlight in the opened note: all of that file's matches, so every
// term is highlighted, not just the clicked line. Keyed by path so only that
// file uses them. Cleared on a new search.
export interface SearchHighlights {
  path: string;
  ranges: { line: number; charStart: number; charEnd: number }[];
}
export const [searchHighlights, setSearchHighlights] =
  createSignal<SearchHighlights | null>(null);

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
  setSearchTotalCount(0);
  setSearchOffset(0);
  setSearchError(null);
  setReplaceResults(null);
  setExpandOverrides(new Set<string>());
  setSearchHighlights(null);
}
