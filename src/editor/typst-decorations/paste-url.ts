// Paste-as-URL extension — when the user pastes a URL *over a selection*,
// shows a small popup offering to wrap the selection as a Typst #link() or
// replace it with the URL as plain text. With a collapsed cursor (pasting
// into blank space) there is no ambiguity, so the URL goes in as a bare link
// without a prompt.
//
// Typst's markup only reads bare `http://` and `https://` text as a link. Any
// other scheme (`inkycap://`, `zotero://`, `obsidian://`, `ftp://`, …) would
// have its `//` read as the start of a comment, so those URLs are pasted as a
// `#link("…")` call instead, which Typst accepts for every scheme. A `mailto:`
// address is too: it has no `//`, but its `@` would be read as a reference.
// A bare email address becomes a `mailto:` link for the same reason; its
// plain-text form is the escaped `joshua\@phydeau.org`.

import { EditorView } from "@codemirror/view";
import { positionPopupAtAnchor } from "./popup-position";
import { t } from "../../lib/i18n";
import { typstStringEscape } from "../../lib/typst";
import { startsWithSchemeAndSlashes } from "../../lib/open-link";

/** A `mailto:` address, which has no `//` after its scheme. */
const MAILTO_RE = /^mailto:\S+$/i;
/** A bare email address. */
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[^\s@]+\.[^\s@]+$/;
/** URLs that Typst markup turns into a link on its own. */
const MARKUP_URL_RE = /^https?:\/\//i;

/** The markup for a URL shown as itself: bare when Typst reads it as a link
 *  unaided, otherwise a `#link("…")` call. */
export function bareUrlMarkup(url: string): string {
  return MARKUP_URL_RE.test(url) ? url : `#link("${typstStringEscape(url)}")`;
}

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
  const text = event.clipboardData?.getData("text/plain")?.trim();
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

  // Pasting into blank space (collapsed cursor): no selection to turn into a
  // link label and nothing to replace, so the "Link or plain text?" question
  // has no meaningful answer. Insert the URL as a bare link, no popup.
  if (from === to) {
    const insert = bareUrlMarkup(url);
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    view.focus();
    return true;
  }

  // Pasting over a selection: genuinely ambiguous — "Link" wraps the selected
  // text as the link label, "Plain text" replaces it with the URL. Offer the
  // choice.
  const selectedText = view.state.doc.sliceString(from, to);
  const plainText = isEmail ? text.replace("@", "\\@") : bareUrlMarkup(url);
  showMenu(view, url, plainText, selectedText);
  return true;
}
