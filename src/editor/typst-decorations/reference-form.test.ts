import { describe, it, expect } from "vitest";
import {
  canReferenceWithAt,
  documentNumbersHeadings,
  findPreambleEnd,
  isEmailLikeAt,
  linkReference,
  setRuleForElement,
} from "./reference-form";

describe("setRuleForElement", () => {
  it("numbers headings as 1.", () => {
    expect(setRuleForElement("heading")).toBe('#set heading(numbering: "1.")');
  });

  it("routes equations through math.equation", () => {
    expect(setRuleForElement("equation")).toBe('#set math.equation(numbering: "(1)")');
  });
});

describe("canReferenceWithAt", () => {
  it("never allows @ on a label attached to prose", () => {
    expect(canReferenceWithAt("label", true)).toBe(false);
    expect(canReferenceWithAt("label", false)).toBe(false);
  });

  it("allows @ on figures, tables and equations regardless of heading numbering", () => {
    for (const kind of ["figure", "table", "equation"] as const) {
      expect(canReferenceWithAt(kind, false)).toBe(true);
    }
  });

  it("allows @ on headings only once the document numbers them", () => {
    expect(canReferenceWithAt("heading", false)).toBe(false);
    expect(canReferenceWithAt("heading", true)).toBe(true);
  });
});

describe("documentNumbersHeadings", () => {
  it("is false for a document with no heading rule", () => {
    expect(documentNumbersHeadings("= Intro <intro>\n\nBody @intro\n")).toBe(false);
  });

  it("is true once a numbering rule is present", () => {
    expect(documentNumbersHeadings('#set heading(numbering: "1.")\n= Intro\n')).toBe(true);
  });

  it("reads other heading settings as unnumbered", () => {
    expect(documentNumbersHeadings("#set heading(outlined: false)\n")).toBe(false);
  });

  it("lets a later rule turn numbering back off", () => {
    const doc = '#set heading(numbering: "1.")\ntext\n#set heading(numbering: none)\n';
    expect(documentNumbersHeadings(doc)).toBe(false);
  });
});

describe("linkReference", () => {
  it("builds a link call and points at its display text", () => {
    const link = linkReference("label1", "Make a label");
    expect(link.text).toBe("#link(<label1>)[Make a label]");
    expect(link.text.slice(link.displayFrom, link.displayTo)).toBe("Make a label");
  });

  it("escapes brackets in the display text", () => {
    const link = linkReference("l", "a [b] c");
    expect(link.text).toBe("#link(<l>)[a \\[b\\] c]");
    expect(link.text.slice(link.displayFrom, link.displayTo)).toBe("a \\[b\\] c");
  });
});

describe("findPreambleEnd", () => {
  it("returns 0 when the document opens straight into body", () => {
    expect(findPreambleEnd("Hello @intro world")).toBe(0);
  });

  it("skips an import line", () => {
    const doc = '#import "/.inkycap/packages/inkycap-notebox/1.0.0/lib.typ": *\nBody @intro';
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

// One rule decides whether an `@` is the join of an email address or the start
// of a reference, on every surface that looks at one (the popup, the visual
// pill, and the compile pipeline's escape pass mirrors it in Rust).
describe("isEmailLikeAt", () => {
  it("treats an @ after an ASCII letter or digit as an email", () => {
    expect(isEmailLikeAt("r")).toBe(true);
    expect(isEmailLikeAt("Z")).toBe(true);
    expect(isEmailLikeAt("7")).toBe(true);
  });

  it("treats an @ after the other characters an email local part can end in as an email", () => {
    for (const c of [".", "_", "+", "-"]) expect(isEmailLikeAt(c)).toBe(true);
  });

  it("keeps an @ after whitespace, punctuation, or at the document start as a reference", () => {
    expect(isEmailLikeAt("")).toBe(false);
    for (const c of [" ", "\n", "(", "[", '"', "—", "…", "\\"]) expect(isEmailLikeAt(c)).toBe(false);
  });

  it("keeps an @ written directly after a non-ASCII word as a reference", () => {
    // `参见@smith2020` and `voir«@key` are real citations in Typst; only ASCII
    // email characters count as an address.
    expect(isEmailLikeAt("见")).toBe(false);
    expect(isEmailLikeAt("é")).toBe(false);
  });
});
