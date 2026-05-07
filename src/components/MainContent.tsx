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
import CollectionTable from "./CollectionTable";
import TypstEditor from "./TypstEditor";
import FlowView from "./FlowView";
import { executeCommand } from "../lib/command-registry";
import { ChevronLeft, ChevronRight } from "lucide-solid";

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
                <span class="tab__icon">
                  {tab.type === "collection" ? "\u25A6" : tab.type === "flow" ? "\u25C9" : "\u25AB"}
                </span>
                <span class="tab__title">
                  {dirtyTabs().has(tab.id) ? "\u25CF " : ""}
                  {tab.title}
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
            <p class="empty-state">Open a file or collection to get started</p>
          }
        >
          {(tab) => (
            <Show when={`${tab().type}::${tab().path}`} keyed>
              {(_key: string) => {
                const t = tab();
                if (t.type === "empty" || !t.path) {
                  return <p class="empty-state">Open a file or collection to get started</p>;
                }
                if (t.type === "collection") {
                  return <CollectionTable path={t.path} />;
                }
                if (t.type === "flow") {
                  return <FlowView path={t.path} />;
                }
                return (
                  <TypstEditor
                    path={t.path}
                    tabId={t.id}
                    onDirtyChange={(dirty) => handleDirtyChange(t.id, dirty)}
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
