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

/** Options for a styled yes/no confirmation modal (the in-app replacement for
 *  the OS `ask()` dialog, so confirms match the rest of InkyCap's chrome). */
export interface ConfirmOptions {
  /** Heading text shown in the modal header. */
  title: string;
  /** Body text. Newlines are preserved (rendered with `white-space: pre-wrap`),
   *  so a bulleted list reads as written. */
  message: string;
  /** Confirm button label. Defaults to "OK". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Optional secondary opt-in checkbox shown above the buttons (e.g. a
   *  destructive extra like "also delete the version history"). Its state is
   *  returned by [`promptConfirmWithCheckbox`]; plain [`promptConfirm`] ignores
   *  it. Defaults to unchecked unless `initial` is set. */
  checkbox?: { label: string; initial?: boolean };
}

/** The outcome of a confirm that carried a [`ConfirmOptions.checkbox`]. */
export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (result: ConfirmResult) => void;
}

const [activeConfirm, setActiveConfirm] = createSignal<ConfirmState | null>(null);

export { activeConfirm };

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

/**
 * Open the confirmation modal. Resolves `true` if the user confirmed, `false`
 * if they cancelled (Esc, backdrop click, or Cancel). Styled like the rest of
 * the app rather than the OS dialog. If a confirm is already open, the previous
 * one is cancelled (`false`) before the new one opens.
 */
export function promptConfirm(opts: ConfirmOptions): Promise<boolean> {
  return promptConfirmWithCheckbox(opts).then((r) => r.confirmed);
}

/**
 * Like [`promptConfirm`], but also reports the state of the optional
 * [`ConfirmOptions.checkbox`]. `checked` is meaningless (always its initial
 * value) when the user cancels, and when no checkbox was configured.
 */
export function promptConfirmWithCheckbox(opts: ConfirmOptions): Promise<ConfirmResult> {
  const existing = activeConfirm();
  if (existing) existing.resolve({ confirmed: false, checked: false });
  return new Promise<ConfirmResult>((resolve) => {
    setActiveConfirm({ ...opts, resolve });
  });
}

/** Internal: used by PromptHost to settle the active confirm. */
export function resolveConfirm(ok: boolean, checked = false) {
  const cur = activeConfirm();
  if (!cur) return;
  setActiveConfirm(null);
  cur.resolve({ confirmed: ok, checked });
}

/** One selectable action in a [`promptChoice`] modal. */
export interface ChoiceOption {
  /** Stable id returned when this option is chosen. */
  id: string;
  /** Button label (already localized by the caller). */
  label: string;
  /** Button styling. Defaults to `secondary`. */
  variant?: "primary" | "secondary" | "danger";
}

/** A multi-action chooser modal: a title, a message, and 2+ action buttons,
 *  plus an always-present close affordance (the header ✕, Esc, and backdrop
 *  click) that cancels. Use when a yes/no confirm isn't enough — e.g. "Convert
 *  to Typst?" / "Keep as Markdown" / cancel. */
export interface ChoiceOptions {
  /** Heading text shown in the modal header. */
  title: string;
  /** Body text. Newlines preserved (`white-space: pre-wrap`). */
  message: string;
  /** The action buttons, rendered left-to-right. */
  options: ChoiceOption[];
}

interface ChoiceState extends ChoiceOptions {
  resolve: (id: string | null) => void;
}

const [activeChoice, setActiveChoice] = createSignal<ChoiceState | null>(null);

export { activeChoice };

/**
 * Open the chooser modal. Resolves with the chosen option's `id`, or `null` if
 * the user cancelled (the header ✕, Esc, or a backdrop click). If a chooser is
 * already open, the previous one is cancelled (`null`) before the new one opens.
 */
export function promptChoice(opts: ChoiceOptions): Promise<string | null> {
  const existing = activeChoice();
  if (existing) existing.resolve(null);
  return new Promise<string | null>((resolve) => {
    setActiveChoice({ ...opts, resolve });
  });
}

/** Internal: used by PromptHost to settle the active chooser. */
export function resolveChoice(id: string | null) {
  const cur = activeChoice();
  if (!cur) return;
  setActiveChoice(null);
  cur.resolve(id);
}
