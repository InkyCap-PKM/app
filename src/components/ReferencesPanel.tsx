import { Component, createResource, createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getActiveTab } from "../stores/tabs";
import { settings } from "../stores/settings";
import type { FileCitation, BibEntry } from "../lib/types";
import * as ipc from "../lib/ipc";
import { fuzzyMatch } from "../lib/fuzzy";
import { t } from "../lib/i18n";

const PAGE_SIZE = 50;

type SortKey = "title-asc" | "title-desc" | "author-asc" | "author-desc"
  | "year-asc" | "year-desc" | "added-asc" | "added-desc";

const VALID_SORT_KEYS: SortKey[] = [
  "title-asc", "title-desc", "author-asc", "author-desc",
  "year-asc", "year-desc", "added-asc", "added-desc",
];

const SORT_PREF_KEY = "inkycap:references-panel:sort";

function nullsLast(
  a: string | null | undefined,
  b: string | null | undefined,
  asc: boolean,
): number {
  const aEmpty = !a;
  const bEmpty = !b;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return asc ? a!.localeCompare(b!) : b!.localeCompare(a!);
}

function sortEntries(entries: BibEntry[], key: SortKey): BibEntry[] {
  const sorted = [...entries];
  switch (key) {
    case "title-asc":
      return sorted.sort((a, b) => nullsLast(a.title, b.title, true));
    case "title-desc":
      return sorted.sort((a, b) => nullsLast(a.title, b.title, false));
    case "author-asc":
      return sorted.sort((a, b) => nullsLast(a.authors[0], b.authors[0], true));
    case "author-desc":
      return sorted.sort((a, b) => nullsLast(a.authors[0], b.authors[0], false));
    case "year-asc":
      return sorted.sort((a, b) => nullsLast(a.year, b.year, true));
    case "year-desc":
      return sorted.sort((a, b) => nullsLast(a.year, b.year, false));
    case "added-asc":
      return sorted;
    case "added-desc":
      return sorted.reverse();
    default:
      return sorted;
  }
}

