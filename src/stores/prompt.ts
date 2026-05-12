// In-app text-input prompt. Replaces window.prompt() across the codebase,
// which renders as the WebView's native "JavaScript - http://..." dialog
// in WebKitGTK and bypasses InkyCap's styling.
//
// Pattern mirrors stores/toasts.ts: a module-level signal holds the active
// prompt, a single PromptHost component subscribes to it, and the imperative
// `promptText()` function returns a Promise so existing callers that used
// `const name = prompt(...)` migrate to `const name = await promptText(...)`
// with minimal restructuring.
//
// New code that needs a text prompt MUST use this rather than window.prompt
// — there is no other styled equivalent, and reaching for the native one
// breaks visual continuity with the rest of the app.

import { createSignal } from "solid-js";

export interface PromptOptions {
  /** Heading text shown in the modal header. */
  title: string;
  /** Optional inline label above the input. */
  label?: string;
  /** Value pre-filled into the input on open (also selected for quick replace). */
  initialValue?: string;
  /** Placeholder shown when the input is empty. */
  placeholder?: string;
  /** Optional help text shown beneath the input. */
  hint?: string;
  /** Confirm button label. Defaults to "OK". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Optional validator run on every submit attempt. Return a non-empty
   * string to block submission and display the message as an error;
   * return null to allow the submit to resolve.
   */
  validate?: (value: string) => string | null;
}

interface PromptState extends PromptOptions {
  resolve: (value: string | null) => void;
}

const [activePrompt, setActivePrompt] = createSignal<PromptState | null>(null);

export { activePrompt };

/**
 * Open the prompt modal. Resolves with the trimmed string the user entered,
 * or null if they cancelled (Esc, backdrop click, or Cancel button).
 * If a prompt is already open, the previous one is cancelled (resolved with
 * null) before the new one opens.
 */
export function promptText(opts: PromptOptions): Promise<string | null> {
  const existing = activePrompt();
  if (existing) existing.resolve(null);
  return new Promise<string | null>((resolve) => {
    setActivePrompt({ ...opts, resolve });
  });
}

/** Internal: used by PromptHost to settle the active prompt. */
export function resolvePrompt(value: string | null) {
  const cur = activePrompt();
  if (!cur) return;
  setActivePrompt(null);
  cur.resolve(value);
}
