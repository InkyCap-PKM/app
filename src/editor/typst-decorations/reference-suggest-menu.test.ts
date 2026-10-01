import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import { referenceSuggest } from "./reference-suggest";

vi.mock("../../lib/ipc", () => ({
  getBibliographyEntries: async () => [
    { key: "smith2020", title: "Rivers", authors: ["Smith"], year: "2020", entry_type: "article" },
  ],
}));

// The `@` menu opens after a word as well as after a space, since
// `results@smith2020` may be a citation placed against the text. Below the
// matches it offers "E-mail address" and "Plain text". Those are never selected
// by default, so with no match Enter goes on to the editor.

/** An editor with the caret at the end of `doc`, placed there by a selection
 *  change the way typing would, so the menu looks at it. */
function mk(doc: string) {
  const v = new EditorView({
    state: EditorState.create({ doc, extensions: [typst(), referenceSuggest] }),
    parent: document.body,
  });
  v.dispatch({ selection: { anchor: doc.length } });
  return v;
}

/** Let the menu's deferred open and its bibliography fetch finish. */
async function settle() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => setTimeout(r, 0));
}

function menu(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(".wikilink-suggest");
  return el && el.style.display !== "none" ? el : null;
}

const rowNames = () =>
  [...menu()!.querySelectorAll(".wikilink-suggest__item .wikilink-suggest__name")].map((r) => r.textContent);
const selectedRow = () => menu()!.querySelector(".wikilink-suggest__item.is-selected");
const press = (view: EditorView, key: string) =>
  runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
const clickRow = (name: string) => {
  const row = [...menu()!.querySelectorAll<HTMLElement>(".wikilink-suggest__item")].find(
    (r) => r.querySelector(".wikilink-suggest__name")?.textContent === name,
  );
  row!.dispatchEvent(new MouseEvent("mousedown"));
};

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

describe("the @ menu after a word", () => {
  it("offers citations, with the first one selected", async () => {
    view = mk("results@smi");
    await settle();
    expect(rowNames()).toEqual(["Rivers", "E-mail address", "Plain text"]);
    expect(selectedRow()?.textContent).toContain("Rivers");
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("results@smith2020");
  });

  it("selects nothing when nothing matches, so Enter goes on to the editor", async () => {
    view = mk("joshua@phydeau.org");
    await settle();
    expect(rowNames()).toEqual(["E-mail address", "Plain text"]);
    expect(selectedRow()).toBeNull();
    expect(press(view, "Enter")).toBe(false);
    expect(menu()).toBeNull();
  });

  it("reaches the extra rows with the arrow keys", async () => {
    view = mk("joshua@phydeau.org");
    await settle();
    press(view, "ArrowDown");
    expect(selectedRow()?.textContent).toContain("E-mail address");
  });

  it("writes an email link with the caret at the end of the address", async () => {
    view = mk("joshua@phy");
    await settle();
    clickRow("E-mail address");
    const doc = view.state.doc.toString();
    expect(doc).toBe('#link("mailto:joshua@phy")');
    expect(view.state.selection.main.head).toBe(doc.length - 2);
  });

  it("escapes the @ for plain text", async () => {
    view = mk("joshua@phy");
    await settle();
    clickRow("Plain text");
    expect(view.state.doc.toString()).toBe("joshua\\@phy");
    expect(view.state.selection.main.head).toBe("joshua\\@phy".length);
  });
});

describe("the @ menu after a space", () => {
  it("offers plain text but not an email address, for a handle like @person", async () => {
    view = mk("follow @person");
    await settle();
    expect(rowNames()).toEqual(["Plain text"]);
    clickRow("Plain text");
    expect(view.state.doc.toString()).toBe("follow \\@person");
  });
});
