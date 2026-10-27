// The pill chip and its menu for the visual editor. Every pill uses the same
// chip, hover and focus states and keyboard access, and opens the same menu on
// left-click, right-click and Enter/Space. See
// documentation/developer/visual-editor/pill-system.md.

import { type EditorView, WidgetType } from "@codemirror/view";
import { expandFunc } from "./effects";
import { setTabEditingMode, getActiveTab } from "../../stores/tabs";
import { t } from "../../lib/i18n";

// ── Menu model ──────────────────────────────────────────────────────

/** A single section in the super-menu. Sections are separated by a rule;
 *  empty sections are dropped before render. */
export interface PillMenuSection {
  /** Optional heading text shown above the section's items. */
  heading?: string;
  items: PillMenuItem[];
}

export interface PillMenuItem {
  label: string;
  /** Optional checkmark / radio indicator. */
  isActive?: boolean;
  /** Optional tooltip. */
  title?: string;
  /**
   * Longer help text, shown inline in the menu through a "?" next to the label.
   */
  help?: string;
  /** Disable this item (renders dimmed, not clickable). */
  disabled?: boolean;
  /** Called on click; the menu closes after the handler returns unless
   *  `keepOpen` is true. */
  onSelect?: () => void;
  /** When true, clicking does not close the menu (e.g. for live-edit
   *  fields like color swatches that should let the user try several). */
  keepOpen?: boolean;
  /**
   * Show the item as an input instead of a button. `onSelect` is ignored;
   * `input.onCommit` runs on Enter or blur, and the menu closes.
   */
  input?: {
    /** Current value to populate the field with. A colour field takes a
     *  `#rrggbb` string. */
    value: string;
    /** `"color"` renders the browser's colour picker and commits when the
     *  user settles on a colour. Defaults to a plain text field. */
    type?: "text" | "color";
    /** Optional placeholder when empty. Text fields only. */
    placeholder?: string;
    /** Called on Enter or blur with the field's text. */
    onCommit: (value: string) => void;
  };
}

/** What `openPillMenu` needs to know about the call this pill represents. */
export interface PillModel {
  /** Function name (for menu heading). */
  funcName: string;
  /** Document offset of the start of the `#` in the source. */
  callFrom: number;
  /** Document offset of the end of the call (exclusive). */
  callTo: number;
  /** Per-pill widget options sections (Section 1 in the menu). */
  optionSections?: PillMenuSection[];
  /**
   * Replaces the "Edit source" action (default: `expandFunc` at `callFrom`),
   * for embedded pills (verse, bibliography).
   */
  onEditSource?: (view: EditorView) => void;
  /** When false, suppress the "Edit source" item even for simple calls
   *  (e.g. embedded pills where the widget's canvas IS the editor). */
  allowEditSource?: boolean;
  /**
   * When true, left-click always reveals the source, whatever the call's
   * complexity. For callout and quote, whose body is the content. Right-click
   * still opens the menu.
   */
  alwaysExpandOnClick?: boolean;
}

/** A stretch of the note's source, as document offsets (`to` exclusive). */
export interface SourceRange {
  from: number;
  to: number;
}

/** The source each pill that hides text stands in for. See `hides` on
 *  {@link buildPillButton}. */
const hiddenRanges = new WeakMap<HTMLElement, () => SourceRange>();

/** The source a pill element stands in for, or null when the pill hides no
 *  text (a pill beside visible content, such as `#quote`'s). */
export function pillHiddenRange(el: HTMLElement): SourceRange | null {
  return hiddenRanges.get(el)?.() ?? null;
}

// ── PillChip widget ─────────────────────────────────────────────────

/**
 * Build the pill DOM: a `<button>` with a circled hash and a label. Every pill
 * must use this, so they all look and behave the same.
 */
