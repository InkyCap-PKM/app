import { Component, For, Show } from "solid-js";
import { toasts, dismissToast, type ToastLevel } from "../stores/toasts";

const LEVEL_ICONS: Record<ToastLevel, string> = {
  error: "✖",
  warning: "⚠",
  info: "ℹ",
  success: "✔",
};

const ToastHost: Component = () => {
  return (
    <div class="toast-host">
      <For each={toasts()}>
        {(toast) => (
          <div
            class={`toast toast--${toast.level}`}
            role="alert"
            onClick={() => dismissToast(toast.id)}
          >
            <span class="toast__icon">{LEVEL_ICONS[toast.level]}</span>
            <div class="toast__body">
              <span class="toast__message">{toast.message}</span>
              <Show when={toast.detail}>
                <span class="toast__detail">{toast.detail}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
};

export default ToastHost;
