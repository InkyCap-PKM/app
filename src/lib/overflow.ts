import { createSignal, onCleanup } from "solid-js";

/**
 * Watches a row of tab buttons (the left sidebar's mode bar, the right panel's
 * tabs) for buttons cut off at its trailing edge. `overflowing` drives the
 * edge shadow and the "more" button (TabStripMoreButton); `hiddenButtons`
 * lists the buttons that don't fully show, for its menu. Those buttons are
 * marked `data-tab-hidden` and the stylesheet hides them, so a tab shows
 * either in the row or in the menu, never half in both. A hidden button keeps
 * its space, so the buttons before it don't move.
 *
 * `activeClass` is the class the row puts on the current tab. `activeHidden`
 * is true when that tab is one of the hidden ones, so the "more" button can
 * show that the open pane is behind it.
 *
 * A `ResizeObserver` catches resizes and a `MutationObserver` buttons
 * appearing, disappearing or changing which one is active.
 */
export function createTabStripOverflow(activeClass: string) {
  const [overflowing, setOverflowing] = createSignal(false);
  const [activeHidden, setActiveHidden] = createSignal(false);
  let strip: HTMLElement | undefined;
  let ro: ResizeObserver | undefined;
  let mo: MutationObserver | undefined;

  const hiddenButtons = (): HTMLButtonElement[] => {
    if (!strip) return [];
    const edge = strip.getBoundingClientRect().right;
    return Array.from(strip.querySelectorAll<HTMLButtonElement>("button")).filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.right > edge + 1;
    });
  };

  const update = () => {
    if (!strip) return;
    const over = strip.scrollWidth > strip.clientWidth + 1;
    const hidden = new Set(over ? hiddenButtons() : []);
    for (const b of strip.querySelectorAll<HTMLButtonElement>("button")) {
      b.toggleAttribute("data-tab-hidden", hidden.has(b));
    }
    setOverflowing(over);
    setActiveHidden([...hidden].some((b) => b.classList.contains(activeClass)));
  };

  const ref = (node: HTMLElement) => {
    strip = node;
    ro = new ResizeObserver(update);
    ro.observe(node);
    // Only `class` changes matter (which tab is active); watching every
    // attribute would re-run on the `data-tab-hidden` marks set here.
    mo = new MutationObserver(update);
    mo.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    // Defer the first read until layout settles after mount.
    queueMicrotask(update);
  };

  onCleanup(() => {
    ro?.disconnect();
    mo?.disconnect();
  });

  return { overflowing, activeHidden, hiddenButtons, activeClass, ref };
}

export type TabStripOverflowState = ReturnType<typeof createTabStripOverflow>;
