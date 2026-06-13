// Localizing the errors that cross the Tauri IPC boundary.
//
// The Rust backend serializes every `InkyCapError` as a structured envelope
// (see src-tauri/src/errors.rs):
//
//     { code: "file-not-found", message: "File not found: /x", detail: "/x" }
//
// `code` is a stable, never-localized machine identifier; `detail` is the single
// interpolated value (a path, an external tool's message, a free-form sentence);
// `message` is the composed English string the backend already had.
//
// `errorText` turns that envelope into a user-facing string in the active locale
// by looking up `errors.<code>` and filling its `{detail}` placeholder, falling
// back to the backend's English `message` when no key exists yet (a new variant,
// or free-form `BadRequest` text that has no fixed translation). It also accepts
// plain JS errors and strings, so it is the one safe stringifier for ANY caught
// value at a display site — replacing scattered `String(err)` calls, which would
// now render the envelope object as "[object Object]".
//
// `errorCode` exposes the machine code for control flow (e.g. treating a
// user-driven `"cancelled"` as a non-error) without matching on a localized
// message.

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
 * The backend machine code for a caught value, or `undefined` if it isn't an
 * IPC error. Use to branch on error kind without matching localized text —
 * e.g. `if (errorCode(e) === "cancelled") { …suppress… }`.
 */
export function errorCode(value: unknown): string | undefined {
  return isIpcError(value) ? value.code : undefined;
}

/**
 * The backend's `detail` value for a caught IPC error (a path, a name, a
 * tool message), or `undefined` if absent or the value isn't an IPC error.
 * Use to read structured data a variant carries — e.g. the existing note's
 * path on a `note-name-conflict` — without parsing the localized message.
 */
export function errorDetail(value: unknown): string | undefined {
  return isIpcError(value) ? (value.detail ?? undefined) : undefined;
}

/**
 * A user-facing, localized string for any caught value. For backend IPC errors
 * it resolves `errors.<code>` in the active locale (filling `{detail}`), falling
 * back to the backend's English `message` when the key is absent. For plain JS
 * errors it returns `.message`; otherwise `String(value)`. Safe at every display
 * site — toasts, inline error fields, status messages.
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
