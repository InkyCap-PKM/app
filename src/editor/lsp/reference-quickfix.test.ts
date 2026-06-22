import { describe, it, expect } from "vitest";
import { setRuleForElement, findPreambleEnd, referenceNumberingActions } from "./reference-quickfix";

describe("setRuleForElement", () => {
  it("numbers headings as 1.", () => {
    expect(setRuleForElement("heading")).toBe('#set heading(numbering: "1.")');
  });

  it("routes equations through math.equation", () => {
    expect(setRuleForElement("equation")).toBe('#set math.equation(numbering: "(1)")');
  });
});

describe("findPreambleEnd", () => {
  it("returns 0 when the document opens straight into body", () => {
    expect(findPreambleEnd("Hello @intro world")).toBe(0);
  });

  it("skips an import line", () => {
    const doc = '#import "/.inkycap/packages/inkycap-notebox/1.0.0/lib.typ": *\nBody @intro';
    // Insertion point is the start of the "Body" line.
    expect(doc.slice(findPreambleEnd(doc))).toBe("Body @intro");
  });

  it("skips a multi-line #note(...) block after imports", () => {
    const doc = [
      '#import "/lib.typ": *',
      "#note(",
      '  title: "Scratch",',
      ")",
      "First paragraph @intro",
    ].join("\n");
    expect(doc.slice(findPreambleEnd(doc))).toBe("First paragraph @intro");
  });

  it("skips blank lines and comments", () => {
    const doc = "// a note\n\n#import \"/lib.typ\": *\n\nbody";
    expect(doc.slice(findPreambleEnd(doc))).toBe("body");
  });
});

describe("referenceNumberingActions", () => {
  it("returns no actions for an unrelated message", () => {
    expect(referenceNumberingActions("unknown variable foo")).toBeUndefined();
  });

  it("offers enable + text-link for a heading reference", () => {
    const actions = referenceNumberingActions("cannot reference heading without numbering");
    expect(actions).toBeDefined();
    expect(actions!).toHaveLength(2);
  });

  it("offers only enable-numbering for an equation reference", () => {
    const actions = referenceNumberingActions("error: cannot reference equation without numbering");
    expect(actions).toBeDefined();
    expect(actions!).toHaveLength(1);
  });
});