export function buildPillButton(
  funcName: string,
  view: EditorView,
  modelFor: () => PillModel,
  /**
   * Overrides for pills that aren't one named call, such as the style preamble
   * chip with its own label and rule count.
   */
  opts?: {
    label?: string;
    title?: string;
    accessory?: Node;
    /**
     * For a pill that stands in for its source (an annotation, a comment, a
     * `#set` rule): that source, so a search match hidden there can be shown on
     * the pill (see hidden-match-pills.ts).
     */
    hides?: () => SourceRange;
  },
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cm-typst-pill";
  btn.title = opts?.title ?? funcName;
  btn.setAttribute("aria-label", `${opts?.label ?? funcName} — open options`);

  const hash = document.createElement("span");
  hash.className = "cm-typst-pill-hash";
  btn.appendChild(hash);

  const label = document.createElement("span");
  label.className = "cm-typst-pill-label";
  label.textContent = opts?.label ?? funcName;
  btn.appendChild(label);

  if (opts?.accessory) btn.appendChild(opts.accessory);
  if (opts?.hides) hiddenRanges.set(btn, opts.hides);

  // Keep mousedown from moving the selection or starting a drag. The action
  // runs on click, so focus lands on the pill and Enter repeats it.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  // Open our menu on contextmenu instead of the native one.
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPillMenu(btn, view, modelFor());
  });
  // Click:
  //   - simple pill: edit its source inline
  //   - complex pill: open the menu
  //   - embedded pill (allowEditSource false, e.g. verse, bibliography): open
  //     the menu
  // Right-click always opens the menu.
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const model = modelFor();
    const allowEdit = model.allowEditSource !== false;
    const expand = allowEdit && (
      model.alwaysExpandOnClick === true
      || isSimpleCall(view, model.callFrom, model.callTo)
    );
    if (expand) {
      runEditSource(view, model);
    } else {
      openPillMenu(btn, view, model);
    }
  });
  // Enter / Space already click a <button>, so keyboard access comes from
  // using the right element.

  return btn;
}

/**
 * An inline pill that fires `expandFunc` with no options of its own. Pills with
 * options use `buildPillButton` with a `modelFor` returning `optionSections`.
 */
export class PillChip extends WidgetType {
  constructor(
    readonly pos: number,
    readonly funcName: string,
    /**
     * End offset of the call. If unknown, pass `pos + 1`; Copy, Duplicate and
     * Delete then find the end themselves.
     */
    readonly callTo: number = -1,
  ) {
    super();
  }

  eq(other: PillChip): boolean {
    return this.pos === other.pos
      && this.funcName === other.funcName
      && this.callTo === other.callTo;
  }

  toDOM(view: EditorView): HTMLElement {
    return buildPillButton(this.funcName, view, () => ({
      funcName: this.funcName,
      callFrom: this.pos,
      callTo: this.callTo >= 0 ? this.callTo : findCallEnd(view, this.pos),
    }));
  }

  ignoreEvent(): boolean { return true; }
}

// ── openPillMenu: the pill's context menu ──────────────────────────

/**
 * Show the pill menu at `anchor`, in three sections:
 *   1. the pill's own options (model.optionSections)
 *   2. Edit source / Open in source editor
 *   3. Copy / Duplicate / Delete
 * Closes on outside click, Escape, or after an item runs (unless keepOpen).
 */
