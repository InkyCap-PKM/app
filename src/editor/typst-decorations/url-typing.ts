// Typing a URL or an email address in the visual editor.
//
// Typst reads bare `http://` and `https://` text as a link, but after any other
// scheme (`zotero://`, `ftp://`, `inkycap://`, …) the `//` starts a comment and
// the rest of the address vanishes from the note. So in ordinary text, typing
// the second `/` of `<scheme>://`, or the `:` of `mailto:`, turns what was
// typed into a `#link("…")` call with the caret inside the address. (A bare
// `mailto:` address has no `//`, but its `@` would be read as a reference.)
//
// An `@` can't be decided when it is typed: `joshua@` may become an email
// address or a citation placed straight after a word. So email addresses and
// fediverse handles are rewritten when the word ends, with a space or Enter,
// by what Typst's parser made of the whole word (see address-markup.ts):
// `joshua@phydeau.org` becomes a `mailto:` link, `@person@mastodon.social`
// becomes plain text with its `@`s escaped, and a reference to a bibliography
// key or a label in the note is left alone. The `@` menu offers the same
// choices explicitly (see reference-suggest.ts).
//
// A space or Enter typed at the end of a link's address steps out of the call
// first, since an address cannot contain either. Undo turns a link back into
// the text as it was before; for an email address that is the escaped
// `joshua\@phydeau.org`, Typst's plain-text form of an address.
//
// Visual mode only: the source editor stays plain Typst.

import { EditorView, keymap } from "@codemirror/view";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { dispatchVisible } from "./dispatch-visible";
import {
  LINK_CLOSE,
  addressEndingAt,
  escapeAts,
  linkEmail,
  replaceWithLink,
} from "./address-markup";
import { getCachedBibKeys } from "./reference-suggest";
import { scanDocumentLabels } from "./document-labels";

/** A scheme and `:/` just before the caret, starting a word. */
const SCHEME_AND_SLASH = /(?:^|[^a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*):\/$/;
/** `mailto` just before the caret, starting a word. */
const MAILTO = /(?:^|[^a-zA-Z0-9+.-])(mailto)$/i;
/** Schemes Typst already reads as a link when written bare. */
const BARE_LINK_SCHEMES = new Set(["http", "https"]);

/** Whether `pos` sits in ordinary markup text — not in a raw block, a string,
 *  code, maths or a comment. */
function inMarkupText(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolveInner(pos, 1);
  return node.name === "Text" && node.parent?.name === "Markup";
}

/** Replace `from..to` plus the character being typed with a `#link` call for
 *  `address`, leaving the caret at the end of the address. */
function convertToLink(view: EditorView, from: number, to: number, address: string): boolean {
  if (!inMarkupText(view.state, from)) return false;
  replaceWithLink(view, from, to, address, true);
  return true;
}

function handleSlash(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const before = view.state.doc.sliceString(line.from, pos);
  const m = SCHEME_AND_SLASH.exec(before);
  if (!m || BARE_LINK_SCHEMES.has(m[1].toLowerCase())) return false;
  const start = pos - m[1].length - ":/".length;
  return convertToLink(view, start, pos, `${m[1]}://`);
}

function handleColon(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const m = MAILTO.exec(view.state.doc.sliceString(line.from, pos));
  if (!m) return false;
  return convertToLink(view, pos - m[1].length, pos, `${m[1]}:`);
}

/** Whether `name` is a bibliography key or a label in the note. */
function isKnownTarget(state: EditorState, name: string): boolean {
  return getCachedBibKeys().has(name) || scanDocumentLabels(state).some((l) => l.name === name);
}

/**
 * Rewrite an email address or handle that ends at `pos`, inserting `typed`
 * (the keystroke that ended it) after it. Returns false when the word before
 * `pos` is neither.
 */
function finishAddress(view: EditorView, pos: number, typed: string): boolean {
  const state = view.state;
  const address = addressEndingAt(state, pos, (name) => isKnownTarget(state, name));
  if (!address) return false;
  const extra = typed ? { from: pos, insert: typed } : undefined;
  if (address.kind === "email") {
    linkEmail(view, address, { extra, caretAfter: pos + 1 + typed.length });
  } else {
    escapeAts(view, address.ats, { extra, caretAfter: pos + address.ats.length + typed.length });
  }
  return true;
}

/**
 * The position just past a `#link("…")` call when the caret is at the end of
 * its address and the call has no `[…]` text, or `null` otherwise.
 */
export function linkAddressEnd(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos);
  if (!/#link\("[^"\s]*$/.test(state.doc.sliceString(line.from, pos))) return null;
  const after = state.doc.sliceString(pos, Math.min(line.to, pos + LINK_CLOSE.length + 1));
  if (!after.startsWith(LINK_CLOSE) || after[LINK_CLOSE.length] === "[") return null;
  return pos + LINK_CLOSE.length;
}

const urlTypingInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to) return false;
  if (text === "/") return handleSlash(view, from);
  if (text === ":") return handleColon(view, from);
  if (text === " ") {
    const end = linkAddressEnd(view.state, from);
    if (end === null) return finishAddress(view, from, " ");
    dispatchVisible(view, {
      changes: { from: end, insert: " " },
      selection: { anchor: end + 1 },
      userEvent: "input.type",
    });
    return true;
  }
  return false;
});

// Enter finishes an address, or moves the caret out of a link call, and then
// lets the usual Enter run, so list continuation and line breaks behave as at
// the end of any other text.
const urlTypingKeymap = Prec.high(
  keymap.of([
    {
      key: "Enter",
      run(view) {
        const sel = view.state.selection.main;
        if (!sel.empty) return false;
        const end = linkAddressEnd(view.state, sel.head);
        if (end !== null) view.dispatch({ selection: { anchor: end } });
        else finishAddress(view, sel.head, "");
        return false;
      },
    },
  ]),
);

/** Turns typed non-web URLs and email addresses into `#link` calls, and
 *  escapes the `@`s of fediverse handles, in the visual editor. */
export const urlTyping: Extension = [urlTypingInput, urlTypingKeymap];
