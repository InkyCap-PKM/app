import { Component, For, Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import {
  tabs,
  setActiveTabId,
  closeTab,
  createEmptyTab,
  dirtyTabIds,
  tabDisplayTitle,
  TAB_DRAG_MIME,
  type Tab,
} from "../../stores/tabs";
import { focusPane, moveTabWithinLeaf, moveTab, type LeafPane } from "../../stores/panes";
import { useI18n } from "../../lib/i18n";
import { isEnabled as isJournalScrollTab } from "../../stores/journal-scroll";
import {
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Scroll,
  LibraryBig,
  GitCompareArrows,
} from "lucide-solid";
import TabBarMenu from "./TabBarMenu";

/** Payload carried by a tab drag, so a drop in any pane knows which tab
 *  moved and where it came from (same pane → reorder, other pane → move). */
interface TabDragPayload {
  tabId: string;
  sourcePaneId: string;
}

/**
 * The tab row for a single leaf pane: its tabs (drag to reorder within the
 * pane, or drag into another pane to move), overflow scroll arrows, a
 * new-tab button, and the pane menu (`PanelTopOpen`) at the right edge.
 */
const TabStrip: Component<{ leaf: LeafPane }> = (props) => {
  const t = useI18n();
  // Drag state is local to this strip; it only drives the visual insertion
  // cue. The actual move reads the tab id + source pane from the dataTransfer
  // payload, so a drag that started in another pane lands correctly here.
  const [dragFromIndex, setDragFromIndex] = createSignal<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(null);
  const [dropAfter, setDropAfter] = createSignal(false);

  const stripTabs = (): Tab[] =>
    props.leaf.tabIds
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is Tab => tab !== undefined);

  function handleDragStart(index: number, tabId: string, e: DragEvent) {
    setDragFromIndex(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // WebKitGTK (Tauri's Linux webview) and Firefox treat a drag with no
      // payload as invalid — drop never fires and the tab snaps back. The
      // payload also tells a drop in another pane which tab moved.
      const payload: TabDragPayload = { tabId, sourcePaneId: props.leaf.id };
      e.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify(payload));
    }
  }

  // DnD over/drop is handled at the strip-container level (not per tab) so a
  // drop anywhere in the row — including the empty space to the right of the
  // tabs — lands correctly. The insertion point is computed from the actual
  // tab element positions.
  function tabElements(): HTMLElement[] {
    return scrollAreaRef
      ? Array.from(scrollAreaRef.querySelectorAll<HTMLElement>(".tab"))
      : [];
  }

  /** Insertion point from the pointer: `over` is the reference tab and
   *  `after` which side of it — together they drive both the visual cue and
   *  the computed slot. `over === -1` means the strip has no tabs. */
  function computeDrop(e: DragEvent): { over: number; after: boolean } {
    const els = tabElements();
    if (els.length === 0) return { over: -1, after: true };
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) return { over: i, after: false };
    }
    return { over: els.length - 1, after: true };
  }

  function handleStripDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const d = computeDrop(e);
    setDropTargetIndex(d.over);
    setDropAfter(d.after);
  }

  function handleStripDrop(e: DragEvent) {
    if (!e.dataTransfer?.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData(TAB_DRAG_MIME);
    const d = computeDrop(e);
    resetDragState();
    if (!raw) return;
    let payload: TabDragPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const slot = d.over < 0 ? 0 : d.over + (d.after ? 1 : 0);
    if (payload.sourcePaneId === props.leaf.id) {
      // Reorder within this pane: compensate for the splice removal when the
      // tab moves rightward.
      const from = props.leaf.tabIds.indexOf(payload.tabId);
      if (from === -1) return;
      let target = slot;
      if (from < target) target -= 1;
      moveTabWithinLeaf(props.leaf.id, from, target);
    } else {
      moveTab(payload.tabId, props.leaf.id, slot);
    }
  }

  function handleStripDragLeave(e: DragEvent) {
    // Clear the cue only when the pointer actually leaves the strip — moving
    // between the strip's own children also fires dragleave.
    const related = e.relatedTarget as Node | null;
    if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
      resetDragState();
    }
  }

  function resetDragState() {
    setDragFromIndex(null);
    setDropTargetIndex(null);
    setDropAfter(false);
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

  /** Scroll the active tab fully into view whenever it changes (or a new tab is
   *  opened, which activates it). Without this, a tab opened past the right edge
   *  stays clipped — its close × hidden — until the user manually clicks the ›
   *  arrow, and the fixed-step arrow may not reveal the whole tab in one press.
   *  We scroll by exactly the amount the tab overflows either edge, plus a small
   *  buffer so the × isn't flush against the boundary. */
  const ACTIVE_TAB_BUFFER = 8;
  createEffect(() => {
    const activeId = props.leaf.activeTabId;
    // Depend on the tab set too: when a brand-new active tab is opened its DOM
    // node isn't present yet at the moment activeTabId changes, so re-running on
    // the tab list ensures we scroll once it has mounted.
    stripTabs();
    if (!activeId) return;
    const area = scrollAreaRef;
    if (!area) return;
    // rAF so a just-opened tab's node is laid out before we measure it.
    requestAnimationFrame(() => {
      const el = area.querySelector<HTMLElement>(".tab--active");
      if (!el) return;
      const areaRect = area.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const overRight = elRect.right + ACTIVE_TAB_BUFFER - areaRect.right;
      const overLeft = elRect.left - ACTIVE_TAB_BUFFER - areaRect.left;
      if (overRight > 0) area.scrollBy({ left: overRight, behavior: "smooth" });
      else if (overLeft < 0) area.scrollBy({ left: overLeft, behavior: "smooth" });
    });
  });

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
    <div
      class="main-content__tabs"
      onDragOver={handleStripDragOver}
      onDrop={handleStripDrop}
      onDragLeave={handleStripDragLeave}
    >
      <Show when={canScrollLeft()}>
        <button
          class="tab-bar__scroll tab-bar__scroll--left"
          onClick={() => scrollTabs(-1)}
          aria-label={t("tabStrip.scrollLeft")}
        >
          <ChevronLeft size={14} />
        </button>
      </Show>
      <div class="tab-bar__scroll-area" ref={scrollAreaRef}>
        <For each={stripTabs()}>
          {(tab, index) => {
            const isDropTarget = () =>
              dropTargetIndex() === index() && dragFromIndex() !== index();
            return (
              <div
                class={`tab${tab.id === props.leaf.activeTabId ? " tab--active" : ""}${dragFromIndex() === index() ? " tab--dragging" : ""}${isDropTarget() ? (dropAfter() ? " tab--drop-after" : " tab--drop-before") : ""}`}
                onClick={() => setActiveTabId(tab.id)}
                draggable={true}
                onDragStart={(e) => handleDragStart(index(), tab.id, e)}
                onDragEnd={resetDragState}
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
                <Show when={tab.type === "version-diff"}>
                  <span class="tab__icon" title={t("versionDiff.tab.title")}>
                    <GitCompareArrows size={13} />
                  </span>
                </Show>
                <span class="tab__title">
                  {dirtyTabIds().has(tab.id) ? "● " : ""}
                  {tabDisplayTitle(tab)}
                </span>
                <button
                  class="tab__close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  {"×"}
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={canScrollRight()}>
        <button
          class="tab-bar__scroll tab-bar__scroll--right"
          onClick={() => scrollTabs(1)}
          aria-label={t("tabStrip.scrollRight")}
        >
          <ChevronRight size={14} />
        </button>
      </Show>
      <button
        class="tab-bar__new"
        onClick={() => {
          focusPane(props.leaf.id);
          createEmptyTab();
        }}
        title={t("tabStrip.newTab")}
      >
        {"+"}
      </button>
      <div class="main-content__tabs-spacer" />
      <TabBarMenu leaf={props.leaf} />
    </div>
  );
};

export default TabStrip;
