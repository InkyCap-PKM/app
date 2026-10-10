import { describe, it, expect, afterEach } from "vitest";
import { EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import {
  search,
  openSearchPanel,
  closeSearchPanel,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";
import { searchMatchHighlight, setSearchMatches } from "./search-matches";
import { hiddenMatchPills } from "./hidden-match-pills";
import { SetRuleWidget } from "./visual-widgets";
import { runEditSource } from "./pill";
import { HIGHLIGHT_ALL_CLASS } from "../search-panel";
import { typst } from "codemirror-lang-typst";
import { findNext } from "@codemirror/search";
import { typstVisualMode } from "./visual-plugin";

// A pill that replaces its source must show a search match hidden in that
// source, since the match's own mark lands on text nobody can see.

const RULE = '#set text(lang: "fr")';
const DOC = `Before.\n${RULE}\nAfter, with text.`;
const RULE_FROM = DOC.indexOf(RULE);
const RULE_TO = RULE_FROM + RULE.length;

/** Draws the rule as a pill, as the visual editor does. */
const rulePill = StateField.define({
  create: () =>
    Decoration.set([
      Decoration.replace({
        widget: new SetRuleWidget(RULE_FROM, RULE_TO, "set text", RULE),
      }).range(RULE_FROM, RULE_TO),
    ]),
  update: (deco) => deco,
  provide: (f) => EditorView.decorations.from(f),
});

let view: EditorView | null = null;

function mount(): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      extensions: [rulePill, search(), searchMatchHighlight, hiddenMatchPills],
    }),
  });
  return view;
}

/** Let CodeMirror draw and run the plugin's repaint. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
}

function pill(v: EditorView): HTMLElement {
  const el = v.contentDOM.querySelector<HTMLElement>(".cm-typst-pill");
  if (!el) throw new Error("pill not drawn");
  return el;
}

const marked = (v: EditorView) => pill(v).classList.contains("cm-typst-pill--search-match");
const current = (v: EditorView) => pill(v).classList.contains("cm-typst-pill--search-current");

/** A notebox-search match on `word`'s first occurrence at or after `after`. */
function searchMatch(word: string, after: number) {
  const from = DOC.indexOf(word, after);
  const line = DOC.slice(0, from).split("\n").length;
  const lineStart = DOC.lastIndexOf("\n", from - 1) + 1;
  return { line, charStart: from - lineStart, charEnd: from - lineStart + word.length };
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("pills that hide a search match", () => {
  it("marks a pill whose hidden source holds a notebox-search match", async () => {
    const v = mount();
    v.dispatch({ effects: setSearchMatches.of([searchMatch("lang", 0)]) });
    await settle();
    expect(marked(v)).toBe(true);
    expect(current(v)).toBe(false);
  });

  it("leaves the pill alone when the matches are elsewhere", async () => {
    const v = mount();
    v.dispatch({ effects: setSearchMatches.of([searchMatch("text", RULE_TO)]) });
    await settle();
    expect(marked(v)).toBe(false);
  });

  it("clears the mark when the search is cleared", async () => {
    const v = mount();
    v.dispatch({ effects: setSearchMatches.of([searchMatch("lang", 0)]) });
    await settle();
    v.dispatch({ effects: setSearchMatches.of([]) });
    await settle();
    expect(marked(v)).toBe(false);
  });

  it("marks a pill holding the find's current match, and its other matches only with All on", async () => {
    const v = mount();
    openSearchPanel(v);
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "lang" })) });
    await settle();
    // Find marks only its current match unless "All" is on; pills agree.
    expect(marked(v)).toBe(false);

    v.dom.classList.add(HIGHLIGHT_ALL_CLASS);
    v.dispatch({});
    await settle();
    expect(marked(v)).toBe(true);
    expect(current(v)).toBe(false);
    v.dom.classList.remove(HIGHLIGHT_ALL_CLASS);

    // The find panel selects its current match.
    const from = DOC.indexOf("lang");
    v.dispatch({ selection: { anchor: from, head: from + 4 } });
    await settle();
    expect(marked(v)).toBe(true);
    expect(current(v)).toBe(true);

    closeSearchPanel(v);
    await settle();
    expect(marked(v)).toBe(false);
    expect(current(v)).toBe(false);
  });
});

describe("revealing a pill's source", () => {
  const model = { funcName: "set text", callFrom: RULE_FROM, callTo: RULE_TO };

  it("keeps a selection that sits in the hidden source, such as Find's current match", () => {
    const v = mount();
    const from = DOC.indexOf("lang");
    v.dispatch({ selection: { anchor: from, head: from + 4 } });
    runEditSource(v, model);
    expect(v.state.selection.main.from).toBe(from);
    expect(v.state.selection.main.to).toBe(from + 4);
  });

  it("puts the caret at the call's start when nothing is selected inside it", () => {
    const v = mount();
    v.dispatch({ selection: { anchor: 0 } });
    runEditSource(v, model);
    expect(v.state.selection.main.empty).toBe(true);
    expect(v.state.selection.main.head).toBe(RULE_FROM + 1);
  });

  it("keeps Find's current match highlighted when an annotation pill is clicked", async () => {
    const doc = 'Some prose #annotation(on: "2026-09-30")[a secret word] more prose.';
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [typst(), typstVisualMode(), search()],
      }),
    });
    const v = view;
    await settle();
    openSearchPanel(v);
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "secret" })) });
    findNext(v);
    await settle();
    pill(v).click();
    await settle();
    const from = doc.indexOf("secret");
    expect([v.state.selection.main.from, v.state.selection.main.to]).toEqual([from, from + 6]);
    expect(v.contentDOM.querySelectorAll(".cm-searchMatch-selected")).toHaveLength(1);
  });
});
