import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { pasteUrlHandler, plainPasteShortcut } from "./paste-url";
import { typstLanguage } from "../typst-language";

// The "Link or plain text?" prompt only matters when pasting over a selection
// (use as label, or replace). Pasted at the caret, or with Ctrl+Shift+V, an
// address goes in as plain text without asking.

const URL = "https://example.test/page";

function mk(doc: string, anchor: number, head = anchor) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [plainPasteShortcut],
    }),
    parent: document.body,
  });
}

function pressPlainPasteKey(v: EditorView) {
  v.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, bubbles: true }),
  );
}

/** The names of the syntax nodes Typst's parser makes of `doc`. */
function nodeNames(doc: string): Set<string> {
  const state = EditorState.create({ doc, extensions: [typstLanguage()] });
  const names = new Set<string>();
  syntaxTree(state).iterate({ enter: (n) => void names.add(n.name) });
  return names;
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

  // Typst reads `//` after any scheme but http(s) as a comment and `@` as a
  // reference, so those are escaped in the plain-text form.
  it.each([
    ["inkycap://open?notebox=Notes&file=a.typ", "inkycap:\\//open?notebox=Notes&file=a.typ"],
    ["zotero://select/library/items/ABC123", "zotero:\\//select/library/items/ABC123"],
    ["ftp://files.example.test/x.txt", "ftp:\\//files.example.test/x.txt"],
    ["some-future-app+v2://thing", "some-future-app+v2:\\//thing"],
    ["mailto:athena@inkycap.org", "mailto:athena\\@inkycap.org"],
    ["athena@inkycap.org", "athena\\@inkycap.org"],
  ])("pastes %s as plain text into blank space", (url, expected) => {
    const v = mk("foo ", 4);
    expect(pasteUrlHandler(pasteEvent(url), v)).toBe(true);
    expect(v.state.doc.toString()).toBe(`foo ${expected}`);
    expect(v.state.selection.main.head).toBe(4 + expected.length);
    expect(visibleMenu()).toBeNull();
    v.destroy();
  });

  // The escaped form must read as text only: no comment hiding the rest, and no
  // link, reference, label, code or emphasis made of its characters.
  it.each([
    "zotero://select/library/items/ABC123#frag",
    "obsidian://open?vault=V&file=[N]",
    "app://a//b/*c*/d_e_f",
    "x-app://v-1--2...$m$~'q'\"r\"<l>",
    "mailto:athena_otlet@inkycap.org",
    "app://ends-with/",
  ])("escapes %s so Typst reads it as plain text", (url) => {
    const v = mk("", 0);
    pasteUrlHandler(pasteEvent(url), v);
    const names = nodeNames(v.state.doc.toString());
    for (const syntax of [
      "LineComment", "BlockComment", "Link", "Ref", "Label", "Hash", "Equation", "Error",
      "Strong", "Emph", "Shorthand", "SmartQuote", "ContentBlock", "TermItem",
    ]) {
      expect(names.has(syntax), syntax).toBe(false);
    }
    v.destroy();
  });

  it("pastes over a selection as plain text, with no prompt, after Ctrl+Shift+V", () => {
    const v = mk("foo bar baz", 4, 7);
    pressPlainPasteKey(v);
    pasteUrlHandler(pasteEvent("athena@inkycap.org"), v);
    expect(v.state.doc.toString()).toBe("foo athena\\@inkycap.org baz");
    expect(visibleMenu()).toBeNull();
    v.destroy();
  });

  it("forgets Ctrl+Shift+V once another key is pressed", () => {
    const v = mk("foo bar baz", 4, 7);
    pressPlainPasteKey(v);
    v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    pasteUrlHandler(pasteEvent(URL), v);
    expect(visibleMenu()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    v.destroy();
  });

  it("wraps the selection as the label when Link is chosen", () => {
    const v = mk("foo bar baz", 4, 7);
    pasteUrlHandler(pasteEvent("athena@inkycap.org"), v);
    const rows = visibleMenu()!.querySelectorAll<HTMLElement>(".paste-url-menu__item");
    rows[0].dispatchEvent(new MouseEvent("mousedown")); // "Link"
    expect(v.state.doc.toString()).toBe('foo #link("mailto:athena@inkycap.org")[bar] baz');
    v.destroy();
  });

  it("offers the escaped address as the plain-text form of a pasted email", () => {
    const v = mk("foo bar baz", 4, 7);
    pasteUrlHandler(pasteEvent("athena@inkycap.org"), v);
    const rows = visibleMenu()!.querySelectorAll<HTMLElement>(".paste-url-menu__item");
    rows[1].dispatchEvent(new MouseEvent("mousedown")); // "Plain text"
    expect(v.state.doc.toString()).toBe("foo athena\\@inkycap.org baz");
    v.destroy();
  });

  it("escapes quotes and backslashes when wrapping a URL in #link", () => {
    const v = mk("foo bar baz", 4, 7);
    pasteUrlHandler(pasteEvent('zotero://a"b\\c'), v);
    const rows = visibleMenu()!.querySelectorAll<HTMLElement>(".paste-url-menu__item");
    rows[0].dispatchEvent(new MouseEvent("mousedown")); // "Link"
    expect(v.state.doc.toString()).toBe('foo #link("zotero://a\\"b\\\\c")[bar] baz');
    v.destroy();
  });

  it("offers the escaped form for a custom scheme pasted over a selection", () => {
    const v = mk("foo bar baz", 4, 7);
    pasteUrlHandler(pasteEvent("inkycap://open?notebox=N&zid=1"), v);
    const rows = visibleMenu()!.querySelectorAll<HTMLElement>(".paste-url-menu__item");
    rows[1].dispatchEvent(new MouseEvent("mousedown")); // "Plain text"
    expect(v.state.doc.toString()).toBe("foo inkycap:\\//open?notebox=N&zid=1 baz");
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
