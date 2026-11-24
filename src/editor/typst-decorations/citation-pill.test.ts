import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typst } from "codemirror-lang-typst";
import {
  CitationWidget,
  citationOptions,
  citationPillLabel,
  liveCitationRange,
  parseCitation,
  shorthandCitationEnd,
  withForm,
  withSupplement,
} from "./citation-pill";
import { buildDecorations } from "./visual-plugin";

// The bibliography holds `otlet1934`, so citations to it resolve.
vi.mock("./reference-suggest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reference-suggest")>()),
  getCachedBibKeys: () => new Set(["otlet1934"]),
}));

// Citations render as one pill whose menu sets the page (Typst's supplement)
// and the form. The source keeps the writer's form: `@key[…]` stays shorthand
// until an option needs `#cite(...)`, and only the touched part changes.

describe("parseCitation", () => {
  it("reads a shorthand citation with a page", () => {
    expect(parseCitation("@otlet1934[p. 64]")).toEqual({
      key: "otlet1934",
      shorthand: true,
      supplement: "p. 64",
      supplementLiteral: "[p. 64]",
      form: null,
    });
  });

  it("reads a #cite call's form and supplement", () => {
    const parts = parseCitation('#cite(<otlet1934>, form: "prose", supplement: [ch. 3])');
    expect(parts).toMatchObject({ key: "otlet1934", shorthand: false, supplement: "ch. 3", form: "prose" });
  });

  it("rejects anything that isn't a citation", () => {
    expect(parseCitation("#strong[x]")).toBeNull();
    expect(parseCitation("@")).toBeNull();
  });
});

describe("withSupplement", () => {
  it("adds, changes and removes a page on a shorthand citation", () => {
    expect(withSupplement("@otlet1934", "p. 64")).toBe("@otlet1934[p. 64]");
    expect(withSupplement("@otlet1934[p. 64]", "pp. 64–70")).toBe("@otlet1934[pp. 64–70]");
    expect(withSupplement("@otlet1934[p. 64]", "  ")).toBe("@otlet1934");
  });

  it("escapes a closing bracket so it can't end the supplement", () => {
    expect(withSupplement("@otlet1934", "see [x]")).toBe("@otlet1934[see [x\\]]");
  });

  it("changes only the supplement argument of a #cite call", () => {
    expect(withSupplement('#cite(<otlet1934>, form: "prose")', "p. 2"))
      .toBe('#cite(<otlet1934>, form: "prose", supplement: [p. 2])');
    expect(withSupplement('#cite(<otlet1934>, supplement: [p. 2], form: "prose")', ""))
      .toBe('#cite(<otlet1934>, form: "prose")');
  });
});

describe("withForm", () => {
  it("turns a shorthand citation into #cite for another form, keeping its page as written", () => {
    expect(withForm("@otlet1934[p. *64*]", "prose"))
      .toBe('#cite(<otlet1934>, form: "prose", supplement: [p. *64*])');
  });

  it("leaves a shorthand citation alone for the normal form", () => {
    expect(withForm("@otlet1934[p. 64]", "normal")).toBe("@otlet1934[p. 64]");
  });

  it("never turns #cite back into shorthand; normal just drops form:", () => {
    expect(withForm('#cite(<otlet1934>, form: "year")', "normal")).toBe("#cite(<otlet1934>)");
  });
});

describe("the pill label", () => {
  it("shows the key and any page", () => {
    expect(citationPillLabel("otlet1934", null)).toBe("@otlet1934");
    expect(citationPillLabel("otlet1934", "p. 64")).toBe("@otlet1934, p. 64");
  });
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

function mount(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [typst()] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

describe("shorthandCitationEnd", () => {
  it("follows Typst's rule for where a key ends", () => {
    expect(shorthandCitationEnd("@otlet1934.", 0)).toBe(10);
    expect(shorthandCitationEnd("@fig:map: see", 0)).toBe(8);
    expect(shorthandCitationEnd("@otlet1934[p. [64\\]]] x", 0)).toBe(21);
    expect(shorthandCitationEnd("@otlet1934[unclosed", 0)).toBe(10);
    expect(shorthandCitationEnd("@ alone", 0)).toBe(0);
  });
});

describe("liveCitationRange", () => {
  it("ends a shorthand citation before the sentence's full stop", () => {
    const doc = "As in @otlet1934.";
    const view = mount(doc);
    const at = doc.indexOf("@");
    expect(liveCitationRange(view, at)).toEqual({ from: at, to: doc.length - 1 });
  });

  it("includes a supplement", () => {
    const doc = "See @otlet1934[p. 64] here";
    const view = mount(doc);
    const at = doc.indexOf("@");
    expect(liveCitationRange(view, at)).toEqual({ from: at, to: doc.indexOf(" here") });
  });
});

describe("the citation pill's menu", () => {
  it("sets the page through the supplement field", () => {
    const doc = "See @otlet1934 here.";
    const view = mount(doc);
    const at = doc.indexOf("@");
    const field = citationOptions(view, at)[0].items[0];
    field.input!.onCommit("p. 64");
    expect(view.state.doc.toString()).toBe("See @otlet1934[p. 64] here.");
  });

  it("applies a later option to the citation as it is after an earlier one", () => {
    const doc = "See @otlet1934 here.";
    const view = mount(doc);
    const at = doc.indexOf("@");
    // Both options come from one menu opened before either change.
    const [pageSection, formSection] = citationOptions(view, at);
    pageSection.items[0].input!.onCommit("p. 64");
    formSection.items.find((i) => i.isActive === false && i.label)!.onSelect!();
    expect(view.state.doc.toString())
      .toBe('See #cite(<otlet1934>, form: "prose", supplement: [p. 64]) here.');
  });
});

/** The widgets replacing the `@…` or `#cite` span of `doc`, with the caret at
 *  the start of the document. */
function citationWidgets(doc: string): CitationWidget[] {
  const state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [typst()] });
  const found: CitationWidget[] = [];
  buildDecorations(state).between(0, doc.length, (_from, _to, value) => {
    const widget = value.spec?.widget;
    if (widget instanceof CitationWidget) found.push(widget);
  });
  return found;
}

describe("citations in the visual editor", () => {
  it("shows a citation with a page as one pill, not as a broken reference", () => {
    const [pill] = citationWidgets("x See @otlet1934[p. 64] here.");
    expect(pill).toMatchObject({ key: "otlet1934", supplement: "p. 64" });
  });

  it("shows #cite(...) as the same pill", () => {
    const widgets = citationWidgets('x See #cite(<otlet1934>, supplement: [p. 2]) here.');
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ key: "otlet1934", supplement: "p. 2" });
  });
});
