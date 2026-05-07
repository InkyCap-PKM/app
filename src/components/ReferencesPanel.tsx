import { Component, createResource, createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getActiveTab } from "../stores/tabs";
import { settings } from "../stores/settings";
import type { FileCitation, BibEntry } from "../lib/types";
import * as ipc from "../lib/ipc";
import { fuzzyMatch } from "../lib/fuzzy";

const MAX_BROWSE_RESULTS = 100;

const ReferencesPanel: Component = () => {
  const [showAll, setShowAll] = createSignal(false);
  const [browseQuery, setBrowseQuery] = createSignal("");
  const [citationVersion, setCitationVersion] = createSignal(0);
  const [refreshing, setRefreshing] = createSignal(false);

  const activeFileTab = () => {
    const tab = getActiveTab();
    return tab?.type === "file" ? tab : undefined;
  };

  const [citations] = createResource(
    () => {
      const path = activeFileTab()?.path;
      const _v = citationVersion();
      return path;
    },
    async (path) => {
      if (!path) return [];
      try {
        return await ipc.getFileCitations(path);
      } catch (err) {
        console.error("Failed to load file citations:", err);
        throw err;
      }
    },
  );

  const [allEntries] = createResource(
    () => showAll(),
    async (all) => {
      if (!all) return [];
      try {
        return await ipc.getBibliographyEntries();
      } catch (err) {
        console.error("Failed to load bibliography:", err);
        throw err;
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

  const filteredEntries = createMemo(() => {
    const all = allEntries() ?? [];
    const q = browseQuery().trim().toLowerCase();
    if (q.length === 0) return all.slice(0, MAX_BROWSE_RESULTS);
    const scored: { entry: BibEntry; score: number }[] = [];
    for (const entry of all) {
      const text = `${entry.key} ${entry.title} ${entry.authors.join(" ")} ${entry.year ?? ""}`;
      const m = fuzzyMatch(q, text);
      if (m) scored.push({ entry, score: m.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_BROWSE_RESULTS).map((s) => s.entry);
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
          <Show when={allEntries.error}>
            <p class="sidebar-hint sidebar-hint--error">
              Failed to load bibliography: {String(allEntries.error)}
            </p>
          </Show>
          <Show when={allEntries.loading}>
            <p class="sidebar-hint">Loading bibliography…</p>
          </Show>
          <Show when={!allEntries.error && !allEntries.loading}>
            <Show
              when={(allEntries() ?? []).length > 0}
              fallback={
                <p class="sidebar-hint">
                  No bibliography configured. Check Settings &rsaquo; Citations.
                </p>
              }
            >
              <input
                class="references-panel__search"
                type="text"
                placeholder="Filter entries…"
                value={browseQuery()}
                onInput={(e) => setBrowseQuery(e.currentTarget.value)}
              />
              <For each={filteredEntries()}>
                {(entry) => (
                  <div
                    class="references-panel__entry references-panel__entry--clickable"
                    onClick={() => insertCitation(entry.key)}
                    title={`Insert @${entry.key}`}
                  >
                    <div class="references-panel__key-row">
                      <span class="references-panel__key">@{entry.key}</span>
                      <Show when={isZoteroSource() && entry.zotero_item_key}>
                        <button
                          class="references-panel__zotero-link"
                          onClick={(e) => openInZotero(e, entry.zotero_item_key!)}
                          title="Open in Zotero"
                        >
                          <ZoteroIcon />
                        </button>
                      </Show>
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
              <Show when={browseQuery().trim() && filteredEntries().length === 0}>
                <p class="sidebar-hint">No matching entries</p>
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
        <Show when={citations.error}>
          <p class="sidebar-hint sidebar-hint--error">Failed to load citations</p>
        </Show>
        <Show when={!citations.error}>
          <Show
            when={citations()?.length}
            fallback={<p class="sidebar-hint">No citations in this file</p>}
          >
            <For each={citations()}>
              {(cite) => (
                <div class="references-panel__entry">
                  <div class="references-panel__key-row">
                    <span class="references-panel__key">@{cite.key}</span>
                    <Show when={isZoteroSource() && cite.zotero_item_key}>
                      <button
                        class="references-panel__zotero-link"
                        onClick={(e) => openInZotero(e, cite.zotero_item_key!)}
                        title="Open in Zotero"
                      >
                        <ZoteroIcon />
                      </button>
                    </Show>
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
