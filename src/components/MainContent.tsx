import { Component, Show, For, onMount, onCleanup } from "solid-js";
import { createSignal } from "solid-js";
import {
  tabs,
  activeTabId,
  setActiveTabId,
  closeTab,
  getActiveTab,
  reorderTab,
  createEmptyTab,
} from "../stores/tabs";
import { t } from "../lib/i18n";
import { modifierKey } from "../lib/platform";
import CollectionTable from "./CollectionTable";
import TypstEditor from "./TypstEditor";
import MycelialView from "./MycelialView";
import { executeCommand } from "../lib/command-registry";
import { isEnabled as isJournalScrollTab } from "../stores/journal-scroll";
import { reviewModeCollabidForPath } from "../stores/collab";
import { BrainCircuit, ChevronLeft, ChevronRight, Scroll, LibraryBig, MessageSquareCheck } from "lucide-solid";

/// Render the title for a tab. File tabs show the basename without the
/// extension; other tab types keep their title verbatim (e.g. "Mycelial:
/// foo", "References", search results). The dot must follow at least one
/// character so a leading-dot file like ".gitignore" doesn't render blank.
function displayTabTitle(tab: { type: string; title: string }): string {
  if (tab.type !== "file") return tab.title;
  return tab.title.replace(/^(.+)\.[^.]+$/, "$1");
}

/// Tabula-rasa view shown when no tab is open (or the active tab is the
/// `empty` placeholder). Headline plus two shortcut hints; the modifier
/// glyph adapts to the host OS so Mac users see `⌘` and everyone else
/// sees `Ctrl`.
const EmptyState: Component = () => {
  const modifier = modifierKey();
  return (
    <div class="empty-state">
      <p class="empty-state__primary">{t("mainContent.emptyState")}</p>
      <p>&nbsp;</p>
      <p class="empty-state__hint">{t("mainContent.emptyState.shortcuts")}</p>
      <p class="empty-state__hint">
        {t("mainContent.emptyState.openFileHint", { modifier })}
      </p>
      <p class="empty-state__hint">
        {t("mainContent.emptyState.createFileHint", { modifier })}
      </p>
      <p class="empty-state__hint">
        {t("mainContent.emptyState.commandsHint", { modifier })}
      </p>
    </div>
  );
};

