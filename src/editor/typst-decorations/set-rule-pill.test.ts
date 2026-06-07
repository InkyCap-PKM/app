import { describe, it, expect } from "vitest";
import { setRuleLabel } from "./visual-plugin";

// A standalone `#set` / `#show` rule (one dropped mid-document, e.g. from the
// `/` Style menu) renders as a pill in the visual editor. `setRuleLabel`
// derives that pill's chip text from the rule's source: the keyword plus its
// target, kept literal so it mirrors the raw Typst the way every other pill
// shows its `funcName`. These pin that derivation.
describe("setRuleLabel", () => {
  it("names the property so two same-target rules read distinctly", () => {
    // The motivating case: both are `#set text(…)` but configure different fields.
    expect(setRuleLabel('#set text(font: "EB Garamond")')).toBe("set text: font");
    expect(setRuleLabel("#set text(size: 12pt)")).toBe("set text: size");
  });

  it("works the same for every Style-menu setting (page / par / heading)", () => {
    expect(setRuleLabel('#set page(paper: "a4")')).toBe("set page: paper");
    expect(setRuleLabel("#set par(leading: 0.65em)")).toBe("set par: leading");
    expect(setRuleLabel("#set par(first-line-indent: 1em)")).toBe("set par: first-line-indent");
    expect(setRuleLabel('#set heading(numbering: "1.1")')).toBe("set heading: numbering");
  });

  it("shows only top-level keys, not nested ones, and tolerates string literals", () => {
    // `margin: (top: …, bottom: …)` — only `margin` is the property; the inner
    // keys live at a deeper nesting level and a `:` inside a quoted value is opaque.
    expect(setRuleLabel("#set page(margin: (top: 2cm, bottom: 2cm, left: 2cm, right: 2cm))"))
      .toBe("set page: margin");
    expect(setRuleLabel('#set text(lang: "fr", region: "CA")')).toBe("set text: lang, region");
  });

  it("caps the shown keys at two with an ellipsis", () => {
    expect(setRuleLabel("#set page(paper: \"a4\", columns: 2, numbering: \"1\")"))
      .toBe("set page: paper, columns…");
  });

  it("falls back to keyword + target when there is no recognizable key", () => {
    expect(setRuleLabel("#set text()")).toBe("set text");
  });

  it("labels a show rule with its selector target", () => {
    expect(setRuleLabel("#show heading: it => it")).toBe("show heading");
    expect(setRuleLabel('#show raw: set text(font: "Fira Code")')).toBe("show raw");
  });

  it("matches the hash-less form (a sliced SetRule syntax node)", () => {
    // The `#` is a separate token, so the node range starts at the keyword.
    expect(setRuleLabel("set text(size: 12pt)")).toBe("set text: size");
  });

  it("handles a dotted target path", () => {
    expect(setRuleLabel("#set text.par(leading: 1em)")).toBe("set text.par: leading");
  });

  it("falls back to the bare keyword for a target-less show-everything rule", () => {
    expect(setRuleLabel("#show: rest => columns(2, rest)")).toBe("show");
  });

  it("defaults to `set` when the source is unrecognizable", () => {
    expect(setRuleLabel("#somethingelse(x)")).toBe("set");
  });
});
