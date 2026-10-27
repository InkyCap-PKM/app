import { Component, For, Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import {
  tabs,
  setActiveTabId,
  closeTab,
  createEmptyTab,
  dirtyTabIds,
  tabDisplayTitle,
  isSyncedTab,
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
  Plus,
  Scroll,
  LibraryBig,
  GitCompareArrows,
  Link2,
  Paperclip,
} from "lucide-solid";
import TabBarMenu from "./TabBarMenu";

/** Payload carried by a tab drag, so a drop in any pane knows which tab
 *  moved and where it came from (same pane → reorder, other pane → move). */
interface TabDragPayload {
  tabId: string;
  sourcePaneId: string;
}

/**
 * A pane's tab row: its tabs (drag to reorder, or into another pane to move), a
 * control group with the scroll arrows and new-tab button, and the pane menu
 * (`PanelTopOpen`) at the right. Tabs shrink to a readable minimum before the
 * row scrolls, and an overflowing edge fades out, showing there is more.
 */
const TabStrip: Component<{ leaf: LeafPane }> = (props) => {
  const t = useI18n();
  // Local drag state, for the insertion cue only. The move itself reads the tab
  // and source pane from the drag data, so drags from other panes work.
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
      // WebKitGTK and Firefox reject drags without data (no drop fires); the
      // data also tells another pane which tab moved.
      const payload: TabDragPayload = { tabId, sourcePaneId: props.leaf.id };
      e.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify(payload));
    }
  }

  // Drag over and drop are handled on the row, not each tab, so dropping
  // anywhere in it (including the empty space after the tabs) works. The
  // insertion point comes from the tabs' positions.
  function tabElements(): HTMLElement[] {
    return scrollAreaRef
      ? Array.from(scrollAreaRef.querySelectorAll<HTMLElement>(".tab"))
      : [];
  }

  /**
   * Insertion point from the pointer: `over` is the reference tab, `after`
   * which side of it. `over === -1` when there are no tabs.
   */
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
  let leftArrowRef: HTMLButtonElement | undefined;
  let rightArrowRef: HTMLButtonElement | undefined;
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);
  /**
   * True when the tabs are wider than the track; decides whether the arrows and
   * end gutters show. The arrows are positioned absolutely, so showing them
   * shifts nothing. Not derived from `canScrollLeft || canScrollRight`, since
   * the gutters are scrollable themselves and the arrows would never hide.
   */
  const [overflowing, setOverflowing] = createSignal(false);

  /**
   * Slack for comparing edges. `scrollWidth` / `clientWidth` are rounded, and
   * WebKit leaves a trailing margin out of `scrollWidth`, so they can miss a
   * few pixels of overflow. The first and last tabs' own boxes are measured
   * instead, which is exact.
   */
  const EDGE_EPSILON = 0.5;

  function updateScrollState() {
    const area = scrollAreaRef;
    if (!area) return;
    const tabEls = tabElements();
    const first = tabEls[0];
    const last = tabEls[tabEls.length - 1];
    if (!first || !last) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      setOverflowing(false);
      return;
    }
    const areaRect = area.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();

    // Scroll position: how far the outermost tabs poke past the track's edges.
    setCanScrollLeft(areaRect.left - firstRect.left > EDGE_EPSILON);
    setCanScrollRight(lastRect.right - areaRect.right > EDGE_EPSILON);

    // Capacity: the tabs' own span against the track's content box. The
    // gutters sit outside the first and last tab, so they don't inflate this.
    const style = getComputedStyle(area);
    const available =
      areaRect.width -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0);
    setOverflowing(lastRect.right - firstRect.left - available > EDGE_EPSILON);
  }

  function scrollTabs(direction: -1 | 1) {
    scrollAreaRef?.scrollBy({ left: direction * 200, behavior: "smooth" });
  }

  /**
   * The wheel scrolls the row sideways (it has no scrollbar), as browsers and
   * the collection view tabs do. A trackpad's horizontal movement is used when
   * it dominates.
   */
  function handleWheel(e: WheelEvent) {
    const area = e.currentTarget as HTMLElement;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    if (!canScrollLeft() && !canScrollRight()) return;
    e.preventDefault();
    area.scrollLeft += delta;
  }

  /**
   * Scroll the active tab fully into view when it changes (including a new tab),
   * so its close button isn't hidden. Scroll by exactly its overflow plus the
   * arrow's width, so it lands beside the arrow.
   */
  createEffect(() => {
    const activeId = props.leaf.activeTabId;
    // Also depend on the tabs, since a new tab's element doesn't exist yet when
    // activeTabId changes.
    stripTabs();
    if (!activeId) return;
    const area = scrollAreaRef;
    if (!area) return;
    // rAF so a just-opened tab's node is laid out before we measure it.
    requestAnimationFrame(() => {
      // Measure here too: the observers can fire before the new tab is laid out
      // at its final width, and this runs a frame later.
      updateScrollState();
      const el = area.querySelector<HTMLElement>(".tab--active");
      if (!el) return;
      // Measure the arrows instead of assuming their width, and add the track's
      // gap, so the tab sits a little clear of the arrow.
      const areaRect = area.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(area).columnGap) || 0;
      const overRight =
        elRect.right + (rightArrowRef?.offsetWidth ?? 0) + gap - areaRect.right;
      const overLeft =
        elRect.left - (leftArrowRef?.offsetWidth ?? 0) - gap - areaRect.left;
      if (overRight > 0) area.scrollBy({ left: overRight, behavior: "smooth" });
      else if (overLeft < 0) area.scrollBy({ left: overLeft, behavior: "smooth" });
    });
  });

  onMount(() => {
    const el = scrollAreaRef;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState);
    el.addEventListener("scrollend", updateScrollState);
    // Observe the track and every tab: the track can keep its size while tabs
    // grow (a dirty dot, a new name, a language switch).
    const ro = new ResizeObserver(updateScrollState);
    function observeTabs() {
      ro.disconnect();
      ro.observe(el!);
      for (const tabEl of tabElements()) ro.observe(tabEl);
      updateScrollState();
    }
    // `subtree` + `characterData` so a title's text changing in place counts,
    // not just a tab being added or removed.
    const mo = new MutationObserver(observeTabs);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    observeTabs();
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
      <div class="tab-bar__track">
        <div class="tab-bar__scroll-area" ref={scrollAreaRef} onWheel={handleWheel}>
          {/* End gutters, present only while the strip overflows. They give the
              tabs somewhere to scroll to that is clear of the arrows, so a tab
              never comes to rest hidden underneath a disabled one. Real elements
              rather than padding on the scroller: WebKit omits a scroll
              container's end padding from its scrollable extent, which would
              leave the last tab unreachable. */}
          <Show when={overflowing()}>
            <span class="tab-bar__gutter" aria-hidden="true" />
          </Show>
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
                  <Show when={tab.type === "attachment"}>
                    <span class="tab__icon" title={t("attachmentView.tab.title")}>
                      <Paperclip size={13} />
                    </span>
                  </Show>
                  <Show when={tab.type === "version-diff"}>
                    <span class="tab__icon" title={t("versionDiff.tab.title")}>
                      <GitCompareArrows size={13} />
                    </span>
                  </Show>
                  <Show when={isSyncedTab(tab.id)}>
                    <span
                      class="tab__icon tab__icon--sync"
                      title={t("tab.syncedPreview")}
                    >
                      <Link2 size={13} />
                    </span>
                  </Show>
                  <span class="tab__title" title={tabDisplayTitle(tab)}>
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
          <Show when={overflowing()}>
            <span class="tab-bar__gutter" aria-hidden="true" />
          </Show>
        </div>
        {/* The arrows sit *over* the ends of the track, opaque and shadowed, so
            tabs read as sliding underneath them. Being absolutely positioned
            they cost no layout: painting one can't shift the new-tab button,
            and reaching the end of the strip leaves a disabled arrow in place
            rather than removing the control under the pointer — which is what
            used to let a repeated scroll click land on a tab's close ×. */}
        <button
          ref={leftArrowRef}
          class="tab-bar__scroll tab-bar__scroll--left"
          classList={{ "tab-bar__scroll--idle": !overflowing() }}
          disabled={!canScrollLeft()}
          onClick={() => scrollTabs(-1)}
          aria-label={t("tabStrip.scrollLeft")}
          aria-hidden={!overflowing()}
          tabIndex={overflowing() ? 0 : -1}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          ref={rightArrowRef}
          class="tab-bar__scroll tab-bar__scroll--right"
          classList={{ "tab-bar__scroll--idle": !overflowing() }}
          disabled={!canScrollRight()}
          onClick={() => scrollTabs(1)}
          aria-label={t("tabStrip.scrollRight")}
          aria-hidden={!overflowing()}
          tabIndex={overflowing() ? 0 : -1}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      {/* The track above takes all the free width, so these stay pinned at the
          right edge instead of drifting with the tab count. */}
      <div class="tab-bar__controls">
        <span class="tab-bar__controls-divider" aria-hidden="true" />
        <button
          class="tab-bar__new"
          onClick={() => {
            focusPane(props.leaf.id);
            createEmptyTab();
          }}
          title={t("tabStrip.newTab")}
        >
          <Plus size={14} />
        </button>
      </div>
      <TabBarMenu leaf={props.leaf} />
    </div>
  );
};

export default TabStrip;