const MainContent: Component = () => {
  // Track dirty state per tab
  const [dirtyTabs, setDirtyTabs] = createSignal<Set<string>>(new Set());

  // Drag-to-reorder state
  const [dragFromIndex, setDragFromIndex] = createSignal<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(null);

  function handleDirtyChange(tabId: string, dirty: boolean) {
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      if (dirty) {
        next.add(tabId);
      } else {
        next.delete(tabId);
      }
      return next;
    });
  }

  function handleDragStart(index: number, e: DragEvent) {
    setDragFromIndex(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
    }
  }

  function handleDragOver(index: number, e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    setDropTargetIndex(index);
  }

  function handleDrop(index: number) {
    const from = dragFromIndex();
    if (from !== null && from !== index) {
      reorderTab(from, index);
    }
    setDragFromIndex(null);
    setDropTargetIndex(null);
  }

  function handleDragEnd() {
    setDragFromIndex(null);
    setDropTargetIndex(null);
  }

  let scrollAreaRef: HTMLDivElement | undefined;
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);

  function updateScrollState() {
    const el = scrollAreaRef;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  function scrollTabs(direction: -1 | 1) {
    scrollAreaRef?.scrollBy({ left: direction * 200, behavior: "smooth" });
  }

  onMount(() => {
    const el = scrollAreaRef;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState);
    el.addEventListener("scrollend", updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    const mo = new MutationObserver(updateScrollState);
    mo.observe(el, { childList: true });
    updateScrollState();
    onCleanup(() => {
      el.removeEventListener("scroll", updateScrollState);
      el.removeEventListener("scrollend", updateScrollState);
      ro.disconnect();
      mo.disconnect();
    });
  });

  return (
    <div class="main-content">
      <div class="main-content__tabs">
        <Show when={canScrollLeft()}>
          <button class="tab-bar__scroll tab-bar__scroll--left" onClick={() => scrollTabs(-1)} aria-label="Scroll tabs left">
            <ChevronLeft size={14} />
          </button>
        </Show>
        <div class="tab-bar__scroll-area" ref={scrollAreaRef}>
          <For each={tabs}>
            {(tab, index) => (
              <div
                class={`tab${tab.id === activeTabId() ? " tab--active" : ""}${dragFromIndex() === index() ? " tab--dragging" : ""}${dropTargetIndex() === index() && dragFromIndex() !== index() ? " tab--drop-target" : ""}`}
                onClick={() => setActiveTabId(tab.id)}
                draggable={true}
                onDragStart={(e) => handleDragStart(index(), e)}
                onDragOver={(e) => handleDragOver(index(), e)}
                onDrop={() => handleDrop(index())}
                onDragEnd={handleDragEnd}
              >
                <Show when={isJournalScrollTab(tab.id)}>
                  <span class="tab__icon" title={t("journalScroll.tab.title")}>
                    <Scroll size={13} />
                  </span>
                </Show>
                <Show when={tab.type === "mycelial"}>
                  <span class="tab__icon" title={t("mycelial.tab.title")}>
                    <BrainCircuit size={13} />
                  </span>
                </Show>
                <Show when={tab.type === "collection"}>
                  <span class="tab__icon" title={t("collection.tab.title")}>
                    <LibraryBig size={13} />
                  </span>
                </Show>
                <Show when={tab.type === "file" && reviewModeCollabidForPath(tab.path) !== null}>
                  <span class="tab__icon" title="Reviewing collaboration changes">
                    <MessageSquareCheck size={13} />
                  </span>
                </Show>
                <span class="tab__title">
                  {dirtyTabs().has(tab.id) ? "\u25CF " : ""}
                  {displayTabTitle(tab)}
                </span>
                <button
                  class="tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  {"\u00D7"}
                </button>
              </div>
            )}
          </For>
        </div>
        <Show when={canScrollRight()}>
          <button class="tab-bar__scroll tab-bar__scroll--right" onClick={() => scrollTabs(1)} aria-label="Scroll tabs right">
            <ChevronRight size={14} />
          </button>
        </Show>
        <button
          class="tab-bar__new"
          onClick={() => createEmptyTab()}
          title="New tab"
        >
          {"+"}
        </button>
        <div class="main-content__tabs-spacer" />
      </div>
      <div class={`main-content__body${getActiveTab()?.type === "collection" ? " main-content__body--collection" : ""}`}>
        <Show
          when={getActiveTab()}
          fallback={
            <EmptyState />
          }
        >
          {(tab) => (
            // Keyed by tab id *and* type::path: the editor is rebuilt when a
            // tab navigates in-place to a different file (path changes), and
            // — crucially — two tabs that share a path still get distinct
            // editor instances. Without the id, opening a note that is also
            // a Journal Scroll's anchor reuses the scroll tab's editor (same
            // path), so the new tab wrongly renders as a Journal Scroll.
            <Show when={`${tab().id}::${tab().type}::${tab().path}`} keyed>
              {(_key: string) => {
                // Named `currentTab` (not `t`) so it doesn't shadow the
                // imported `t` i18n helper used in this block.
                const currentTab = tab();
                if (currentTab.type === "empty" || !currentTab.path) {
                  return <EmptyState />;
                }
                if (currentTab.type === "collection") {
                  return <CollectionTable path={currentTab.path} />;
                }
                if (currentTab.type === "mycelial") {
                  return <MycelialView path={currentTab.path} />;
                }
                return (
                  <TypstEditor
                    path={currentTab.path}
                    tabId={currentTab.id}
                    onDirtyChange={(dirty) => handleDirtyChange(currentTab.id, dirty)}
                  />
                );
              }}
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
};

export default MainContent;
