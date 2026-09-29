import { onCleanup } from "solid-js";

/**
 * Tie an app-event subscription to the current component's lifetime.
 *
 * Subscribing to a backend event (`listen`, `onFileChanged`, ...) resolves
 * asynchronously. If the component is torn down before that happens, a plain
 * `onCleanup(() => unlisten?.())` runs while `unlisten` is still unset and the
 * subscription outlives the component. This unsubscribes as soon as the
 * subscription arrives in that case.
 *
 * Call it during component setup, where `onCleanup` is allowed.
 */
export function listenWhileMounted(subscription: Promise<() => void>): void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void subscription.then((un) => {
    if (disposed) un();
    else unlisten = un;
  });
  onCleanup(() => {
    disposed = true;
    unlisten?.();
  });
}
