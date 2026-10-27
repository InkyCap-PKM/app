import { createSignal, onCleanup } from "solid-js";

/**
 * Watches an element for horizontal overflow (content clipped at the trailing
 * edge), returning an `overflowing` signal and a `ref`. Drives an edge shadow
 * showing there are hidden controls (a narrow sidebar's mode bar, the right
 * panel's tab bar). The fix is to widen the panel, not scroll, so only the
 * trailing edge overflows. A `ResizeObserver` catches resizes and a
 * `MutationObserver` buttons appearing or disappearing.
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