const ReferencesPanel: Component = () => {
  const [showAll, setShowAll] = createSignal(false);
  const [browseQuery, setBrowseQuery] = createSignal("");
  const [citationVersion, setCitationVersion] = createSignal(0);
  const [refreshing, setRefreshing] = createSignal(false);
  const [visibleCount, setVisibleCount] = createSignal(PAGE_SIZE);
  const [sortKey, setSortKey] = createSignal<SortKey>(loadSortPreference());

  function loadSortPreference(): SortKey {
    try {
      const stored = localStorage.getItem(SORT_PREF_KEY);
      if (stored && VALID_SORT_KEYS.includes(stored as SortKey)) {
        return stored as SortKey;
      }
    } catch {
      // localStorage may be unavailable in some webview contexts
    }
    return "added-desc";
  }

  function persistSortKey(key: SortKey) {
    setSortKey(key);
    try {
      localStorage.setItem(SORT_PREF_KEY, key);
    } catch {
      // ignore
    }
  }
  const [browseError, setBrowseError] = createSignal<string | null>(null);
  const [citationError, setCitationError] = createSignal<string | null>(null);
  const [skippedCount, setSkippedCount] = createSignal(0);
  let scrollSentinelRef: HTMLDivElement | undefined;

  const activeFileTab = () => {
    const tab = getActiveTab();
    return tab?.type === "file" ? tab : undefined;
  };

  const [citations] = createResource(
    () => {
      const path = activeFileTab()?.path;
      const _v = citationVersion();
      const _source = settings.citations.source;
      return path;
    },
    async (path) => {
      if (!path) return [];
      setCitationError(null);
      try {
        return await ipc.getFileCitations(path);
      } catch (err) {
        console.error("Failed to load file citations:", err);
        setCitationError(String(err));
        return [];
      }
    },
  );

  const [allEntries] = createResource(
    () => {
      const _source = settings.citations.source;
      const _bibPath = settings.citations.bibliography_path;
      return showAll();
    },
    async (all) => {
      if (!all) return [];
      setBrowseError(null);
      try {
        const entries = await ipc.getBibliographyEntries();
        try {
          setSkippedCount(await ipc.getBibliographySkipCount());
        } catch {
          setSkippedCount(0);
        }
        return entries;
      } catch (err) {
        console.error("Failed to load bibliography:", err);
        setBrowseError(String(err));
        return [];
      }
    },
  );

  onMount(() => {
    const handler = () => {
      setTimeout(() => {
        setCitationVersion((v) => v + 1);
      }, 1500);
    };
    document.addEventListener("inkycap:insert-citation", handler);
    onCleanup(() => document.removeEventListener("inkycap:insert-citation", handler));
  });

  const sortedAndFiltered = createMemo(() => {
    const all = allEntries() ?? [];
    const q = browseQuery().trim();
    if (q.length === 0) return sortEntries(all, sortKey());

    const phraseMatch = q.match(/^"(.+)"$/);
    if (phraseMatch) {
      const phrase = phraseMatch[1].toLowerCase();
      const matched = all.filter((entry) => {
        const text = `${entry.key} ${entry.title} ${entry.authors.join(" ")} ${entry.year ?? ""}`.toLowerCase();
        return text.includes(phrase);
      });
      return sortEntries(matched, sortKey());
    }

    const scored: { entry: BibEntry; score: number }[] = [];
    const ql = q.toLowerCase();
    for (const entry of all) {
      const text = `${entry.key} ${entry.title} ${entry.authors.join(" ")} ${entry.year ?? ""}`;
      const m = fuzzyMatch(ql, text);
      if (m) scored.push({ entry, score: m.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.entry);
  });

  const filteredEntries = createMemo(() => {
    return sortedAndFiltered().slice(0, visibleCount());
  });

  const hasMore = createMemo(() => visibleCount() < sortedAndFiltered().length);

  const totalCount = createMemo(() => sortedAndFiltered().length);

  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore()) {
          setVisibleCount((n) => n + PAGE_SIZE);
        }
      },
      { rootMargin: "100px" },
    );

    const checkSentinel = () => {
      if (scrollSentinelRef) observer.observe(scrollSentinelRef);
    };

    const mutObs = new MutationObserver(checkSentinel);
    mutObs.observe(document.body, { childList: true, subtree: true });
    checkSentinel();

    onCleanup(() => {
      observer.disconnect();
      mutObs.disconnect();
    });
  });

  function formatAuthors(authors: string[]): string {
    if (authors.length === 0) return "";
    if (authors.length <= 2) return authors.join(" & ");
    return `${authors[0]} et al.`;
  }

  function insertCitation(key: string) {
    document.dispatchEvent(
      new CustomEvent("inkycap:insert-citation", { detail: { key } }),
    );
  }

  function openInZotero(e: MouseEvent, itemKey: string) {
    e.preventDefault();
    e.stopPropagation();
    shellOpen(`zotero://select/library/items/${itemKey}`);
  }

  const isZoteroSource = () => settings.citations.source === "zotero";

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await ipc.refreshBibliography();
      setCitationVersion((v) => v + 1);
      if (showAll()) {
        setShowAll(false);
        queueMicrotask(() => setShowAll(true));
      }
    } catch (err) {
      console.error("Failed to refresh bibliography:", err);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div class="references-panel">
      {/* Browse all references */}
      <div class="right-panel__section">
        <div class="references-panel__header-row">
          <button
            class="references-panel__toggle"
            onClick={() => {
              setShowAll(!showAll());
              setBrowseQuery("");
              setVisibleCount(PAGE_SIZE);
            }}
          >
            {showAll() ? "Hide" : "Browse"} references
          </button>
          <button
            class="references-panel__refresh"
            onClick={handleRefresh}
            disabled={refreshing()}
            title="Refresh bibliography"
          >
            <RefreshIcon spinning={refreshing()} />
          </button>
        </div>
        <Show when={showAll()}>
          <Show when={browseError()}>
            <p class="sidebar-hint sidebar-hint--error">
              Failed to load bibliography: {browseError()}
            </p>
          </Show>
          <Show when={allEntries.loading}>
            <p class="sidebar-hint">Loading bibliography…</p>
          </Show>
          <Show when={!browseError() && !allEntries.loading}>
            <Show
              when={(allEntries() ?? []).length > 0}
              fallback={
                <p class="sidebar-hint">
                  No bibliography configured. Check Settings &rsaquo; Citations.
                </p>
              }
            >
              <div class="references-panel__search-wrap">
                <input
                  class="references-panel__search"
                  type="text"
                  placeholder={t("references.filterPlaceholder")}
                  value={browseQuery()}
                  onInput={(e) => {
                    setBrowseQuery(e.currentTarget.value);
                    setVisibleCount(PAGE_SIZE);
                  }}
                />
                <Show when={browseQuery().length > 0}>
                  <button
                    class="references-panel__search-clear"
                    onClick={() => {
                      setBrowseQuery("");
                      setVisibleCount(PAGE_SIZE);
                    }}
                    title={t("references.clearFilter")}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                      <line x1="2" y1="2" x2="8" y2="8" />
                      <line x1="8" y1="2" x2="2" y2="8" />
                    </svg>
                  </button>
                </Show>
              </div>
              <div class="references-panel__toolbar">
                <span class="references-panel__count">
                  {totalCount()} {totalCount() === 1 ? t("references.entry") : t("references.entries")}
                  <span class="references-panel__source-badge">
                    {isZoteroSource() ? "Zotero" : "File"}
                  </span>
                  <Show when={skippedCount() > 0}>
                    <span
                      class="references-panel__skip-warning"
                      title={`${skippedCount()} entries skipped because of BibTeX type errors. Check settings or the source file.`}
                    >
                      ({skippedCount()} skipped)
                    </span>
                  </Show>
                </span>
                <select
                  class="references-panel__sort"
                  value={sortKey()}
                  onChange={(e) => {
                    persistSortKey(e.currentTarget.value as SortKey);
                    setVisibleCount(PAGE_SIZE);
                  }}
                >
                  <option value="added-desc">{t("references.sort.addedNewest")}</option>
                  <option value="added-asc">{t("references.sort.addedOldest")}</option>
                  <option value="title-asc">{t("references.sort.titleAZ")}</option>
                  <option value="title-desc">{t("references.sort.titleZA")}</option>
                  <option value="author-asc">{t("references.sort.authorAZ")}</option>
                  <option value="author-desc">{t("references.sort.authorZA")}</option>
                  <option value="year-desc">{t("references.sort.yearNewest")}</option>
                  <option value="year-asc">{t("references.sort.yearOldest")}</option>
                </select>
              </div>
              <For each={filteredEntries()}>
                {(entry) => (
                  <div
                    class="references-panel__entry references-panel__entry--clickable"
                    onClick={() => insertCitation(entry.key)}
                    title={`Insert @${entry.key}`}
                  >
                    <div class="references-panel__key-row">
                      <Show when={isZoteroSource() && entry.zotero_item_key}>
                        <button
                          class="references-panel__zotero-link"
                          onClick={(e) => openInZotero(e, entry.zotero_item_key!)}
                          title={t("references.openInZotero")}
                        >
                          <ZoteroIcon />
                        </button>
                      </Show>
                      <span class="references-panel__key">@{entry.key}</span>
                    </div>
                    <Show when={entry.title}>
                      <div class="references-panel__title">{entry.title}</div>
                    </Show>
                    <Show when={entry.authors.length > 0}>
                      <div class="references-panel__meta">
                        {formatAuthors(entry.authors)}
                        <Show when={entry.year}>
                          {" "}({entry.year})
                        </Show>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={hasMore()}>
                <div
                  ref={scrollSentinelRef}
                  class="references-panel__sentinel"
                />
                <button
                  class="references-panel__show-more"
                  onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                >
                  {t("references.showMore")} ({totalCount() - visibleCount()} {t("references.remaining")})
                </button>
              </Show>
              <Show when={browseQuery().trim() && filteredEntries().length === 0}>
                <p class="sidebar-hint">{t("references.noMatching")}</p>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>

      {/* Citations in current file */}
      <div class="right-panel__section">
        <div class="right-panel__heading">
          Citations
          <Show when={citations()?.length}>
            <span class="right-panel__count"> ({citations()!.length})</span>
          </Show>
        </div>
        <Show when={citationError()}>
          <p class="sidebar-hint sidebar-hint--error">Failed to load citations: {citationError()}</p>
        </Show>
        <Show when={!citationError()}>
          <Show
            when={citations()?.length}
            fallback={<p class="sidebar-hint">No citations in this file</p>}
          >
            <For each={citations()}>
              {(cite) => (
                <div class="references-panel__entry">
                  <div class="references-panel__key-row">
                    <Show when={isZoteroSource() && cite.zotero_item_key}>
                      <button
                        class="references-panel__zotero-link"
                        onClick={(e) => openInZotero(e, cite.zotero_item_key!)}
                        title={t("references.openInZotero")}
                      >
                        <ZoteroIcon />
                      </button>
                    </Show>
                    <span class="references-panel__key">@{cite.key}</span>
                  </div>
                  <Show when={cite.title}>
                    <div class="references-panel__title">{cite.title}</div>
                  </Show>
                  <Show when={cite.authors.length > 0}>
                    <div class="references-panel__meta">
                      {formatAuthors(cite.authors)}
                      <Show when={cite.year}>
                        {" "}({cite.year})
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
};

function RefreshIcon(props: { spinning?: boolean }) {
  return (
    <svg
      class={`refresh-icon${props.spinning ? " refresh-icon--spinning" : ""}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function ZoteroIcon() {
  return (
    <svg
      class="zotero-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <path d="M21 3H3v3.6h11.4L3 18.4V21h18v-3.6H9.6L21 5.6z" />
    </svg>
  );
}

export default ReferencesPanel;