export function openPillMenu(
  anchor: HTMLElement,
  view: EditorView,
  model: PillModel,
): void {
  // Close any existing pill menu first — clicking another pill should
  // move the menu, not stack two.
  document.querySelectorAll(".cm-typst-pill-menu").forEach((m) => m.remove());

  const menu = document.createElement("div");
  menu.className = "cm-typst-pill-menu";
  menu.setAttribute("role", "menu");

  const sections: PillMenuSection[] = [];
  if (model.optionSections && model.optionSections.length > 0) {
    sections.push(...model.optionSections);
  }
  sections.push(buildSourceSection(view, model));
  sections.push(buildUniversalSection(view, model));

  let first = true;
  for (const section of sections) {
    if (section.items.length === 0) continue;
    if (!first) {
      const sep = document.createElement("div");
      sep.className = "cm-typst-pill-menu-sep";
      menu.appendChild(sep);
    }
    first = false;
    if (section.heading) {
      const h = document.createElement("div");
      h.className = "cm-typst-pill-menu-heading";
      h.textContent = section.heading;
      menu.appendChild(h);
    }
    for (const item of section.items) {
      menu.appendChild(buildMenuItem(item, () => closeMenu()));
    }
  }

  // Position fixed under the anchor; reuse the verse popover's pattern.
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  view.dom.appendChild(menu);

  // Clamp to viewport — if the menu would clip the right edge, slide it
  // back left; same for bottom.
  requestAnimationFrame(() => {
    const m = menu.getBoundingClientRect();
    if (m.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - 8 - m.width)}px`;
    }
    if (m.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, rect.top - 4 - m.height)}px`;
    }
  });

  const closeMenu = () => {
    menu.remove();
    document.removeEventListener("mousedown", onDocMouse, true);
    document.removeEventListener("keydown", onDocKey, true);
  };
  const onDocMouse = (e: MouseEvent) => {
    if (menu.contains(e.target as Node)) return;
    closeMenu();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      anchor.focus();
    }
  };
  document.addEventListener("mousedown", onDocMouse, true);
  document.addEventListener("keydown", onDocKey, true);

  // Focus the first input, or else the first item, so keyboard users can act at
  // once.
  const firstInput = menu.querySelector<HTMLInputElement>(".cm-typst-pill-menu-input");
  if (firstInput) {
    firstInput.focus();
    firstInput.select();
  } else {
    const firstItem = menu.querySelector<HTMLElement>(".cm-typst-pill-menu-item:not(.is-disabled)");
    firstItem?.focus();
  }
}

function buildMenuItem(item: PillMenuItem, close: () => void): HTMLElement {
  if (item.input) {
    return buildInputItem(item, close);
  }
  const el = document.createElement("button");
  el.type = "button";
  el.className = "cm-typst-pill-menu-item";
  if (item.isActive) el.classList.add("is-active");
  if (item.disabled) el.classList.add("is-disabled");
  el.setAttribute("role", "menuitem");
  if (item.title) el.title = item.title;
  if (item.disabled) el.setAttribute("aria-disabled", "true");

  const label = document.createElement("span");
  label.className = "cm-typst-pill-menu-label";
  label.textContent = item.label;
  el.appendChild(label);

  // The checkmark goes on the right so labels stay aligned.
  if (item.isActive) {
    const check = document.createElement("span");
    check.className = "cm-typst-pill-menu-check";
    check.textContent = "✓";
    el.appendChild(check);
  }

  if (!item.disabled && item.onSelect) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.onSelect!();
      if (!item.keepOpen) close();
    });
  }
  return el;
}

function buildInputItem(item: PillMenuItem, close: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-typst-pill-menu-item cm-typst-pill-menu-input-row";
  if (item.title) wrap.title = item.title;

  const label = document.createElement("label");
  label.className = "cm-typst-pill-menu-input-label";
  label.textContent = item.label;
  wrap.appendChild(label);

  // Optional help: a "?" next to the label shows the text on its own line.
  // Inside the menu, so outside-click closing ignores it.
  let helpBlock: HTMLElement | null = null;
  if (item.help) {
    const helpWrap = document.createElement("span");
    helpWrap.className = "help-button";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "help-button__trigger";
    trigger.setAttribute("aria-label", `Help: ${item.label}`);
    trigger.innerHTML = // static-only: lucide circle-help glyph
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
    helpWrap.appendChild(trigger);
    wrap.appendChild(helpWrap);

    helpBlock = document.createElement("div");
    helpBlock.className = "cm-typst-pill-menu-help";
    helpBlock.textContent = item.help;
    helpBlock.style.display = "none";

    trigger.addEventListener("mousedown", (e) => e.stopPropagation());
    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const showing = helpBlock!.style.display !== "none";
      helpBlock!.style.display = showing ? "none" : "block";
      trigger.classList.toggle("is-open", !showing);
    });
  }

  const isColor = item.input!.type === "color";
  const input = document.createElement("input");
  input.type = isColor ? "color" : "text";
  input.className = isColor
    ? "cm-typst-pill-menu-input cm-typst-pill-menu-input--color"
    : "cm-typst-pill-menu-input";
  input.value = item.input!.value;
  if (item.input!.placeholder && !isColor) input.placeholder = item.input!.placeholder;
  label.htmlFor = `cm-typst-pill-menu-input-${Math.random().toString(36).slice(2, 8)}`;
  input.id = label.htmlFor;
  wrap.appendChild(input);

  // Stop propagation so keystrokes don't reach the menu's Escape handler
  // until the user actually presses Escape (handled below).
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      item.input!.onCommit(input.value);
      close();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  // Commit on blur as well so users who tab/click away don't lose
  // their edit. Skip if the value didn't change.
  let initial = item.input!.value;
  input.addEventListener("blur", () => {
    if (input.value !== initial) {
      initial = input.value;
      item.input!.onCommit(input.value);
    }
  });
  // A colour picker doesn't blur while in use; commit on `change` and keep the
  // menu open to try other colours.
  if (isColor) {
    input.addEventListener("change", () => {
      if (input.value === initial) return;
      initial = input.value;
      item.input!.onCommit(input.value);
    });
  }

  // Help text comes last so `flex-wrap` drops it onto its own full-width line
  // below the label + input.
  if (helpBlock) wrap.appendChild(helpBlock);

  return wrap;
}

