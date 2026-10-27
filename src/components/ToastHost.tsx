import { Component, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-solid";
import { toasts, dismissToast, type ToastLevel } from "../stores/toasts";
import { useI18n } from "../lib/i18n";
import LoadingDots from "./LoadingDots";

/** Each level's icon, the same set the export dialog uses. Each has its own
 *  shape, and none looks like the close button's ×. */
const LEVEL_ICONS: Record<ToastLevel, typeof Info> = {
  error: OctagonAlert,
  warning: TriangleAlert,
  info: Info,
  success: CircleCheck,
};

/// Split a message ending in `…` (or `...`) into its text and an `animated`
/// flag, so a lingering "in progress" toast shows pulsing dots instead of a
/// static ellipsis and doesn't look stuck. Other messages pass through.
function splitTrailingEllipsis(message: string): { prefix: string; animated: boolean } {
  if (message.endsWith("…")) return { prefix: message.slice(0, -1), animated: true };
  if (message.endsWith("...")) return { prefix: message.slice(0, -3), animated: true };
  return { prefix: message, animated: false };
}

const ToastHost: Component = () => {
  const t = useI18n();
  return (
    <div class="toast-host">
      <For each={toasts()}>
        {(toast) => {
          const { prefix, animated } = splitTrailingEllipsis(toast.message);
          // Persistent (in-progress) toasts don't close on click: closing one
          // while the work continues would look like cancelling it. Others
          // close on click, since they close by themselves anyway.
          const allowBodyDismiss = !toast.persistent;
          // Show a close/cancel button when the toast has `onCancel`
          // (cancellable work), or is persistent without one (so it can still
          // be cleared).
          const showCloseBtn = toast.onCancel != null || toast.persistent;
          const closeBtnLabel = () => t(toast.onCancel ? "common.cancel" : "common.dismiss");

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
              <span class="toast__icon">
                <Dynamic component={LEVEL_ICONS[toast.level]} size="1em" aria-hidden="true" />
              </span>
              <div class="toast__body">
                <span class="toast__message">
                  {prefix}
                  <Show when={animated}>
                    <LoadingDots />
                  </Show>
                </span>
                <Show when={toast.detail}>
                  <span class="toast__detail">{toast.detail}</span>
                </Show>
                <Show when={toast.action}>
                  {(action) => (
                    <span class="toast__actions">
                      <button
                        type="button"
                        class="btn btn--secondary btn--sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          action().run();
                        }}
                      >
                        {action().label}
                      </button>
                    </span>
                  )}
                </Show>
              </div>
              <Show when={showCloseBtn}>
                <button
                  type="button"
                  class="toast__close"
                  onClick={handleClose}
                  aria-label={closeBtnLabel()}
                  title={closeBtnLabel()}
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
