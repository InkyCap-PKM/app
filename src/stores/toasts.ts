import { createSignal } from "solid-js";
import { errorText } from "../lib/errors";

export type ToastLevel = "error" | "warning" | "info" | "success";

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  detail?: string;
  /** When set, an X button on the toast invokes this callback in addition
   *  to dismissing the toast. Used for cancellable long-running work
   *  (e.g. the in-progress backup toast). */
  onCancel?: () => void;
  /** When true the toast stays until the caller dismisses it and the
   *  whole-toast click-to-dismiss is suppressed (otherwise the user
   *  thinks they cancelled the work when they only hid its progress
   *  indicator). */
  persistent?: boolean;
}

let nextId = 1;
const DISPLAY_MS = 5000;
const ERROR_DISPLAY_MS = 8000;

const [toasts, setToasts] = createSignal<Toast[]>([]);

export { toasts };

export interface ShowToastOptions {
  /** Don't auto-dismiss. Used for "work in progress" toasts that
   *  should remain visible until the caller explicitly dismisses
   *  them with `dismissToast(id)` — typically by showing a result
   *  toast in their place. */
  persistent?: boolean;
  /** Wire an explicit Cancel action. When set, the toast renders an
   *  X button that invokes this callback (and dismisses the toast).
   *  Use for in-progress toasts that represent cancellable work — a
   *  toast without an `onCancel` has no way to abort the underlying
   *  job, so it shouldn't pretend to. */
  onCancel?: () => void;
}

export function showToast(
  level: ToastLevel,
  message: string,
  detail?: string,
  options?: ShowToastOptions,
): number {
  const id = nextId++;
  setToasts((prev) => [
    ...prev,
    {
      id,
      level,
      message,
      detail,
      onCancel: options?.onCancel,
      persistent: options?.persistent,
    },
  ]);
  if (!options?.persistent) {
    const ms = level === "error" ? ERROR_DISPLAY_MS : DISPLAY_MS;
    setTimeout(() => dismissToast(id), ms);
  }
  return id;
}

export function dismissToast(id: number) {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

export function toastError(message: string, err?: unknown) {
  const detail = err != null ? errorText(err) : undefined;
  showToast("error", message, detail);
}

export function toastSuccess(message: string) {
  showToast("success", message);
}

export function toastWarning(message: string) {
  showToast("warning", message);
}