// ── Source section (R8: simple vs complex) ──────────────────────────

/**
 * The "Edit source" action, shared by the menu item and the simple-pill click.
 */
export function runEditSource(view: EditorView, model: PillModel): void {
  // Keep a selection inside the hidden source (Find's current match) where it
  // is, so the match stays highlighted.
  const sel = view.state.selection.main;
  const held = !sel.empty && sel.from >= model.callFrom && sel.to <= model.callTo
    ? { anchor: sel.anchor, head: sel.head }
    : null;
  if (model.onEditSource) {
    model.onEditSource(view);
  } else {
    view.dispatch({
      effects: expandFunc.of(model.callFrom),
      selection: { anchor: model.callFrom + 1 },
    });
    view.focus();
  }
  if (held) view.dispatch({ selection: held, scrollIntoView: true });
}

function buildSourceSection(view: EditorView, model: PillModel): PillMenuSection {
  const items: PillMenuItem[] = [];
  const allowEdit = model.allowEditSource !== false;
  if (allowEdit) {
    // Offer "Edit source" for simple calls, or when the pill always expands
    // (callout, quote).
    const expandable = model.alwaysExpandOnClick === true
      || isSimpleCall(view, model.callFrom, model.callTo);
    if (expandable) {
      items.push({
        label: t("pill.editSource"),
        title: t("pill.editSource.title"),
        onSelect: () => runEditSource(view, model),
      });
    }
  }
  const tab = getActiveTab();
  const isSource = tab?.editingMode === "source";
  if (isSource) {
    items.push({
      label: t("pill.openInVisualEditor"),
      title: t("pill.openInVisualEditor.title"),
      onSelect: () => {
        if (tab) setTabEditingMode(tab.id, "live");
      },
    });
  } else {
    items.push({
      label: t("pill.openInSourceEditor"),
      title: t("pill.openInSourceEditor.title"),
      onSelect: () => {
        if (tab) setTabEditingMode(tab.id, "source");
        requestAnimationFrame(() => {
          try {
            view.dispatch({
              selection: { anchor: model.callFrom, head: model.callTo },
              scrollIntoView: true,
            });
          } catch {
            // The view may have been replaced; fall through silently.
          }
        });
      },
    });
  }
  return { items };
}

// ── Universal section (Copy / Duplicate / Delete) ───────────────────

