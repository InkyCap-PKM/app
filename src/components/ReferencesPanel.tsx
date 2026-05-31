import { errorText } from "../lib/errors";
import { Component, createResource, createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import CitationRow from "./CitationRow";
import { getActiveTab } from "../stores/tabs";
import { noteboxSettings } from "../stores/settings";
import type { FileCitation, BibEntry } from "../lib/types";
import * as ipc from "../lib/ipc";
import { fuzzyMatch } from "../lib/fuzzy";
import { useI18n, tPlural } from "../lib/i18n";
import { anchorPanelMenu } from "../lib/uiMenu";
import { clickOutside } from "../lib/clickOutside";
import { RefreshCw } from "lucide-solid";

const PAGE_SIZE = 50;

type SortKey = "title-asc" | "title-desc" | "author-asc" | "author-desc"
  | "year-asc" | "year-desc" | "added-asc" | "added-desc";

const VALID_SORT_KEYS: SortKey[] = [
  "title-asc", "title-desc", "author-asc", "author-desc",
  "year-asc", "year-desc", "added-asc", "added-desc",
];

const SORT_PREF_KEY = "inkycap:references-panel:sort";

/// Sort options for the Browse References menu, in display order. Rendered
/// as an app-drawn `.context-menu` (see `anchorPanelMenu`) to match the
/// left sidebar's File/Tag/Property sort menus — a native <select> popup
/// is OS-themed and can't follow the InkyCap theme on WebKitGTK.
const SORT_OPTIONS: { value: SortKey; labelKey: string }[] = [
  { value: "added-desc", labelKey: "references.sort.addedNewest" },
  { value: "added-asc", labelKey: "references.sort.addedOldest" },
  { value: "title-asc", labelKey: "references.sort.titleAZ" },
  { value: "title-desc", labelKey: "references.sort.titleZA" },
  { value: "author-asc", labelKey: "references.sort.authorAZ" },
  { value: "author-desc", labelKey: "references.sort.authorZA" },
  { value: "year-desc", labelKey: "references.sort.yearNewest" },
  { value: "year-asc", labelKey: "references.sort.yearOldest" },
];

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
  const t = useI18n();
  const [showAll, setShowAll] = createSignal(false);
  const [browseQuery, setBrowseQuery] = createSignal("");
  const [refreshing, setRefreshing] = createSignal(false);
  const [visibleCount, setVisibleCount] = createSignal(PAGE_SIZE);
  const [sortKey, setSortKey] = createSignal<SortKey>(loadSortPreference());
  const [showSortMenu, setShowSortMenu] = createSignal(false);
  let sortBtnRef: HTMLButtonElement | undefined;

  const sortLabel = createMemo(() => {
    const key = sortKey();
    const opt = SORT_OPTIONS.find((o) => o.value === key);
    return opt ? t(opt.labelKey) : "";
  });

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

  const [citations, { refetch: refetchCitations }] = createResource(
    () => {
      const path = activeFileTab()?.path;
      const _source = noteboxSettings.citations.source;
      return path;
    },
    async (path) => {
      if (!path) return [];
      setCitationError(null);
      try {
        return await ipc.getFileCitations(path);
      } catch (err) {
        console.error("Failed to load file citations:", err);
        setCitationError(errorText(err));
        return [];
      }
    },
  );

  const [allEntries] = createResource(
    () => {
      const _source = noteboxSettings.citations.source;
      const _bibPath = noteboxSettings.citations.bibliography_path;
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
        setBrowseError(errorText(err));
        return [];
      }
    },
  );

  onMount(() => {
    const onInsertCitation = () => {
      setTimeout(() => refetchCitations(), 1500);
    };
    document.addEventListener("inkycap:insert-citation", onInsertCitation);
    onCleanup(() => document.removeEventListener("inkycap:insert-citation", onInsertCitation));

    const onNoteSaved = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path === activeFileTab()?.path) {
        refetchCitations();
      }
    };
    document.addEventListener("inkycap:note-saved", onNoteSaved);
    onCleanup(() => document.removeEventListener("inkycap:note-saved", onNoteSaved));
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

  function insertCitation(key: string) {
    document.dispatchEvent(
      new CustomEvent("inkycap:insert-citation", { detail: { key } }),
    );
  }

  const isZoteroSource = () => noteboxSettings.citations.source === "zotero";

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await ipc.refreshBibliography();
      refetchCitations();
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
            {showAll() ? t("references.hideRefs") : t("references.browseRefs")}
          </button>
          <button
            class="references-panel__refresh"
            onClick={handleRefresh}
            disabled={refreshing()}
            title={t("references.refresh")}
          >
            <RefreshCw
              size={14}
              class={`refresh-icon${refreshing() ? " refresh-icon--spinning" : ""}`}
            />
          </button>
        </div>
        <Show when={showAll()}>
          <Show when={browseError()}>
            <p class="sidebar-hint sidebar-hint--error">
              {t("references.loadFailed", { error: browseError()! })}
            </p>
          </Show>
          <Show when={allEntries.loading}>
            <p class="sidebar-hint">{t("refNotes.loading")}</p>
          </Show>
          <Show when={!browseError() && !allEntries.loading}>
            <Show
              when={(allEntries() ?? []).length > 0}
              fallback={
                <p class="sidebar-hint">
                  {t("refNotes.noBibliography")}
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
                  {totalCount()} {tPlural("references.entry", totalCount())}
                  <span class="references-panel__source-badge">
                    {isZoteroSource() ? t("references.source.zotero") : t("references.source.file")}
                  </span>
                  <Show when={skippedCount() > 0}>
                    <span
                      class="references-panel__skip-warning"
                      title={t("references.skippedTitle", { count: skippedCount() })}
                    >
                      {t("references.skippedCount", { count: skippedCount() })}
                    </span>
                  </Show>
                </span>
                <div class="references-panel__sort-wrap">
                  <button
                    ref={sortBtnRef}
                    class="references-panel__sort"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowSortMenu((v) => !v);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={showSortMenu()}
                    title={t("references.sort.label")}
                  >
                    <span class="references-panel__sort-label">{sortLabel()}</span>
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
                      <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <Show when={showSortMenu()}>
                    <div
                      class="context-menu"
                      ref={(el) => anchorPanelMenu(sortBtnRef, el)}
                      use:clickOutside={{
                        onDismiss: () => setShowSortMenu(false),
                        ignore: sortBtnRef,
                      }}
                    >
                      <For each={SORT_OPTIONS}>
                        {(opt) => (
                          <button
                            classList={{
                              "context-menu__item": true,
                              "context-menu__item--active": sortKey() === opt.value,
                            }}
                            onClick={() => {
                              persistSortKey(opt.value);
                              setVisibleCount(PAGE_SIZE);
                              setShowSortMenu(false);
                            }}
                          >
                            {t(opt.labelKey)}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
              <For each={filteredEntries()}>
                {(entry) => (
                  <CitationRow
                    cite={{
                      key: entry.key,
                      title: entry.title,
                      authors: entry.authors,
                      year: entry.year,
                      zoteroItemKey: entry.zotero_item_key,
                    }}
                    onActivate={() => insertCitation(entry.key)}
                    title={t("references.insertCite", { key: entry.key })}
                  />
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
          {t("references.citations")}
          <Show when={citations()?.length}>
            <span class="right-panel__count"> ({citations()!.length})</span>
          </Show>
        </div>
        <Show when={citationError()}>
          <p class="sidebar-hint sidebar-hint--error">{t("references.citationsLoadFailed", { error: citationError()! })}</p>
        </Show>
        <Show when={!citationError()}>
          <Show
            when={citations()?.length}
            fallback={<p class="sidebar-hint">{t("references.noCitations")}</p>}
          >
            <For each={citations()}>
              {(cite) => (
                <CitationRow
                  cite={{
                    key: cite.key,
                    title: cite.title,
                    authors: cite.authors,
                    year: cite.year,
                    zoteroItemKey: cite.zotero_item_key,
                  }}
                />
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default ReferencesPanel;
