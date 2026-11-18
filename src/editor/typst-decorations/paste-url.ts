// Pasting a URL or an email address. Over a selection, a small popup offers to
// wrap the selection as a Typst `#link()` or replace it with the address as
// plain text. Pasted at the caret, or with Ctrl+Shift+V (the plain-text paste),
// the address goes in as plain text without a prompt.
//
// Plain text is the address as Typst markup shows it as written. Bare `http://`
// and `https://` URLs stay bare, and Typst itself shows them as links. Anything
// else is escaped where markup would read it as syntax: the `//` after another
// scheme (`zotero://`, `inkycap://`, …) would start a comment, and the `@` of
// an email address would start a reference, so `athena@inkycap.org` goes in
// as `athena\@inkycap.org`.

import { EditorView } from "@codemirror/view";
import { positionPopupAtAnchor } from "./popup-position";
import { t } from "../../lib/i18n";
import { typstMarkupEscape, typstStringEscape } from "../../lib/typst";
import { startsWithSchemeAndSlashes } from "../../lib/open-link";
import { pastedText } from "./clipboard-source";

/** A `mailto:` address, which has no `//` after its scheme. */
const MAILTO_RE = /^mailto:\S+$/i;
/** A bare email address. */
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[^\s@]+\.[^\s@]+$/;
/** URLs that Typst markup turns into a link on its own. */
const MARKUP_URL_RE = /^https?:\/\//i;

/** The markup for a pasted address as plain text: bare for an http(s) URL,
 *  otherwise escaped so no part of it reads as Typst syntax. */
export function plainAddressMarkup(text: string): string {
  return MARKUP_URL_RE.test(text) ? text : typstMarkupEscape(text);
}

// Whether the next paste was started by Ctrl+Shift+V. The paste event doesn't
// say which shortcut triggered it, so the key press is noted here and the next
// paste reads and clears it. Any other key press or a click clears it too.
let plainPasteRequested = false;

/** Notes Ctrl+Shift+V (Cmd+Shift+V on macOS), so the paste it starts goes in
 *  as plain text even over a selection. */
export const plainPasteShortcut = EditorView.domEventHandlers({
  keydown(event) {
    plainPasteRequested =
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "v";
    return false;
  },
  mousedown() {
    plainPasteRequested = false;
    return false;
  },
});

let popup: HTMLElement | null = null;
let activeView: EditorView | null = null;

function getPopup(): HTMLElement {
  if (!popup) {
    popup = document.createElement("div");
    popup.className = "paste-url-menu";
    popup.style.display = "none";
    document.body.appendChild(popup);
  }
  return popup;
}

function hidePopup() {
  const el = getPopup();
  el.style.display = "none";
  el.innerHTML = "";
  activeView = null;
}

function showMenu(view: EditorView, url: string, plainText: string, selectedText: string) {
  const el = getPopup();
  activeView = view;
  el.innerHTML = "";

  const header = document.createElement("div");
  header.className = "paste-url-menu__header";
  header.textContent = t("pasteUrl.header");
  el.appendChild(header);

  const items: { label: string; action: () => void }[] = [
    {
      label: t("pasteUrl.link"),
      action: () => {
        hidePopup();
        const { from, to } = view.state.selection.main;
        const target = `#link("${typstStringEscape(url)}")`;
        const insert = selectedText ? `${target}[${selectedText}]` : target;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
        view.focus();
      },
    },
    {
      label: t("pasteUrl.plainText"),
      action: () => {
        hidePopup();
        const { from, to } = view.state.selection.main;
        // Replace the selection with the address itself, with no label.
        const insert = plainText;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
        view.focus();
      },
    },
  ];

  for (let i = 0; i < items.length; i++) {
    const row = document.createElement("div");
    row.className = "paste-url-menu__item";
    if (i === 0) row.classList.add("is-selected");
    row.textContent = items[i].label;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      items[i].action();
    });
    el.appendChild(row);
  }

  const coords = view.coordsAtPos(view.state.selection.main.from);
  if (coords) {
    positionPopupAtAnchor(el, coords);
  } else {
    el.style.display = "block";
  }

  // Track selected index for keyboard navigation.
  let selectedIndex = 0;
  const rows = el.querySelectorAll<HTMLElement>(".paste-url-menu__item");

  function updateSelection(idx: number) {
    rows.forEach((r, i) => r.classList.toggle("is-selected", i === idx));
    selectedIndex = idx;
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown"
        ? (selectedIndex + 1) % items.length
        : (selectedIndex - 1 + items.length) % items.length;
      updateSelection(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      cleanup();
      items[selectedIndex].action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      hidePopup();
      view.focus();
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (!el.contains(e.target as Node)) {
      cleanup();
      hidePopup();
    }
  }

  function cleanup() {
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("mousedown", handleClickOutside, true);
  }

  document.addEventListener("keydown", handleKey, true);
  document.addEventListener("mousedown", handleClickOutside, true);
}

/** Is the caret sitting inside the URL string of a `#link("…")` call?
 *  True for the Ctrl+K scenario (`#link("⎸")[label]`) and any partially-typed
 *  link URL. We look for an open `#link("` on the caret's line with no closing
 *  quote between it and the caret. */
function isInsideLinkUrlSlot(view: EditorView): boolean {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const before = view.state.doc.sliceString(line.from, from);
  return /#link\("[^"]*$/.test(before);
}

export function pasteUrlHandler(event: ClipboardEvent, view: EditorView): boolean {
  const plainOnly = plainPasteRequested;
  plainPasteRequested = false;
  const text = pastedText(event).trim();
  // A pasted URL: any scheme followed by `://`, `mailto:`, or a bare email
  // address, with no whitespace.
  if (!text || /\s/.test(text)) return false;
  const isEmail = EMAIL_RE.test(text);
  if (!isEmail && !startsWithSchemeAndSlashes(text) && !MAILTO_RE.test(text)) return false;
  const url = isEmail ? `mailto:${text}` : text;

  event.preventDefault();

  const { from, to } = view.state.selection.main;

  // Caret already inside a `#link("…")` URL slot (e.g. after Ctrl+K): drop the
  // URL straight into the string — no `#link()` wrapper and no extra quotes,
  // which would otherwise nest a second link and double the quotes. No popup:
  // the user already committed to a link, they're just filling in the address.
  if (isInsideLinkUrlSlot(view)) {
    const insert = typstStringEscape(url);
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    view.focus();
    return true;
  }

  // Pasting at the caret, or a plain-text paste: insert the address as text.
  // A link is made by pasting over the text to show, or with Ctrl+K.
  const plainText = plainAddressMarkup(text);
  if (from === to || plainOnly) {
    view.dispatch({
      changes: { from, to, insert: plainText },
      selection: { anchor: from + plainText.length },
    });
    view.focus();
    return true;
  }

  // Pasting over a selection: genuinely ambiguous — "Link" wraps the selected
  // text as the link label, "Plain text" replaces it with the URL. Offer the
  // choice.
  const selectedText = view.state.doc.sliceString(from, to);
  showMenu(view, url, plainText, selectedText);
  return true;
}