function buildUniversalSection(view: EditorView, model: PillModel): PillMenuSection {
  const len = view.state.doc.length;
  const safeFrom = Math.max(0, Math.min(model.callFrom, len));
  const safeTo = Math.max(safeFrom, Math.min(model.callTo, len));
  const callSource = view.state.doc.sliceString(safeFrom, safeTo);

  return {
    items: [
      {
        label: t("common.copy"),
        title: t("pill.copy.title"),
        onSelect: () => {
          void navigator.clipboard.writeText(callSource).catch((err) => {
            console.error("Pill copy failed:", err);
          });
        },
      },
      {
        label: t("pill.duplicate"),
        title: t("pill.duplicate.title"),
        onSelect: () => {
          // Block calls (their own line) duplicate on a new line; inline
          // calls duplicate inline with a separating space.
          const lineAt = view.state.doc.lineAt(safeFrom);
          const isWholeLine = lineAt.from === safeFrom && lineAt.to === safeTo;
          const insertText = isWholeLine ? "\n" + callSource : " " + callSource;
          const insertAt = isWholeLine ? lineAt.to : safeTo;
          view.dispatch({
            changes: { from: insertAt, to: insertAt, insert: insertText },
            selection: { anchor: insertAt + insertText.length },
            scrollIntoView: true,
          });
          view.focus();
        },
      },
      ...buildUnwrapItem(view, callSource, safeFrom, safeTo),
      {
        label: t("common.delete"),
        title: t("pill.delete.title"),
        onSelect: () => {
          // If the call occupies its own line, also drop the trailing
          // newline so we don't leave a blank line behind.
          const lineAt = view.state.doc.lineAt(safeFrom);
          let from = safeFrom;
          let to = safeTo;
          if (lineAt.from === safeFrom && lineAt.to === safeTo) {
            // Eat the trailing newline if there is one.
            if (to < len) to += 1;
            else if (from > 0) from -= 1; // last line — eat the leading newline instead
          }
          view.dispatch({
            changes: { from, to, insert: "" },
            selection: { anchor: from },
            scrollIntoView: true,
          });
          view.focus();
        },
      },
    ],
  };
}

/** Extract the content from inside `[...]` brackets at the end of a call.
 *  Returns the inner text, or null if the call has no content brackets. */
function extractContentBracket(callSource: string): string | null {
  // Walk backwards from the end to find the matching `[`.
  if (!callSource.endsWith("]")) return null;
  let depth = 0;
  for (let i = callSource.length - 1; i >= 0; i--) {
    const ch = callSource[i];
    if (ch === "]") depth++;
    else if (ch === "[") {
      depth--;
      if (depth === 0) return callSource.slice(i + 1, callSource.length - 1);
    }
  }
  return null;
}

function buildUnwrapItem(
  view: EditorView,
  callSource: string,
  from: number,
  to: number,
): PillMenuItem[] {
  const content = extractContentBracket(callSource);
  if (content === null) return [];
  return [{
    label: t("pill.removeStyle"),
    title: t("pill.removeStyle.title"),
    onSelect: () => {
      view.dispatch({
        changes: { from, to, insert: content },
        selection: { anchor: from, head: from + content.length },
        scrollIntoView: true,
      });
      view.focus();
    },
  }];
}

// ── Simple/complex classifier (R8) ──────────────────────────────────

/**
 * A call is simple (and can be edited inline) when it fits on one line, is at
 * most 120 characters, and nests at most one call. Otherwise "Open in source
 * editor" is offered.
 */
export function isSimpleCall(view: EditorView, from: number, to: number): boolean {
  if (to <= from) return true;
  const len = view.state.doc.length;
  const safeFrom = Math.max(0, Math.min(from, len));
  const safeTo = Math.max(safeFrom, Math.min(to, len));
  const text = view.state.doc.sliceString(safeFrom, safeTo);
  if (text.length > 120) return false;
  if (text.includes("\n")) return false;
  // Count `#` occurrences after the leading one — each is a nested call.
  // (#strike[#emph[x]] would have two; #image("a") would have one.)
  let nestedHashes = 0;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "#") nestedHashes++;
    if (nestedHashes > 1) return false;
  }
  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * End offset of the call starting at `pos` (a `#`): walks forward balancing
 * parens and brackets, skipping strings, and returns the offset after the last
 * delimiter, or `pos + 1` if there is none. A fallback for callers that don't
 * pass `callTo`.
 */
