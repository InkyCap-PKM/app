import { createSignal } from "solid-js";
import { errorText } from "../lib/errors";

export type ToastLevel = "error" | "warning" | "info" | "success";

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  detail?: string;
  /**
   * If set, an X button on the toast calls this as well as dismissing it, for
   * cancellable work (e.g. the backup progress toast).
   */
  onCancel?: () => void;
  /**
   * If true, the toast stays until the caller dismisses it, and clicking it
   * doesn't dismiss it (which would look like cancelling the work when it only
   * hid the progress).
   */
  persistent?: boolean;
  /** An optional button in the toast body (e.g. "Copy command"). Clicking
   *  it runs `run` and leaves the toast open. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

let nextId = 1;
const DISPLAY_MS = 5000;
const ERROR_DISPLAY_MS = 8000;

const [toasts, setToasts] = createSignal<Toast[]>([]);

export { toasts };

export interface ShowToastOptions {
  /**
   * Don't dismiss automatically, for "in progress" toasts that stay until the
   * caller calls `dismissToast(id)`, usually replacing it with a result toast.
   */
  persistent?: boolean;
  /**
   * A Cancel action: the toast shows an X button that calls this and dismisses
   * it. For toasts about cancellable work; a toast without `onCancel` can't
   * stop its job, so it shouldn't offer to.
   */
  onCancel?: () => void;
  /** Add a button to the toast body; see `Toast.action`. */
  action?: ToastAction;
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
      action: options?.action,
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
