// Universal pill chip + super-context-menu for the visual editor.
//
// See documentation/developer/visual-editor/pill-system.md for the design
// rules (R1–R11) this module implements. In short: every pill in the
// visual editor renders the same chip DOM, has the same hover/focus
// state, is keyboard accessible, and opens the same super-menu on
// left-click, right-click, and Enter/Space.

import { type EditorView, WidgetType } from "@codemirror/view";
import { expandFunc } from "./effects";
import { setTabEditingMode, getActiveTab } from "../../stores/tabs";

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
  /** Optional longer help text. Renders a circled "?" trigger next to the
   *  item's label that reveals this text inline within the menu — for
   *  explanations too long to sit comfortably in a tooltip or placeholder. */
  help?: string;
  /** Disable this item (renders dimmed, not clickable). */
  disabled?: boolean;
  /** Called on click; the menu closes after the handler returns unless
   *  `keepOpen` is true. */
  onSelect?: () => void;
  /** When true, clicking does not close the menu (e.g. for live-edit
   *  fields like color swatches that should let the user try several). */
  keepOpen?: boolean;
  /** Render this item as an inline text input instead of a button.
   *  When set, `onSelect` is ignored — `input.onCommit` fires when the
   *  user presses Enter or the field loses focus, and the menu closes. */
  input?: {
    /** Current value to populate the field with. */
    value: string;
    /** Optional placeholder when empty. */
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
  /** Override the "Edit source" action (defaults to dispatching
   *  `expandFunc` against `callFrom`). Used by embedded pills (verse,
   *  bibliography) where "expanding" doesn't apply the same way. */
  onEditSource?: (view: EditorView) => void;
  /** When false, suppress the "Edit source" item even for simple calls
   *  (e.g. embedded pills where the widget's canvas IS the editor). */
  allowEditSource?: boolean;
  /** When true, pill left-click always runs `runEditSource` regardless
   *  of the simple/complex classifier (R5/R8). Used for block content-
   *  bracket pills (callout, quote) where the body is the whole point —
   *  the user almost always wants the source revealed for editing, not
   *  the menu. The menu remains reachable via right-click. */
  alwaysExpandOnClick?: boolean;
}

// ── PillChip widget ─────────────────────────────────────────────────

/** Build the canonical pill DOM: a `<button>` with a circled hash + label.
 *
 *  This is the single source of truth for pill appearance and event
 *  surface. All call sites — inline pills, block-pill-rows, verse,
 *  bibliography — must go through this builder so R1 (single visual
 *  identity), R2 (hover/focus), and R3 (keyboard accessible) are
 *  guaranteed by construction. */
export function buildPillButton(
  funcName: string,
  view: EditorView,
  modelFor: () => PillModel,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cm-typst-pill";
  btn.title = funcName;
  btn.setAttribute("aria-label", `${funcName} — open options`);

  const hash = document.createElement("span");
  hash.className = "cm-typst-pill-hash";
  btn.appendChild(hash);

  const label = document.createElement("span");
  label.className = "cm-typst-pill-label";
  label.textContent = funcName;
  btn.appendChild(label);

  // Don't let a mousedown on the pill move CodeMirror's selection or
  // start a text drag. The actual action runs on click so that focus
  // moves to the pill and keyboard users can re-trigger via Enter.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  // Same for right-click: prevent the native context menu, then open
  // ours on the contextmenu event itself (not click), so users get
  // the menu on the gesture they expect.
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPillMenu(btn, view, modelFor());
  });
  // R5 click model:
  //   simple pill  → enter inline source-edit directly (low-friction primary).
  //   complex pill → open the super-menu (inline edit isn't safe).
  //   embedded pill (allowEditSource === false) → open the super-menu
  //     (verse / bibliography have no inline-source mode — their canvas
  //     is the editor).
  // Right-click always opens the menu (handler above) so every pill keeps
  // the universal escape hatch regardless of complexity.
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
  // Enter / Space already trigger click on a <button>, so keyboard
  // accessibility (R3) falls out of using the right element.

  return btn;
}

