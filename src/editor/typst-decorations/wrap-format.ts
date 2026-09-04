import { ChangeSpec, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The change + resulting selection that toggling a wrapper produces. */
export interface WrapTransaction {
  changes: ChangeSpec;
  selection: { anchor: number; head: number };
}

/**
 * Compute the transaction that toggles an inline wrapper (`before`…`after`,
 * e.g. `*`…`*` for bold or `#strike[`…`]` for strikethrough) around the
 * current selection.
 *
 * Toggling — not merely wrapping — is the load-bearing behaviour: invoking the
 * same format a second time must REMOVE it, never nest another pair. Three
 * "already wrapped" shapes are recognized, then stripped:
 *
 *  1. Empty selection → insert an empty pair, caret placed between the
 *     delimiters.
 *  2. The selection itself spans the delimiters — a source-mode selection that
 *     includes the raw `*…*` / `#strike[…]` markup.
 *  3. The delimiters sit just OUTSIDE the selection — the visual-mode case: the
 *     markup is decorated away, so the user selects only the inner text and the
 *     `before`/`after` live in the document immediately around the selection.
 *     This is the shape that previously fell through to "wrap again", producing
 *     the nesting bug, because only shape (2) was checked.
 *
 * Only when none of these match is a fresh wrapper inserted. Shared by the
 * keyboard shortcuts (keymaps.ts) and the selection toolbar so the toggle rule
 * lives in exactly one place.
 */
export function toggleWrap(
  state: EditorState,
  before: string,
  after: string,
  caretInWrapper?: number,
): WrapTransaction {
  const { from, to } = state.selection.main;

  // `caretInWrapper` is for wrappers that have an inner slot distinct from the
  // wrapped text — e.g. `#link("")[…]`, where the caret should land in the
  // empty URL string (offset 7, between the quotes), not on the label. When
  // omitted, the caret defaults to just after `before`. Only the insert cases
  // (1) and (4) honour it; the unwrap cases (2) and (3) are unaffected.
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

  // (4) Not wrapped → wrap. With an explicit inner slot, collapse the caret
  // into it (e.g. the URL quotes of `#link("")[label]`); otherwise keep the
  // wrapped text selected so re-toggling or typing replaces it.
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
 * Recognize an existing `before`…`after` wrapper around the selection and
 * return the transaction that removes it, or `null` when none is present.
 *
 * Two shapes count as "already wrapped":
 *
 *  2. The selection itself spans the delimiters — a source-mode selection that
 *     includes the raw `*…*` / `#strike[…]` markup.
 *  3. The delimiters sit just OUTSIDE the selection — the visual-mode case: the
 *     markup is decorated away, so the user selects only the inner text and the
 *     `before`/`after` live in the document immediately around the selection.
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

// Typst only treats `*` and `_` as bold/italic delimiters when the characters
// on either side of the marker are NOT both "wordy". These two patterns mirror
// the `in_word` test in Typst's own lexer: alphanumeric counts as wordy, except
// for scripts written without spaces, where a marker between two characters is
// still a valid delimiter.
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
 * Whether a one-character shorthand marker placed at both ends of the current
 * selection would actually be read as a delimiter by Typst.
 *
 * A marker with a letter or digit on both sides is plain text to Typst, so
 * `l'*a*ppropriation` does not bold the `a`: the opening `*` starts a bold run
 * that the `*` after `a` cannot close, and the run instead ends at the next
 * usable `*` further along the line. Only the outward-facing neighbours matter
 * — the marker itself sits between the surrounding text and the wrapped text.
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
 * Toggle bold or italic, choosing the markup form that Typst will actually
 * read at this position.
 *
 * Away from word interiors this writes the familiar shorthand (`*bold*`,
 * `_italic_`). Inside a word it writes the function form instead
 * (`#strong[…]`, `#emph[…]`), which carries no position restriction and is the
 * same document to Typst. Both forms toggle back off, so a user who typed the
 * shorthand by hand still gets it removed on the second invocation.
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
