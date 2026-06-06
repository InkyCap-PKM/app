import { describe, it, expect } from "vitest";
import { findLabelDefinition } from "./label-nav";

describe("findLabelDefinition", () => {
  it("finds a label that tags a heading", () => {
    const doc = "intro\n= Working with Pandoc <pandoc>\nmore";
    expect(findLabelDefinition(doc, "pandoc")).toBe(doc.indexOf("<pandoc>"));
  });

  it("skips a #link(<label>) reference and finds the definition", () => {
    // The reference appears FIRST; the definition is the heading below. The
    // naive indexOf would return the reference and land the cursor in the link.
    const doc = 'see #link(<pandoc>)[Working with Pandoc]\n\n= Pandoc <pandoc>';
    const got = findLabelDefinition(doc, "pandoc");
    expect(got).toBe(doc.lastIndexOf("<pandoc>"));
    // And it is NOT the reference inside the link call.
    expect(got).not.toBe(doc.indexOf("<pandoc>"));
  });

  it("skips a #ref(<label>) reference too (preceded by `(`)", () => {
    const doc = "@x #ref(<x>) and = T <x>".replace("= T <x>", "\n= T <x>");
    expect(findLabelDefinition(doc, "x")).toBe(doc.lastIndexOf("<x>"));
  });

  it("returns -1 when only references exist (no definition)", () => {
    expect(findLabelDefinition("#link(<gone>)[x]", "gone")).toBe(-1);
  });

  it("returns -1 when the label is absent", () => {
    expect(findLabelDefinition("nothing here", "missing")).toBe(-1);
  });

  it("treats a comma-preceded occurrence as a reference (arg list)", () => {
    // A label in a multi-arg call is still a reference, not a definition.
    const doc = "#somecall(a, <x>)\n= H <x>";
    expect(findLabelDefinition(doc, "x")).toBe(doc.lastIndexOf("<x>"));
  });
});
