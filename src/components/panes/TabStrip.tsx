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
  Scroll,
  LibraryBig,
  GitCompareArrows,
  Link2,
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
 * pane, or drag into another pane to move), a fixed control cluster holding
 * the overflow scroll arrows and the new-tab button, and the pane menu
 * (`PanelTopOpen`) at the right edge.
 *
 * Tabs compress toward a legible floor before the strip starts scrolling, and
 * an overflowing edge fades out — so "there is more this way" is signalled by
 * the track itself, not only by whether an arrow happens to be showing.
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
  let leftArrowRef: HTMLButtonElement | undefined;
  let rightArrowRef: HTMLButtonElement | undefined;
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);
  /** True when the tabs are wider than the track. Drives whether the arrows are
   *  painted and whether the end gutters are rendered. The arrows are
   *  absolutely positioned, so painting one costs no layout and nothing to the
   *  right of the track can shift under the pointer.
   *
   *  Deliberately *not* derived from `canScrollLeft || canScrollRight`: the
   *  gutters this flag renders are themselves scrollable, so a strip whose tabs
   *  just fit would keep reporting room to scroll into its own gutter and the
   *  arrows would never stand down. Measuring the tabs' span against the
   *  track's content box is independent of both scroll position and gutters. */
  const [overflowing, setOverflowing] = createSignal(false);

  /** Sub-pixel slack when comparing edges. `scrollWidth` / `clientWidth` are
   *  rounded to integers and WebKit omits a trailing margin from a scroll
   *  container's `scrollWidth`, so the integer properties can under-report an
   *  overflow of a few pixels — the tab looks clipped but no arrow appears.
   *  Measuring the first/last tab's own border box against the viewport edge
   *  is fractional and includes every part of the tab, so it can't miss. */
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

  /** A wheel over the strip scrolls it horizontally. The track has no visible
   *  scrollbar, so without this the arrows are the only pointer affordance —
   *  and every browser, plus our own collection view-tab row, scrolls on wheel
   *  here. A trackpad's horizontal axis is honoured when it dominates. */
  function handleWheel(e: WheelEvent) {
    const area = e.currentTarget as HTMLElement;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    if (!canScrollLeft() && !canScrollRight()) return;
    e.preventDefault();
    area.scrollLeft += delta;
  }

  /** Scroll the active tab fully into view whenever it changes (or a new tab is
   *  opened, which activates it). Without this, a tab opened past the right edge
   *  stays clipped — its close × hidden — until the user manually clicks the ›
   *  arrow, and the fixed-step arrow may not reveal the whole tab in one press.
   *  We scroll by exactly the amount the tab overflows either edge, plus the
   *  width of the arrow on that side, so the tab lands beside the arrow rather
   *  than tucked underneath it. */
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
      // Re-measure from here too, not just from the observers. Those fire off
      // DOM mutations, which can land before the new tab has been laid out at
      // its final width; this runs a frame later, after layout has settled, so
      // a too-early reading can't stick and leave the arrows hidden over a
      // strip that has started overflowing.
      updateScrollState();
      const el = area.querySelector<HTMLElement>(".tab--active");
      if (!el) return;
      // Measure the arrows rather than restating their width here, so the
      // buffer can't drift out of step with the CSS.
      const areaRect = area.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const overRight =
        elRect.right + (rightArrowRef?.offsetWidth ?? 0) - areaRect.right;
      const overLeft =
        elRect.left - (leftArrowRef?.offsetWidth ?? 0) - areaRect.left;
      if (overRight > 0) area.scrollBy({ left: overRight, behavior: "smooth" });
      else if (overLeft < 0) area.scrollBy({ left: overLeft, behavior: "smooth" });
    });
  });

  onMount(() => {
    const el = scrollAreaRef;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState);
    el.addEventListener("scrollend", updateScrollState);
    // Observe the track *and* every tab in it. Watching only the track misses
    // the common case where the container keeps its size but the content grows
    // — a dirty dot appearing, "Untitled" resolving to a real filename, a
    // rename, a language switch — which previously left the arrows hidden over
    // a strip that had started overflowing.
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
          {"+"}
        </button>
      </div>
      <TabBarMenu leaf={props.leaf} />
    </div>
  );
};

export default TabStrip;
