import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { typst } from "codemirror-lang-typst";
import { urlTyping } from "./url-typing";

// Typst reads `//` after any scheme but http(s) as a comment, so a typed
// `zotero://…` would vanish. The visual editor turns it into a `#link("…")`
// call as the `//` is typed, and `mailto:` likewise (its `@` would otherwise be
// read as a reference). An email address is linked, and a fediverse handle
// escaped, when the word ends. Raw blocks, strings and code are left alone.

function mk(doc: string, anchor = doc.length) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [typst(), history(), urlTyping],
    }),
    parent: document.body,
  });
}

/** Type `text` one character at a time through the input handlers. */
function type(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const handlers = view.state.facet(EditorView.inputHandler);
    const insert = () => view.state.update({ changes: { from, to, insert: ch } });
    if (handlers.some((h) => h(view, from, to, ch, insert))) continue;
    view.dispatch({
      changes: { from, to, insert: ch },
      selection: { anchor: from + ch.length },
      userEvent: "input.type",
    });
  }
}

function pressEnter(view: EditorView) {
  const event = new KeyboardEvent("keydown", { key: "Enter" });
  if (!runScopeHandlers(view, event, "editor")) {
    const pos = view.state.selection.main.head;
    view.dispatch({ changes: { from: pos, insert: "\n" }, selection: { anchor: pos + 1 } });
  }
}

const doc = (v: EditorView) => v.state.doc.toString();
const caret = (v: EditorView) => v.state.selection.main.head;

describe("typing a URL in the visual editor", () => {
  it.each(["zotero", "ftp", "inkycap", "obsidian", "some-app+v2"])(
    "turns %s:// into a #link call with the caret in the address",
    (scheme) => {
      const v = mk("see ");
      type(v, `${scheme}://x/y`);
      expect(doc(v)).toBe(`see #link("${scheme}://x/y")`);
      expect(caret(v)).toBe(doc(v).length - 2);
      v.destroy();
    },
  );

  it("turns mailto: into a #link call", () => {
    const v = mk("");
    type(v, "mailto:joshua@phydeau.org");
    expect(doc(v)).toBe('#link("mailto:joshua@phydeau.org")');
    v.destroy();
  });

  it("links an email address when the word ends with a space", () => {
    const v = mk("Write to ");
    type(v, "joshua.c+notes@phydeau.org now");
    expect(doc(v)).toBe('Write to #link("mailto:joshua.c+notes@phydeau.org") now');
    v.destroy();
  });

  it("links an email address before Enter, leaving sentence punctuation outside", () => {
    const v = mk("Write to (");
    type(v, "joshua@phydeau.org).");
    pressEnter(v);
    expect(doc(v)).toBe('Write to (#link("mailto:joshua@phydeau.org")).\n');
    v.destroy();
  });

  it("undoes an email link to the escaped plain address", () => {
    const v = mk("Write to ");
    type(v, "joshua@phydeau.org ");
    undo(v);
    expect(doc(v)).toBe("Write to joshua\\@phydeau.org ");
    v.destroy();
  });

  it("escapes a fediverse handle instead of linking it", () => {
    const v = mk("Find me at ");
    type(v, "@person@mastodon.social today");
    expect(doc(v)).toBe("Find me at \\@person\\@mastodon.social today");
    v.destroy();
  });

  it.each([
    ["a citation straight after a word", "results@smith2020 ", "results@smith2020 "],
    ["a citation after a space", "see @smith2020 ", "see @smith2020 "],
    ["a lone handle, which reads as a citation", "@person ", "@person "],
    ["an escaped @", "joshua\\@phydeau.org ", "joshua\\@phydeau.org "],
    ["a citation after a CJK word", "参见@smith2020 ", "参见@smith2020 "],
    ["an address still being typed", "joshua@phydeau", "joshua@phydeau"],
  ])("leaves %s alone", (_name, typed, expected) => {
    const v = mk("");
    type(v, typed);
    expect(doc(v)).toBe(expected);
    v.destroy();
  });

  it("leaves a reference to a label in the note alone, even one shaped like a domain", () => {
    const v = mk("= Data <data.raw>\n\n");
    type(v, "table@data.raw ");
    expect(doc(v)).toBe("= Data <data.raw>\n\ntable@data.raw ");
    v.destroy();
  });

  it("leaves an address in inline raw text alone", () => {
    const v = mk("``", 1);
    type(v, "joshua@phydeau.org ");
    expect(doc(v)).toBe("`joshua@phydeau.org `");
    v.destroy();
  });

  it("leaves http and https bare, since Typst links them itself", () => {
    const v = mk("");
    type(v, "https://example.test");
    expect(doc(v)).toBe("https://example.test");
    v.destroy();
  });

  it("does not fire mid-word or on an ordinary colon", () => {
    const v = mk("");
    type(v, "Note: the a:b ratio; xmailto: ");
    expect(doc(v)).toBe("Note: the a:b ratio; xmailto: ");
    v.destroy();
  });

  it.each([
    ["a raw block", "```\n", "\n```", 4],
    ["inline raw", "`", "`", 1],
    ["a string", '#link("', '")', 7],
    ["a code expression", "#let x = (", ")", 10],
  ])("leaves a URL typed in %s alone", (_name, head, tail, at) => {
    const v = mk(head + tail, at);
    type(v, "zotero://x");
    expect(doc(v)).toBe(`${head}zotero://x${tail}`);
    v.destroy();
  });

  it("steps out of the call when a space is typed at the end of the address", () => {
    const v = mk("");
    type(v, "zotero://x more");
    expect(doc(v)).toBe('#link("zotero://x") more');
    v.destroy();
  });

  it("steps out of the call before Enter", () => {
    const v = mk("");
    type(v, "zotero://x");
    pressEnter(v);
    type(v, "next");
    expect(doc(v)).toBe('#link("zotero://x")\nnext');
    v.destroy();
  });

  it("keeps a space inside a link that has its own text", () => {
    const v = mk('#link("zotero://x")[label]', '#link("zotero://x'.length);
    type(v, " ");
    expect(doc(v)).toBe('#link("zotero://x ")[label]');
    v.destroy();
  });

  it("undoes the conversion as its own step, back to the text before the last keystroke", () => {
    const v = mk("see ");
    type(v, "zotero://abc");
    undo(v);
    expect(doc(v)).toBe('see #link("zotero://")');
    undo(v);
    expect(doc(v)).toBe("see zotero:/");
    v.destroy();
  });
});
