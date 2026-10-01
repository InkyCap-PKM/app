// Email addresses and fediverse handles in Typst markup.
//
// Typst reads every `@` followed by a label character as a reference: it parses
// `joshua@phydeau.org` as text plus a reference to `<phydeau.org>`, and
// `@person@mastodon.social` as two references. Neither is meant as one, so the
// visual editor rewrites them once they are finished: an email address becomes
// a `#link("mailto:…")` call, and a handle becomes plain text with each `@`
// escaped (`\@person\@mastodon.social`). The address is recognized from the
// references Typst's own parser found, so text that Typst does not read as a
// reference is never touched.

import type { EditorView } from "@codemirror/view";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import { dispatchVisible } from "./dispatch-visible";

export const LINK_OPEN = '#link("';
export const LINK_CLOSE = '")';

/** The local part of an email address (before its `@`). */
const LOCAL_PART = /^[A-Za-z0-9._+-]+$/;
/** A domain name: dot-separated labels ending in a top-level domain. */
const DOMAIN = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
/** Punctuation that can open a word in prose, before an address. */
const LEADING_PUNCTUATION = /^[(["'“‘<]*/;
/** Punctuation that can close a word in prose, after an address. */
const TRAILING_PUNCTUATION = /^[.,;:!?)\]"'”’>]*$/;

/** A finished address just before a position. */
export type Address =
  /** `joshua@phydeau.org`, spanning `from..to`, with its `@` at `at`. */
  | { kind: "email"; from: number; to: number; at: number }
  /** `@person@mastodon.social`, with its two `@`s at `ats`. */
  | { kind: "handle"; ats: [number, number] };

interface RefSpan {
  from: number;
  to: number;
  target: string;
}

/**
 * The email address or fediverse handle that the word ending at `end` holds, or
 * null. `isKnownTarget` says whether a name is a bibliography key or a label in
 * the note: a reference to one of those is a real reference, never an address.
 */
export function addressEndingAt(
  state: EditorState,
  end: number,
  isKnownTarget: (name: string) => boolean,
): Address | null {
  const line = state.doc.lineAt(end);
  const word = /\S+$/.exec(state.doc.sliceString(line.from, end));
  if (!word || !word[0].includes("@")) return null;
  const wordFrom = end - word[0].length;
  const start = wordFrom + LEADING_PUNCTUATION.exec(word[0])![0].length;

  const refs: RefSpan[] = [];
  syntaxTree(state).iterate({
    from: wordFrom,
    to: end,
    enter(node) {
      if (node.name !== "Ref") return;
      if (node.from < wordFrom || node.to > end) return false;
      refs.push({ from: node.from, to: node.to, target: state.doc.sliceString(node.from + 1, node.to) });
      return false;
    },
  });
  if (refs.length === 0) return null;
  const last = refs[refs.length - 1];
  if (!TRAILING_PUNCTUATION.test(state.doc.sliceString(last.to, end))) return null;
  if (!DOMAIN.test(last.target) || isKnownTarget(last.target)) return null;

  if (refs.length === 1) {
    const local = state.doc.sliceString(start, last.from);
    if (!LOCAL_PART.test(local)) return null;
    return { kind: "email", from: start, to: last.to, at: last.from };
  }
  if (refs.length === 2) {
    const [first] = refs;
    if (first.from !== start || first.to !== last.from || isKnownTarget(first.target)) return null;
    return { kind: "handle", ats: [first.from, last.from] };
  }
  return null;
}

/**
 * Replace `from..to` with a `#link` call for `address`. The caret goes to the
 * end of the address when `caretInAddress` is set, and otherwise keeps its
 * place. The edit is an undo step of its own, so undo leaves the text it
 * replaced, and typing that follows doesn't join it.
 */
export function replaceWithLink(
  view: EditorView,
  from: number,
  to: number,
  address: string,
  caretInAddress: boolean,
): void {
  const insert = `${LINK_OPEN}${address}${LINK_CLOSE}`;
  dispatchVisible(view, {
    changes: { from, to, insert },
    ...(caretInAddress ? { selection: { anchor: from + LINK_OPEN.length + address.length } } : {}),
    annotations: isolateHistory.of("full"),
    userEvent: "input.type",
  });
}

/**
 * Turn the email address at `from..to`, whose `@` is at `at`, into a `mailto:`
 * link. The `@` is escaped first, as its own edit, so undoing the link leaves
 * `joshua\@phydeau.org`, Typst's plain-text form of an address. `extra` is
 * applied with that first edit (the keystroke that finished the address).
 */
export function linkEmail(
  view: EditorView,
  email: { from: number; to: number; at: number },
  options: { extra?: ChangeSpec; caretInAddress?: boolean; caretAfter?: number } = {},
): void {
  const address = `mailto:${view.state.doc.sliceString(email.from, email.to)}`;
  view.dispatch({
    changes: [{ from: email.at, insert: "\\" }, ...(options.extra ? [options.extra] : [])],
    ...(options.caretAfter !== undefined ? { selection: { anchor: options.caretAfter } } : {}),
    userEvent: "input.type",
  });
  replaceWithLink(view, email.from, email.to + 1, address, !!options.caretInAddress);
}

/** Escape each `@` at `ats` so Typst shows it as text, along with `extra`. */
export function escapeAts(
  view: EditorView,
  ats: readonly number[],
  options: { extra?: ChangeSpec; caretAfter?: number } = {},
): void {
  dispatchVisible(view, {
    changes: [...ats.map((at) => ({ from: at, insert: "\\" })), ...(options.extra ? [options.extra] : [])],
    ...(options.caretAfter !== undefined ? { selection: { anchor: options.caretAfter } } : {}),
    userEvent: "input.type",
  });
}

/** Whether `pos` is in markup text or a reference in markup, as opposed to a
 *  string, raw text, code, maths or a comment. */
export function inMarkupAt(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  if (node.name !== "Text" && node.name !== "Ref" && node.name !== "RefMarker") return false;
  while (node.parent && (node.name === "Ref" || node.name === "RefMarker" || node.name === "Text")) {
    node = node.parent;
  }
  return node.name === "Markup";
}
