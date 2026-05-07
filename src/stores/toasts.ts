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

export function showToast(level: ToastLevel, message: string, detail?: string) {
  const id = nextId++;
  setToasts((prev) => [...prev, { id, level, message, detail }]);
  const ms = level === "error" ? ERROR_DISPLAY_MS : DISPLAY_MS;
  setTimeout(() => dismissToast(id), ms);
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
