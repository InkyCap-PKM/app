// Typing a URL or an email address in the visual editor.
//
// Typst reads bare `http://` and `https://` text as a link, but after any other
// scheme (`zotero://`, `ftp://`, `inkycap://`, …) the `//` starts a comment and
// the rest of the address vanishes from the note, and the `@` of an email
// address starts a reference. So in ordinary text these become a `#link("…")`
// call, with the caret inside the address, as soon as they are recognizable:
//
//   - the second `/` of `<scheme>://`
//   - the `:` of `mailto:`
//   - an `@` straight after a word (`joshua@` → `#link("mailto:joshua@")`),
//     the shape InkyCap reads as an email address (see `isEmailLikeAt`)
//
// Typst shows a `mailto:` link without its prefix, so the linked address reads
// as the plain address.
//
// A space or Enter typed at the end of a link's address steps out of the call
// first, since an address cannot contain either. Undo turns the call back into
// the text as it was before the last keystroke; for an email address that is
// the escaped `joshua\@`, Typst's plain-text form of an address.
//
// Visual mode only: the source editor stays plain Typst.

import { EditorView, keymap } from "@codemirror/view";
import { Prec, type EditorState, type Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { dispatchVisible } from "./dispatch-visible";
import { isEmailLikeAt } from "./reference-form";

/** A scheme and `:/` just before the caret, starting a word. */
const SCHEME_AND_SLASH = /(?:^|[^a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*):\/$/;
/** `mailto` just before the caret, starting a word. */
const MAILTO = /(?:^|[^a-zA-Z0-9+.-])(mailto)$/i;
/** An email address's local part just before the caret. */
const EMAIL_LOCAL_PART = /[A-Za-z0-9._+-]+$/;
/** Schemes Typst already reads as a link when written bare. */
const BARE_LINK_SCHEMES = new Set(["http", "https"]);

const LINK_OPEN = '#link("';
const LINK_CLOSE = '")';

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
  dispatchLink(view, from, to, address);
  return true;
}

function dispatchLink(view: EditorView, from: number, to: number, address: string): void {
  const insert = `${LINK_OPEN}${address}${LINK_CLOSE}`;
  dispatchVisible(view, {
    changes: { from, to, insert },
    selection: { anchor: from + LINK_OPEN.length + address.length },
    // Its own undo step: undo leaves the text as typed so far, and typing the
    // rest of the address doesn't join this step.
    annotations: isolateHistory.of("full"),
    userEvent: "input.type",
  });
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

function handleAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const before = view.state.doc.sliceString(line.from, pos);
  if (!isEmailLikeAt(before.slice(-1))) return false;
  const local = EMAIL_LOCAL_PART.exec(before)![0];
  const start = pos - local.length;
  if (!inMarkupText(view.state, start)) return false;
  // The escaped address goes in first, as typed text, so undoing the link
  // leaves `joshua\@` rather than a bare `@` that Typst reads as a reference.
  view.dispatch({
    changes: { from: pos, insert: "\\@" },
    selection: { anchor: pos + 2 },
    userEvent: "input.type",
  });
  dispatchLink(view, start, pos + 2, `mailto:${local}@`);
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
  if (text === "@") return handleAt(view, from);
  if (text === " ") {
    const end = linkAddressEnd(view.state, from);
    if (end === null) return false;
    dispatchVisible(view, {
      changes: { from: end, insert: " " },
      selection: { anchor: end + 1 },
      userEvent: "input.type",
    });
    return true;
  }
  return false;
});

// Enter moves the caret out of the call and then lets the usual Enter run, so
// list continuation and line breaks behave as at the end of any other text.
const urlTypingKeymap = Prec.high(
  keymap.of([
    {
      key: "Enter",
      run(view) {
        const sel = view.state.selection.main;
        if (!sel.empty) return false;
        const end = linkAddressEnd(view.state, sel.head);
        if (end !== null) view.dispatch({ selection: { anchor: end } });
        return false;
      },
    },
  ]),
);

/** Turns typed non-web URLs and email addresses into `#link` calls in the
 *  visual editor. */
export const urlTyping: Extension = [urlTypingInput, urlTypingKeymap];