export function findCallEnd(viewOrState: EditorView | { doc: { length: number; sliceString: (a: number, b: number) => string } }, pos: number): number {
  // Accept either an EditorView (most call sites) or a plain { doc }
  // so a StateField update fn can call this without smuggling a view in.
  const doc = "state" in viewOrState ? viewOrState.state.doc : viewOrState.doc;
  const docLen = doc.length;
  if (pos >= docLen) return pos;
  const slice = doc.sliceString(pos, Math.min(pos + 4096, docLen));
  // Skip the function name (alphanumeric + dashes after the leading `#`).
  let i = 1;
  while (i < slice.length) {
    const c = slice[i];
    if (/[A-Za-z0-9_\-.]/.test(c)) i++;
    else break;
  }
  // Optional argument list `(...)` followed by optional `[...]`.
  i = consumeBalanced(slice, i, "(", ")");
  i = consumeBalanced(slice, i, "[", "]");
  return Math.min(pos + i, docLen);
}

// ── Named-argument upsert ────────────────────────────────────────────
//
// Edits one named argument in a call's source, for every pill option (image
// alt, quote attribution, callout kind, highlight colour, …). Only that
// argument changes (it is removed when set to the function's default), so
// whitespace and other arguments stay byte for byte.

/**
 * The opening and closing paren offsets (inclusive) of the call's argument
 * list, or null without one (e.g. `#highlight[…]`).
 */