/** Convenience wrapper for inline-flow pills that fire `expandFunc`
 *  with no per-pill options. Replaces the old `FuncPillWidget` and
 *  `FuncChipWidget` from visual-plugin.ts.
 *
 *  Call sites that need options should call `buildPillButton` directly
 *  with a `modelFor` closure that returns the appropriate `optionSections`. */
export class PillChip extends WidgetType {
  constructor(
    readonly pos: number,
    readonly funcName: string,
    /** Document offset of the end of the call. If unknown, pass `pos + 1`
     *  and the universal Copy/Duplicate/Delete actions will fall back to
     *  expanding the call first. */
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

// ── openPillMenu — the super-context-menu (R6) ──────────────────────

/** Render and show the super-menu anchored to `anchor`. The menu has
 *  three sections per R6:
 *    1. widget-specific options (model.optionSections)
 *    2. source access (Edit source / Open in source editor)
 *    3. universal actions (Copy / Duplicate / Delete)
 *
 *  Closes on outside click, Escape, or after a non-keepOpen item runs. */
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

  // Focus the first interactive element so keyboard users can act
  // immediately. Prefer an input if one is present (inline-input rows
  // are the most common reason a user opened the menu via keyboard).
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

  // The checkmark sits on the right side of the row so the eye scans
  // labels left-to-right without the indentation jitter that a
  // left-side check would introduce on inactive items.
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

  // Optional inline help: a circled "?" next to the label toggles a wrapped
  // explanation on its own line within the menu. Kept inside the menu DOM (not
  // a portalled popover) so the menu's outside-click dismissal leaves it be.
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

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cm-typst-pill-menu-input";
  input.value = item.input!.value;
  if (item.input!.placeholder) input.placeholder = item.input!.placeholder;
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

  // Help text comes last so `flex-wrap` drops it onto its own full-width line
  // below the label + input.
  if (helpBlock) wrap.appendChild(helpBlock);

  return wrap;
}

// ── Source section (R8: simple vs complex) ──────────────────────────

/** Run the "Edit source" action for a pill. Used both by the menu item
 *  and by the simple-pill left-click shortcut (R5), so the destination
 *  is identical whichever path the user takes. */
export function runEditSource(view: EditorView, model: PillModel): void {
  if (model.onEditSource) {
    model.onEditSource(view);
  } else {
    view.dispatch({
      effects: expandFunc.of(model.callFrom),
      selection: { anchor: model.callFrom + 1 },
    });
    view.focus();
  }
}

function buildSourceSection(view: EditorView, model: PillModel): PillMenuSection {
  const items: PillMenuItem[] = [];
  const allowEdit = model.allowEditSource !== false;
  if (allowEdit) {
    // Show "Edit source" when either the call is simple by the R8
    // classifier, or the pill explicitly opts into always-expand
    // behaviour (R5: callout / quote where the body is the point).
    const expandable = model.alwaysExpandOnClick === true
      || isSimpleCall(view, model.callFrom, model.callTo);
    if (expandable) {
      items.push({
        label: "Edit source",
        title: "Reveal raw Typst source for inline editing",
        onSelect: () => runEditSource(view, model),
      });
    }
  }
  const tab = getActiveTab();
  const isSource = tab?.editingMode === "source";
  if (isSource) {
    items.push({
      label: "Open in visual editor",
      title: "Switch this tab to visual mode",
      onSelect: () => {
        if (tab) setTabEditingMode(tab.id, "live");
      },
    });
  } else {
    items.push({
      label: "Open in source editor",
      title: "Switch this tab to source mode and select the call",
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
        label: "Copy",
        title: "Copy the function call to the clipboard",
        onSelect: () => {
          void navigator.clipboard.writeText(callSource).catch((err) => {
            console.error("Pill copy failed:", err);
          });
        },
      },
      {
        label: "Duplicate",
        title: "Insert a copy of this call after the current one",
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
        label: "Delete",
        title: "Remove this call and its content from the document",
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
    label: "Remove style",
    title: "Remove the function wrapper but keep the content",
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

/** A pill call is "simple" — and thus may offer inline "Edit source" — when:
 *    - the call source fits on one line,
 *    - its source length is ≤ 120 chars,
 *    - it contains at most one level of nested function calls.
 *  Anything else routes the user to "Open in source editor" instead. */
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

/** Find the end offset of the function call starting at `pos` (where
 *  source[pos] === '#'). Walks the source forward, tracking parens and
 *  brackets, treating strings as opaque. Returns the offset just past
 *  the final closing delimiter, or `pos + 1` if the call has no
 *  delimiters (e.g. a bare `#pagebreak` reference, though Typst calls
 *  in our editor always include `()` or `[]`).
 *
 *  This is a fallback used when callers don't supply `callTo`. Most
 *  pill construction sites already know the call range from their
 *  decoration logic and should pass it explicitly. */
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

// ── Named-argument upsert (R7 / R11) ────────────────────────────────
//
// Single source of truth for editing one named argument inside a Typst
// function call's source — used by every per-pill option (image alt,
// quote attribution, callout kind, highlight color, etc.). Generalizes
// the precedent set by VerseWidget.upsertAlignArg.
//
// Mutating only the targeted arg (and dropping it entirely when its
// value matches the function's default) keeps surrounding whitespace
// and untouched arguments byte-identical, satisfying the source ↔
// visual round-trip invariant (R11 / CLAUDE.md).

/** Locate the `(...)` argument list inside a call's source. Returns
 *  inclusive offsets of the opening and closing parens within
 *  `callSource`, or null if the call has no parens (e.g. `#highlight[…]`). */
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

/** Find the value range of a named arg `name: <value>` inside an args
 *  string. Returns `null` if not present. The returned `from..to` covers
 *  just the value (everything after `name:` and any whitespace, up to
 *  the next top-level `,` or end of string). */
export function findNamedArgValue(argsText: string, name: string): { from: number; to: number } | null {
  const re = new RegExp(`(^|,)\\s*${name}\\s*:\\s*`, "g");
  const m = re.exec(argsText);
  if (!m) return null;
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
      return { from: valueStart, to: i };
    }
  }
  return { from: valueStart, to: argsText.length };
}

export interface UpsertOptions {
  /** When the new value equals this string literal, drop the arg entirely
   *  (keeps source clean — analogous to VerseWidget dropping `align-to: left`). */
  defaultValue?: string;
}

/** Upsert a single named argument inside a call's source. Returns the
 *  rewritten call source. If the arg is already present, replaces just
 *  its value range; otherwise inserts `name: value` at the end of the
 *  arg list (creating the arg list if the call has none). */
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
      // Remove the entire `, name: value` (or leading `name: value,` if
      // first arg). Trim whitespace cleanly.
      const re = new RegExp(`(,\\s*)?${name}\\s*:\\s*[^,]*(\\s*,)?`);
      const m = argsText.match(re);
      if (!m) return callSource;
      let next = argsText.replace(re, (full, before, after) => {
        // If we ate a trailing comma, that's fine; if we ate a leading
        // comma, that's also fine. If both, leave one comma.
        return before && after ? "," : "";
      });
      next = next.replace(/^\s*,\s*/, "").replace(/\s*,\s*$/, "");
      newArgs = next;
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

/** Read the first positional string argument (e.g. callout kind, image
 *  path). Returns the string content (without surrounding quotes), or
 *  null if not found. */
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

/** Apply a call-source-level transform to the document. Reads the
 *  current call source starting at `from` (the `#` of the call),
 *  runs `transform`, and dispatches a transaction with the new source
 *  if it changed. Used by all per-pill option handlers.
 *
 *  The call's end offset is re-resolved from the live document via
 *  `findCallEnd` on every invocation. This is the load-bearing detail:
 *  option builders capture `from`/`to` once when the menu opens, but
 *  if the user commits two menu fields in sequence (e.g. image width
 *  then alt), the first commit grows the call and any stored `to` is
 *  stale by the second. Using the stale `to` slices a truncated call,
 *  `findArgList` fails to find the matching `)`, and the no-arglist
 *  branch of `upsertNamedArg` wraps the new arg in parens at the wrong
 *  spot — producing corruption like `#line(l(stroke: 2pt)ength: 50%)`.
 *  Re-resolving `to` here makes the helpers re-entrant safe regardless
 *  of how many commits the user makes against an open menu. */
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
