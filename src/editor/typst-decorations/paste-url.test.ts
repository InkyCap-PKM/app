import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pasteUrlHandler } from "./paste-url";

// The load-bearing invariant: the "Link or plain text?" prompt is only
// meaningful when pasting *over a selection* (wrap-as-label vs. replace). With
// a collapsed cursor the visual editor renders the bare URL as clickable
// either way, so the paste must go in as plain text with no prompt.

const URL = "https://example.test/page";

function mk(doc: string, anchor: number, head = anchor) {
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor, head } }),
    parent: document.body,
  });
}

function pasteEvent(text: string): ClipboardEvent {
  return {
    clipboardData: { getData: (t: string) => (t === "text/plain" ? text : "") },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
}

// The popup is a module-level singleton; treat it as visible only when shown.
function visibleMenu(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(".paste-url-menu");
  return el && el.style.display !== "none" ? el : null;
}

describe("pasteUrlHandler", () => {
  it("inserts a URL as plain text when pasting into blank space (no prompt)", () => {
    const v = mk("foo ", 4);
    const handled = pasteUrlHandler(pasteEvent(URL), v);
    expect(handled).toBe(true);
    expect(v.state.doc.toString()).toBe("foo " + URL);
    expect(v.state.selection.main.empty).toBe(true);
    expect(v.state.selection.main.head).toBe(4 + URL.length);
    expect(visibleMenu()).toBeNull();
    v.destroy();
  });

  it("prompts when pasting over a selection, leaving the doc unchanged until a choice", () => {
    const v = mk("foo bar baz", 4, 7); // "bar" selected
    const handled = pasteUrlHandler(pasteEvent(URL), v);
    expect(handled).toBe(true);
    expect(v.state.doc.toString()).toBe("foo bar baz"); // awaits Link / Plain text
    expect(visibleMenu()).not.toBeNull();
    // Dismiss the popup before tearing down the (still live) view.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    v.destroy();
  });

  it('drops a bare URL into an open #link("…") slot without a prompt', () => {
    const v = mk('#link("")', '#link("'.length); // caret between the quotes
    const handled = pasteUrlHandler(pasteEvent(URL), v);
    expect(handled).toBe(true);
    expect(v.state.doc.toString()).toBe(`#link("${URL}")`);
    expect(visibleMenu()).toBeNull();
    v.destroy();
  });

  // Typst reads `//` after any scheme but http(s) as a comment, so those URLs
  // must go in as a `#link("…")` call or everything after the colon vanishes.
  it.each([
    "inkycap://open?notebox=Notes&file=a.typ",
    "zotero://select/library/items/ABC123",
    "obsidian://open?vault=V&file=N",
    "ftp://files.example.test/x.txt",
    "some-future-app+v2://thing",
    "mailto:joshua@phydeau.org",
  ])("pastes %s as a #link call into blank space", (url) => {
    const v = mk("foo ", 4);
    expect(pasteUrlHandler(pasteEvent(url), v)).toBe(true);
    const expected = `foo #link("${url}")`;
    expect(v.state.doc.toString()).toBe(expected);
    expect(v.state.selection.main.head).toBe(expected.length);
    expect(visibleMenu()).toBeNull();
    v.destroy();
  });

  it("pastes a bare email address as a mailto: link", () => {
    const v = mk("foo ", 4);
    pasteUrlHandler(pasteEvent("joshua@phydeau.org"), v);
    expect(v.state.doc.toString()).toBe('foo #link("mailto:joshua@phydeau.org")');
    v.destroy();
  });

  it("offers the escaped address as the plain-text form of a pasted email", () => {
    const v = mk("foo bar baz", 4, 7);
    pasteUrlHandler(pasteEvent("joshua@phydeau.org"), v);
    const rows = visibleMenu()!.querySelectorAll<HTMLElement>(".paste-url-menu__item");
    rows[1].dispatchEvent(new MouseEvent("mousedown")); // "Plain text"
    expect(v.state.doc.toString()).toBe("foo joshua\\@phydeau.org baz");
    v.destroy();
  });

  it("escapes quotes and backslashes when wrapping a URL in #link", () => {
    const v = mk("", 0);
    pasteUrlHandler(pasteEvent('zotero://a"b\\c'), v);
    expect(v.state.doc.toString()).toBe('#link("zotero://a\\"b\\\\c")');
    v.destroy();
  });

  it("offers the same #link form for a custom scheme pasted over a selection", () => {
    const v = mk("foo bar baz", 4, 7);
    pasteUrlHandler(pasteEvent("inkycap://open?notebox=N&zid=1"), v);
    const rows = visibleMenu()!.querySelectorAll<HTMLElement>(".paste-url-menu__item");
    rows[1].dispatchEvent(new MouseEvent("mousedown")); // "Plain text"
    expect(v.state.doc.toString()).toBe('foo #link("inkycap://open?notebox=N&zid=1") baz');
    v.destroy();
  });

  it("ignores a non-URL paste", () => {
    const v = mk("foo ", 4);
    const handled = pasteUrlHandler(pasteEvent("just some text"), v);
    expect(handled).toBe(false);
    expect(v.state.doc.toString()).toBe("foo ");
    v.destroy();
  });
});
