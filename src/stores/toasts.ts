import { createSignal } from "solid-js";

export type ToastLevel = "error" | "warning" | "info" | "success";

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  detail?: string;
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
}

export function showToast(
  level: ToastLevel,
  message: string,
  detail?: string,
  options?: ShowToastOptions,
): number {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, level, message, detail }]);
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
  const detail = err instanceof Error ? err.message : err ? String(err) : undefined;
  showToast("error", message, detail);
}

export function toastSuccess(message: string) {
  showToast("success", message);
}

export function toastWarning(message: string) {
  showToast("warning", message);
}
