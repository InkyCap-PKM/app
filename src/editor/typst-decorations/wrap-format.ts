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
