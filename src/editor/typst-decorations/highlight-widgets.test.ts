import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";
import { buildDecorations } from "./visual-plugin";
import { EditorView } from "@codemirror/view";
import { WikilinkWidget, LinkWidget, CalloutBlockWidget } from "./widgets";
import { highlightInlineStyle } from "./visual-colors";

// A wikilink or an external link renders as a replace widget, and CodeMirror
// draws a replace widget outside any mark decoration spanning it — so the
// highlight painted over the surrounding text never reached the link. The
// widget therefore carries the highlight's own styling and paints itself.

/** The first wikilink/link widget in the decoration set for `doc`, built with
 *  the caret parked on a trailing line so nothing is revealed as raw source. */
function linkWidget(doc: string): WikilinkWidget | LinkWidget | null {
  const full = `${doc}\n\ntrailing`;
  const state = EditorState.create({
    doc: full,
    selection: { anchor: full.length },
    extensions: [typst()],
  });
  const iter = buildDecorations(state).iter();
  while (iter.value) {
    const widget = iter.value.spec?.widget;
    if (widget instanceof WikilinkWidget || widget instanceof LinkWidget) return widget;
    iter.next();
  }
  return null;
}

describe("a link inside a #highlight[…]", () => {
  it("carries a custom fill through to the wikilink widget", () => {
    const w = linkWidget('#highlight(fill: rgb("#e0c8f0"))[see #wikilink("Note") now]');
    expect(w).toBeInstanceOf(WikilinkWidget);
    expect(w?.highlight).toContain("--hl-violet");
  });

  it("paints the fill onto the widget's element, over the default class", () => {
    const w = linkWidget('#highlight(fill: rgb("#ff9f97"))[see #wikilink("Note") now]');
    const el = w!.toDOM() as HTMLElement;
    expect(el.classList.contains("cm-typst-highlight")).toBe(true);
    expect(el.style.backgroundColor).toContain("--hl-red");
  });

  it("carries a custom fill through to an external link widget", () => {
    const w = linkWidget('#highlight(fill: rgb("#b3dfff"))[see #link("https://example.com")[site] now]');
    expect(w).toBeInstanceOf(LinkWidget);
    expect(w?.highlight).toContain("--hl-blue");
  });

  it("marks a link inside a bare #highlight as highlighted with no override", () => {
    // The empty string means "highlighted, default colour" — the shared class
    // paints it, so the widget adds no inline style of its own.
    const w = linkWidget('#highlight[see #wikilink("Note") now]');
    expect(w?.highlight).toBe("");
    const el = w!.toDOM() as HTMLElement;
    expect(el.classList.contains("cm-typst-highlight")).toBe(true);
    expect(el.getAttribute("style") ?? "").not.toContain("background-color");
  });

  it("leaves a link outside any highlight unhighlighted", () => {
    const w = linkWidget('see #wikilink("Note") now');
    expect(w?.highlight).toBeNull();
    const el = w!.toDOM() as HTMLElement;
    expect(el.classList.contains("cm-typst-highlight")).toBe(false);
  });
});

describe("highlightInlineStyle", () => {
  it("pins dark text only when asked, so a link keeps its own colour", () => {
    const args = '#highlight(fill: rgb("#c8f0c8"))[x]';
    expect(highlightInlineStyle(args, true)).toContain("color: #1a1a1a");
    expect(highlightInlineStyle(args, false)).not.toContain("color: #1a1a1a");
  });

  it("returns null for a call with no fill, stroke or radius", () => {
    expect(highlightInlineStyle("#highlight[x]", true)).toBeNull();
  });
});

// Callouts, block quotes and annotations render their body with a second,
// simpler renderer while the caret is away. It paints formatting from a CSS
// class, which alone would show every highlight in the default yellow.

/** The highlight span in a rendered callout whose body is `body`. */
function calloutHighlight(body: string): HTMLElement {
  const view = new EditorView({
    state: EditorState.create({ doc: body }),
    parent: document.body,
  });
  const dom = new CalloutBlockWidget("note", "", "#888888", body, 0, 0).toDOM(view);
  const span = dom.querySelector(".cm-typst-highlight") as HTMLElement;
  view.destroy();
  return span;
}

describe("a highlight inside a rendered callout", () => {
  it("paints the call's own fill", () => {
    const span = calloutHighlight('a #highlight(fill: rgb("#ff9f97"))[hot] b');
    expect(span.style.backgroundColor).toContain("--hl-red");
    expect(span.textContent).toBe("hot");
  });

  it("leaves a bare highlight to the default class", () => {
    const span = calloutHighlight("a #highlight[plain] b");
    expect(span.getAttribute("style") ?? "").not.toContain("background-color");
  });
});
