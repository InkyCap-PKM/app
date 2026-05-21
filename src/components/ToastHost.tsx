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
          return (
            <div
              class={`toast toast--${toast.level}`}
              role="alert"
              onClick={() => dismissToast(toast.id)}
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
            </div>
          );
        }}
      </For>
    </div>
  );
};

export default ToastHost;
