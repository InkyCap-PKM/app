import { describe, it, expect } from "vitest";
import { headingDisplayText } from "./heading-tracker";

// The outline pane must show a heading's *content text*, never its Typst
// markup. `headingDisplayText` is the lexical cleanup that turns a heading's
// raw source (everything after the `=` markers) into that reader-facing text.
describe("headingDisplayText", () => {
  it("leaves plain headings untouched", () => {
    expect(headingDisplayText("InkyCap Documentation")).toBe("InkyCap Documentation");
  });

  it("renders a wikilink heading as its target", () => {
    expect(headingDisplayText('#wikilink("Getting Started")')).toBe("Getting Started");
  });

  it("uses a wikilink's display alias when present", () => {
    expect(headingDisplayText('#wikilink("getting-started", display: "Getting Started")'))
      .toBe("Getting Started");
  });

  it("ignores a wikilink's label arg (target still shows)", () => {
    expect(headingDisplayText('#wikilink("Guide", label: "intro")')).toBe("Guide");
  });

  it("renders a link's bracket text, or its URL when bare", () => {
    expect(headingDisplayText('#link("https://typst.app")[Typst]')).toBe("Typst");
    expect(headingDisplayText('#link("https://typst.app")')).toBe("https://typst.app");
  });

  it("strips bold, italic, highlight, strike, and emphasis wrappers", () => {
    expect(headingDisplayText("*Important*")).toBe("Important");
    expect(headingDisplayText("_Aside_")).toBe("Aside");
    expect(headingDisplayText("#highlight[Key idea]")).toBe("Key idea");
    expect(headingDisplayText("#strike[Old name]")).toBe("Old name");
    expect(headingDisplayText("#strong[Bold]")).toBe("Bold");
    expect(headingDisplayText("#emph[Soft]")).toBe("Soft");
    expect(headingDisplayText("`code`")).toBe("code");
  });

  it("handles a content call carrying arguments", () => {
    expect(headingDisplayText('#text(fill: red)[Warning]')).toBe("Warning");
  });

  it("unwraps nested markup from the inside out", () => {
    expect(headingDisplayText("#strong[#highlight[Critical]]")).toBe("Critical");
    expect(headingDisplayText("#highlight[a *bold* word]")).toBe("a bold word");
  });

  it("cleans a mix of markup in one heading", () => {
    expect(
      headingDisplayText('#wikilink("API") reference — *required*'),
    ).toBe("API reference — required");
  });

  it("collapses whitespace left behind and trims", () => {
    expect(headingDisplayText("  Spaced   out  ")).toBe("Spaced out");
  });
});
