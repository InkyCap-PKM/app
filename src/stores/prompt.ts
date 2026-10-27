// In-app text prompt, used instead of window.prompt(), which in WebKitGTK shows
// an unstyled native dialog. Like stores/toasts.ts: a module-level signal holds
// the active prompt, PromptHost renders it, and `promptText()` returns a
// Promise (`const name = await promptText(...)`).
//
// Use this for any text prompt; don't use window.prompt.

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
   * Optional validator run on each submit. Return a message to block submission
   * and show it as an error, or null to allow it.
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
  /** Styles the confirm button as destructive (red). Set it for anything that
   *  deletes or removes, so every such confirm looks the same. */
  danger?: boolean;
  /**
   * Optional checkbox above the buttons for an extra choice (e.g. "also delete
   * the version history"). Its state is returned by
   * [`promptConfirmWithCheckbox`]; [`promptConfirm`] ignores it. Unchecked
   * unless `initial` is set.
   */
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
 * Open the prompt. Resolves with the trimmed text, or null if cancelled (Esc,
 * backdrop click, Cancel). An open prompt is cancelled (null) first.
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
 * Open the confirmation dialog. Resolves `true` if confirmed, `false` if
 * cancelled (Esc, backdrop click, Cancel). An open confirm is cancelled
 * (`false`) first.
 */
export function promptConfirm(opts: ConfirmOptions): Promise<boolean> {
  return promptConfirmWithCheckbox(opts).then((r) => r.confirmed);
}

/**
 * Like [`promptConfirm`], but also returns the state of
 * [`ConfirmOptions.checkbox`]. `checked` keeps its initial value when cancelled
 * or when there is no checkbox.
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

/**
 * A chooser with a title, a message and two or more action buttons; closing it
 * (✕, Esc, backdrop click) cancels. For choices beyond yes/no, e.g. "Convert to
 * Typst?" / "Keep as Markdown" / cancel.
 */
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
 * Open the chooser. Resolves with the chosen option's `id`, or `null` if
 * cancelled (✕, Esc, backdrop click). An open chooser is cancelled (`null`)
 * first.
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
