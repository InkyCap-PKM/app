// Paste-as-URL extension — when the user pastes a URL, shows a small
// popup offering to insert it as a Typst #link() or as plain text.
// If text is selected, "Link" wraps the selection as the display text.

import { EditorView } from "@codemirror/view";

const URL_RE = /^https?:\/\/\S+$/;

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

function showMenu(view: EditorView, url: string, selectedText: string) {
  const el = getPopup();
  activeView = view;
  el.innerHTML = "";

  const header = document.createElement("div");
  header.className = "paste-url-menu__header";
  header.textContent = "Paste as";
  el.appendChild(header);

  const items: { label: string; action: () => void }[] = [
    {
      label: "Link",
      action: () => {
        hidePopup();
        const { from, to } = view.state.selection.main;
        let insert: string;
        let anchor: number;
        if (selectedText) {
          insert = `#link("${url}")[${selectedText}]`;
          anchor = from + insert.length;
        } else {
          insert = `#link("${url}")`;
          anchor = from + insert.length;
        }
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor },
        });
        view.focus();
      },
    },
    {
      label: "Plain text",
      action: () => {
        hidePopup();
        const { from, to } = view.state.selection.main;
        // Insert the URL verbatim — just the text, no wrapping. The user asked
        // for plain text, so they decide how (or whether) to style it.
        view.dispatch({
          changes: { from, to, insert: url },
          selection: { anchor: from + url.length },
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
    const spaceBelow = window.innerHeight - coords.bottom - 8;
    const placeAbove = spaceBelow < 100 && coords.top > 100;
    el.style.left = `${Math.min(coords.left, window.innerWidth - 200)}px`;
    el.style.top = placeAbove
      ? `${coords.top - 80}px`
      : `${coords.bottom + 4}px`;
  }
  el.style.display = "block";

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
  if (!text || !URL_RE.test(text)) return false;

  event.preventDefault();

  const { from, to } = view.state.selection.main;

  // Caret already inside a `#link("…")` URL slot (e.g. after Ctrl+K): drop the
  // bare URL straight in — no `#link()` wrapper and no extra quotes, which
  // would otherwise nest a second link and double the quotes. No popup: the
  // user already committed to a link, they're just filling in the address.
  if (isInsideLinkUrlSlot(view)) {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
    return true;
  }

  // Otherwise offer the choice — including when pasting over a selection, where
  // "Link" wraps the selected text as the link label.
  const selectedText = from !== to ? view.state.doc.sliceString(from, to) : "";
  showMenu(view, text, selectedText);
  return true;
}