export function findArgList(callSource: string): { open: number; close: number } | null {
  const open = callSource.indexOf("(");
  if (open < 0) return null;
  // Reject if a `[` appears before the `(` — that's a content-bracket-only
  // call (no arg list), e.g. `#strong[bold]`.
  const firstBracket = callSource.indexOf("[");
  if (firstBracket >= 0 && firstBracket < open) return null;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < callSource.length; i++) {
    const ch = callSource[i];
    if (ch === '"' && callSource[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/**
 * A named argument `name: <value>` in an argument string, or `null`. `from..to`
 * is the value (up to the next top-level `,` or the end); `keyFrom` is where
 * the name starts.
 */
export function findNamedArgValue(
  argsText: string,
  name: string,
): { keyFrom: number; from: number; to: number } | null {
  const re = new RegExp(`(^|,)\\s*(${name}\\s*:\\s*)`, "g");
  const m = re.exec(argsText);
  if (!m) return null;
  const keyFrom = m.index + m[0].length - m[2].length;
  const valueStart = m.index + m[0].length;
  // Walk forward until top-level `,` or end of string.
  let depth = 0;
  let inStr = false;
  for (let i = valueStart; i < argsText.length; i++) {
    const ch = argsText[i];
    if (ch === '"' && argsText[i - 1] !== "\\") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      return { keyFrom, from: valueStart, to: i };
    }
  }
  return { keyFrom, from: valueStart, to: argsText.length };
}

export interface UpsertOptions {
  /** When the new value equals this string literal, drop the arg entirely
   *  (keeps source clean — analogous to VerseWidget dropping `align-to: left`). */
  defaultValue?: string;
}

/**
 * Set one named argument in a call's source and return the result: replace its
 * value if present, otherwise add `name: value` at the end (creating the
 * argument list if needed).
 */
export function upsertNamedArg(
  callSource: string,
  name: string,
  valueLiteral: string | null,
  opts: UpsertOptions = {},
): string {
  const argList = findArgList(callSource);
  // Drop case: value === default OR value === null (remove arg).
  const shouldDrop = valueLiteral === null
    || (opts.defaultValue !== undefined && valueLiteral === opts.defaultValue);

  if (!argList) {
    if (shouldDrop) return callSource;
    // No `(...)`. Insert one before the first `[` if present, else
    // append at the end of the call source.
    if (valueLiteral === null) return callSource;
    const insertAt = (() => {
      const b = callSource.indexOf("[");
      return b >= 0 ? b : callSource.length;
    })();
    return callSource.slice(0, insertAt) + `(${name}: ${valueLiteral})` + callSource.slice(insertAt);
  }

  const argsText = callSource.substring(argList.open + 1, argList.close);
  const existing = findNamedArgValue(argsText, name);

  let newArgs: string;
  if (existing) {
    if (shouldDrop) {
      // Remove the whole `name: value` and one comma beside it.
      // `findNamedArgValue` handles nesting and strings, so a value with commas
      // (`rgb(255, 145, 0)`) is removed whole.
      let cutFrom = existing.keyFrom;
      let cutTo = existing.to;
      // Eat the space after the comma too, so the argument that follows keeps
      // exactly the one separator the source already had.
      const following = argsText.slice(cutTo).match(/^\s*,\s*/);
      if (following) {
        cutTo += following[0].length;
      } else {
        const preceding = argsText.slice(0, cutFrom).match(/,\s*$/);
        if (preceding) cutFrom -= preceding[0].length;
      }
      newArgs = (argsText.slice(0, cutFrom) + argsText.slice(cutTo)).trim();
    } else {
      newArgs = argsText.substring(0, existing.from) + valueLiteral + argsText.substring(existing.to);
    }
  } else {
    if (shouldDrop) return callSource;
    const trimmed = argsText.replace(/\s+$/, "");
    newArgs = trimmed.length === 0
      ? `${name}: ${valueLiteral}`
      : `${trimmed}, ${name}: ${valueLiteral}`;
  }

  return callSource.substring(0, argList.open + 1) + newArgs + callSource.substring(argList.close);
}

/** Read a named arg's value text (literal source), or null if not present. */
export function readNamedArg(callSource: string, name: string): string | null {
  const argList = findArgList(callSource);
  if (!argList) return null;
  const argsText = callSource.substring(argList.open + 1, argList.close);
  const range = findNamedArgValue(argsText, name);
  if (!range) return null;
  return argsText.substring(range.from, range.to).trim();
}

/**
 * The first positional string argument without quotes (e.g. callout kind, image
 * path), or null.
 */
export function readFirstPositionalString(callSource: string): string | null {
  const argList = findArgList(callSource);
  if (!argList) return null;
  const argsText = callSource.substring(argList.open + 1, argList.close);
  const m = argsText.match(/^\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

/** Replace the first positional string argument's content. Used for
 *  callout kind. Preserves all other arguments byte-for-byte. */
export function replaceFirstPositionalString(callSource: string, newValue: string): string {
  const argList = findArgList(callSource);
  if (!argList) return callSource;
  const argsText = callSource.substring(argList.open + 1, argList.close);
  const m = argsText.match(/^(\s*")((?:[^"\\]|\\.)*)(")/);
  if (!m) return callSource;
  const escaped = newValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const newArgs = m[1] + escaped + m[3] + argsText.substring(m[0].length);
  return callSource.substring(0, argList.open + 1) + newArgs + callSource.substring(argList.close);
}

/**
 * Apply `transform` to the call starting at `from` (its `#`) and dispatch the
 * result if it changed. Used by every pill option.
 *
 * The call's end is found again from the live document each time. Option
 * builders capture `from` / `to` when the menu opens, and an earlier commit can
 * change the call's length, so a stored `to` would be stale and corrupt the
 * source.
 */
export function applyCallTransform(
  view: EditorView,
  from: number,
  transform: (src: string) => string,
): void {
  const len = view.state.doc.length;
  const safeFrom = Math.max(0, Math.min(from, len));
  const liveTo = findCallEnd(view, safeFrom);
  const safeTo = Math.max(safeFrom, Math.min(liveTo, len));
  const current = view.state.doc.sliceString(safeFrom, safeTo);
  const next = transform(current);
  if (next === current) return;
  view.dispatch({
    changes: { from: safeFrom, to: safeTo, insert: next },
  });
}

function consumeBalanced(s: string, start: number, open: string, close: string): number {
  if (s[start] !== open) return start;
  let depth = 0;
  let inStr = false;
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' && (i === 0 || s[i - 1] !== "\\")) { inStr = !inStr; i++; continue; }
    if (inStr) { i++; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return s.length;
}
