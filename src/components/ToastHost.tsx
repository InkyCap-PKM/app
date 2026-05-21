import { Component, For, Show } from "solid-js";
import { toasts, dismissToast, type ToastLevel } from "../stores/toasts";

const LEVEL_ICONS: Record<ToastLevel, string> = {
  error: "✖",
  warning: "⚠",
  info: "ℹ",
  success: "✔",
};

/// Split a toast message that ends in `…` (or `...`) into its static
/// prefix and an `animated` flag. Used to swap a static ellipsis for
/// the staggered-dot pulse so an "in-progress" toast that lingers (a
/// persistent toast waiting on a long backend call) reads as alive
/// rather than stuck. Strings that don't end in an ellipsis pass
/// through unchanged.
function splitTrailingEllipsis(message: string): { prefix: string; animated: boolean } {
  if (message.endsWith("…")) return { prefix: message.slice(0, -1), animated: true };
  if (message.endsWith("...")) return { prefix: message.slice(0, -3), animated: true };
  return { prefix: message, animated: false };
}

const ToastHost: Component = () => {
  return (
    <div class="toast-host">
      <For each={toasts()}>
        {(toast) => {
          const { prefix, animated } = splitTrailingEllipsis(toast.message);
          // Persistent toasts (in-progress indicators) must not
          // dismiss-on-click: clicking the whole toast away while
          // the underlying work keeps running is confusing — the
          // user thinks they cancelled. Non-persistent toasts keep
          // click-to-dismiss because they auto-dismiss anyway.
          const allowBodyDismiss = !toast.persistent;
          // Show an explicit close/cancel button when either:
          //   - the toast wires `onCancel` (work that can be aborted), or
          //   - the toast is persistent without `onCancel` (the user
          //     needs *some* way to clear it manually).
          const showCloseBtn = toast.onCancel != null || toast.persistent;
          const closeBtnLabel = toast.onCancel ? "Cancel" : "Dismiss";

          function handleClose(e: MouseEvent) {
            e.stopPropagation();
            toast.onCancel?.();
            dismissToast(toast.id);
          }

          return (
            <div
              class={`toast toast--${toast.level}`}
              classList={{ "toast--persistent": toast.persistent }}
              role="alert"
              onClick={allowBodyDismiss ? () => dismissToast(toast.id) : undefined}
            >
              <span class="toast__icon">{LEVEL_ICONS[toast.level]}</span>
              <div class="toast__body">
                <span class="toast__message">
                  {prefix}
                  <Show when={animated}>
                    <span class="loading-dots" aria-hidden="true">
                      <span class="loading-dots__dot loading-dots__dot--1">.</span>
                      <span class="loading-dots__dot loading-dots__dot--2">.</span>
                      <span class="loading-dots__dot loading-dots__dot--3">.</span>
                    </span>
                  </Show>
                </span>
                <Show when={toast.detail}>
                  <span class="toast__detail">{toast.detail}</span>
                </Show>
              </div>
              <Show when={showCloseBtn}>
                <button
                  type="button"
                  class="toast__close"
                  onClick={handleClose}
                  aria-label={closeBtnLabel}
                  title={closeBtnLabel}
                >
                  ×
                </button>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
};

export default ToastHost;
