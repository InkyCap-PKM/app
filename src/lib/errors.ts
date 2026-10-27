// Showing errors from the backend in the user's language.
//
// Every `InkyCapError` arrives as (see src-tauri/src/errors.rs):
//
//     { code: "file-not-found", message: "File not found: /x", detail: "/x" }
//
// `code` is a fixed, untranslated identifier; `detail` the variable part (a
// path, a tool's message, a sentence); `message` the backend's English text.
//
// `errorText` looks up `errors.<code>` and fills `{detail}`, falling back to
// `message` without a key (a new variant, or free-form `BadRequest` text). It
// also takes JS errors and strings, so use it for any caught value shown to the
// user instead of `String(err)`, which gives "[object Object]". `errorCode`
// gives the code for branching (e.g. `"cancelled"` isn't an error) without
// matching translated text.

import { t } from "./i18n";

/** The shape the Rust backend serializes `InkyCapError` into. */
export interface IpcError {
  /** Stable machine code, e.g. "notebox-not-open". Indexes `errors.<code>`. */
  code: string;
  /** Composed English message — the localization fallback. */
  message: string;
  /** The interpolated `{detail}` value, or null for fully-static variants. */
  detail: string | null;
}

/** True when `value` is a backend IPC error envelope (not a JS error/string). */
function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IpcError).code === "string" &&
    typeof (value as IpcError).message === "string"
  );
}

/**
 * The backend code for a caught value, or `undefined` if it isn't an IPC error,
 * e.g. `if (errorCode(e) === "cancelled") …`.
 */
export function errorCode(value: unknown): string | undefined {
  return isIpcError(value) ? value.code : undefined;
}

/**
 * The backend `detail` of a caught IPC error (a path, a name, a tool message),
 * or `undefined`, e.g. the existing note's path on `note-name-conflict`.
 */
export function errorDetail(value: unknown): string | undefined {
  return isIpcError(value) ? (value.detail ?? undefined) : undefined;
}

/**
 * A translated, user-facing string for any caught value: for IPC errors
 * `errors.<code>` with `{detail}` filled, else the English `message`; for JS
 * errors `.message`; otherwise `String(value)`. Safe in toasts, error fields and
 * status messages.
 */
export function errorText(value: unknown): string {
  if (isIpcError(value)) {
    const key = `errors.${value.code}`;
    const params = value.detail != null ? { detail: value.detail } : undefined;
    const translated = t(key, params);
    // `t` returns the key itself on a miss — fall back to the English message
    // the backend already composed (it has the detail interpolated in).
    return translated === key ? value.message : translated;
  }
  if (value instanceof Error) return value.message;
  return value == null ? "" : String(value);
}
