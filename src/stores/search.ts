// Module-level search state. Hoisted out of `SearchPanel.tsx` so the
// query, results, and view options survive while the user clicks over
// to the file tree, bookmarks, or any other sidebar mode and comes back.
//
// Solid signals at module scope are shared across all consumers, so this
// works exactly like a typical Solid store without the ceremony.

import { createSignal } from "solid-js";
import type { SearchResult, ReplaceResult, AnnotationScope } from "../lib/types";

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
export const [searchTotalCount, setSearchTotalCount] = createSignal<number>(0);
export const [searchOffset, setSearchOffset] = createSignal<number>(0);
export const [searchError, setSearchError] = createSignal<string | null>(null);

// Search options.
export const [caseSensitive, setCaseSensitive] = createSignal<boolean>(false);
export const [useRegex, setUseRegex] = createSignal<boolean>(false);
// How search treats text inside `#annotation[…]` / `#suggestion[…]` marks:
//   "all"     — search body prose and annotation text alike (default)
//   "only"    — restrict matches to annotation/suggestion lines (an empty
//               query browses every annotation in the notebox)
//   "exclude" — hide annotation/suggestion text, search only body prose
// Drives the SearchPanel's tri-state annotation toggle; the `AnnotationScope`
// type mirrors the Rust enum and is sent verbatim across IPC.
export const [annotationScope, setAnnotationScope] =
  createSignal<AnnotationScope>("all");

// Whether the "Search Options" expander is open. Module-level (not
// component-local) so it survives the panel unmounting/remounting when the
// user switches sidebar tabs — otherwise a toggle they enabled inside it
// (e.g. Annotations, Regex) silently loses its visibility on return.
export const [showSettings, setShowSettings] = createSignal<boolean>(false);

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

// Match ranges to highlight inside the opened note. Set when a result is
// opened — with *all* of that file's matches, so a multi-term query highlights
// every matching portion in the file, not just the clicked line. Keyed by path
// so the editor only applies it to the matching file. Cleared on a fresh search.
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
