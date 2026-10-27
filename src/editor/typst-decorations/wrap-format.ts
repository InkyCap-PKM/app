import { ChangeSpec, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The change + resulting selection that toggling a wrapper produces. */
export interface WrapTransaction {
  changes: ChangeSpec;
  selection: { anchor: number; head: number };
}

/**
 * The transaction that toggles an inline wrapper (`before`…`after`, e.g.
 * `*`…`*` for bold or `#strike[`…`]`) around the selection. Applying the same
 * format again must remove it, never nest another pair:
 *
 *  1. Empty selection: insert an empty pair with the caret between.
 *  2. The selection includes the delimiters (a source-mode selection of `*…*`):
 *     remove them.
 *  3. The delimiters sit just outside the selection (visual mode, where the
 *     markup is hidden and only the inner text is selected): remove them.
 *  4. Otherwise wrap.
 *
 * Shared by the shortcuts (keymaps.ts) and the selection toolbar.
 */
export function toggleWrap(
  state: EditorState,
  before: string,
  after: string,
  caretInWrapper?: number,
): WrapTransaction {
  const { from, to } = state.selection.main;

  // For wrappers with an inner slot separate from the wrapped text, e.g.
  // `#link("")[…]`, where the caret goes in the empty URL (offset 7). Defaults
  // to just after `before`. Only used by the inserting cases (1) and (4).
  const insertCaret = caretInWrapper ?? before.length;

  // (1) Empty selection: drop an empty pair and put the caret inside it.
  if (from === to) {
    const at = from + insertCaret;
    return {
      changes: { from, insert: before + after },
      selection: { anchor: at, head: at },
    };
  }

  const selected = state.doc.sliceString(from, to);

  // (2) and (3) — already wrapped in one shape or the other → strip.
  const stripped = unwrapIfWrapped(state, before, after);
  if (stripped) return stripped;

  // (4) Wrap. With an inner slot, put the caret there (the URL quotes of
  // `#link("")[label]`); otherwise keep the text selected so toggling again or
  // typing replaces it.
  if (caretInWrapper != null) {
    const at = from + caretInWrapper;
    return {
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: at, head: at },
    };
  }
  return {
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: to + before.length },
  };
}

/**
 * The transaction removing a `before`…`after` wrapper around the selection, or
 * `null` if there is none. Handles cases (2) and (3) of `toggleWrap`.
 */
function unwrapIfWrapped(
  state: EditorState,
  before: string,
  after: string,
): WrapTransaction | null {
  const { from, to } = state.selection.main;
  if (from === to) return null;
  const selected = state.doc.sliceString(from, to);

  // (2) Delimiters captured inside the selection → strip them.
  if (
    selected.length >= before.length + after.length &&
    selected.startsWith(before) &&
    selected.endsWith(after)
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return {
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    };
  }

  // (3) Delimiters immediately surrounding the selection (visual mode) → strip.
  const openFrom = from - before.length;
  const closeTo = to + after.length;
  if (
    openFrom >= 0 &&
    closeTo <= state.doc.length &&
    state.doc.sliceString(openFrom, from) === before &&
    state.doc.sliceString(to, closeTo) === after
  ) {
    return {
      // Two deletions in original-document coordinates; CM maps them together.
      changes: [
        { from: openFrom, to: from, insert: "" },
        { from: to, to: closeTo, insert: "" },
      ],
      // After the opener is removed the inner text shifts left by its length;
      // selection positions are in the resulting document.
      selection: { anchor: openFrom, head: to - before.length },
    };
  }

  return null;
}

/* ── Bold / italic: shorthand markers vs. the function form ──────────────── */

// Typst treats `*` and `_` as delimiters only when the characters on both sides
// aren't both "wordy". These match the `in_word` test in Typst's lexer:
// alphanumerics are wordy, except in scripts written without spaces.
const WORDY_CHAR = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u;
const SPACELESS_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function isWordy(ch: string | undefined): boolean {
  return ch != null && WORDY_CHAR.test(ch) && !SPACELESS_SCRIPT.test(ch);
}

/** The whole character ending at `pos`, surrogate pair included. */
function charBefore(state: EditorState, pos: number): string | undefined {
  const slice = state.doc.sliceString(Math.max(0, pos - 2), pos);
  return Array.from(slice).pop();
}

/** The whole character starting at `pos`, surrogate pair included. */
function charAfter(state: EditorState, pos: number): string | undefined {
  const slice = state.doc.sliceString(pos, Math.min(state.doc.length, pos + 2));
  return Array.from(slice)[0];
}

/**
 * Whether a shorthand marker at both ends of the selection would be read as a
 * delimiter. With a letter or digit on both sides it is plain text: in
 * `l'*a*ppropriation` the `*` after `a` can't close, and the bold runs on to
 * the next usable `*`. Only the outer neighbours matter.
 */
function shorthandWorksHere(state: EditorState): boolean {
  const { from, to } = state.selection.main;
  const selected = state.doc.sliceString(from, to);
  const chars = Array.from(selected);
  // With an empty selection the caret's own neighbours stand in for the text
  // the user is about to type, so both markers get the same verdict.
  const outerBefore = charBefore(state, from);
  const outerAfter = charAfter(state, to);
  const innerAfterOpen = chars[0] ?? outerAfter;
  const innerBeforeClose = chars[chars.length - 1] ?? outerBefore;

  const openInWord = isWordy(outerBefore) && isWordy(innerAfterOpen);
  const closeInWord = isWordy(innerBeforeClose) && isWordy(outerAfter);
  return !openInWord && !closeInWord;
}

/**
 * Toggle bold or italic in a form Typst will read here: the shorthand
 * (`*bold*`, `_italic_`) normally, the function form (`#strong[…]`, `#emph[…]`)
 * inside a word, which has no position restriction. Both forms toggle off,
 * including hand-typed shorthand.
 *
 * @param marker  Shorthand delimiter: `*` for bold, `_` for italic.
 * @param funcName  Matching Typst function: `strong` or `emph`.
 */
export function toggleEmphasis(
  state: EditorState,
  marker: string,
  funcName: string,
): WrapTransaction {
  const open = `#${funcName}[`;
  const close = "]";
  const stripped =
    unwrapIfWrapped(state, marker, marker) ?? unwrapIfWrapped(state, open, close);
  if (stripped) return stripped;

  return shorthandWorksHere(state)
    ? toggleWrap(state, marker, marker)
    : toggleWrap(state, open, close);
}

/** Dispatch {@link toggleEmphasis} on a view and restore focus to the editor. */
export function applyToggleEmphasis(
  view: EditorView,
  marker: string,
  funcName: string,
): void {
  view.dispatch(toggleEmphasis(view.state, marker, funcName));
  view.focus();
}

/** Dispatch {@link toggleWrap} on a view and restore focus to the editor. */
export function applyToggleWrap(
  view: EditorView,
  before: string,
  after: string,
  caretInWrapper?: number,
): void {
  view.dispatch(toggleWrap(view.state, before, after, caretInWrapper));
  view.focus();
}
