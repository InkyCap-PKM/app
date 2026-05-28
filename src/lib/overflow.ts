import { createSignal, onCleanup } from "solid-js";

/**
 * Watches an element for horizontal overflow — content wider than the box, so
 * some of it is clipped at the trailing edge. Returns a reactive `overflowing`
 * signal and a `ref` to attach to the element.
 *
 * Used to drive an edge shadow that cues the user there are hidden controls
 * (e.g. a narrowed sidebar's mode bar / the right panel's tab bar). It implies
 * no scrolling: the reveal gesture is widening the panel, so only the trailing
 * edge ever overflows. A `ResizeObserver` catches panel resizes and a
 * `MutationObserver` catches buttons appearing/disappearing.
 */
export function createOverflowWatcher() {
  const [overflowing, setOverflowing] = createSignal(false);
  let ro: ResizeObserver | undefined;
  let mo: MutationObserver | undefined;

  const ref = (node: HTMLElement) => {
    const update = () =>
      setOverflowing(node.scrollWidth > node.clientWidth + 1);
    ro = new ResizeObserver(update);
    ro.observe(node);
    mo = new MutationObserver(update);
    mo.observe(node, { childList: true, subtree: true });
    // Defer the first read until layout settles after mount.
    queueMicrotask(update);
  };

  onCleanup(() => {
    ro?.disconnect();
    mo?.disconnect();
  });

  return { overflowing, ref };
}
