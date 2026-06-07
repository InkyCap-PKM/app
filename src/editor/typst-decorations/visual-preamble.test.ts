import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { isLeadingLocaleDirective, computePreambleImportRanges } from "./visual-protected";

// A note authored in French (German, …) carries a `#set text(lang: …, region: …)`
// directive for correct typesetting. The visual editor treats that directive as
// leading preamble machinery — hidden and locked alongside the `#import` line —
// so a French note reads identically to an English one (no stray "document
// setup" chip, no raw source). These pin the line/string-level helpers behind
// that behaviour; they run without the Typst WASM parser.
describe("isLeadingLocaleDirective", () => {
  it("matches a pure lang+region directive", () => {
    expect(isLeadingLocaleDirective('#set text(lang: "fr", region: "CA")')).toBe(true);
  });

  it("matches lang-only and region-only", () => {
    expect(isLeadingLocaleDirective('#set text(lang: "de")')).toBe(true);
    expect(isLeadingLocaleDirective('#set text(region: "CA")')).toBe(true);
  });

  it("matches a bare SetRule node (no leading #)", () => {
    // findStylePreamble slices the SetRule syntax node, whose `#` is a separate
    // token — the helper must match the hash-less form too.
    expect(isLeadingLocaleDirective('set text(lang: "fr", region: "CA")')).toBe(true);
  });

  it("tolerates extra whitespace and a trailing comma", () => {
    expect(isLeadingLocaleDirective('  #set text( lang: "fr" , region: "CA" , ) ')).toBe(true);
  });

  it("rejects a directive that also sets a non-locale key", () => {
    // font: is genuine document setup — it belongs in the visible setup chip.
    expect(isLeadingLocaleDirective('#set text(font: "EB Garamond", lang: "fr")')).toBe(false);
    expect(isLeadingLocaleDirective('#set text(size: 12pt)')).toBe(false);
  });

  it("rejects non-text set rules and empty arg lists", () => {
    expect(isLeadingLocaleDirective('#set par(leading: 0.65em)')).toBe(false);
    expect(isLeadingLocaleDirective("#set text()")).toBe(false);
    expect(isLeadingLocaleDirective("plain prose")).toBe(false);
  });
});

describe("computePreambleImportRanges", () => {
  // The leading machinery run is line-based, so it needs no syntax tree.
  const rangesFor = (doc: string) =>
    computePreambleImportRanges(EditorState.create({ doc }));

  it("consumes the import line plus a following locale directive", () => {
    const doc =
      '#import "/.inkycap/notebox.typ": *\n' +
      '#set text(lang: "fr", region: "CA")\n' +
      "\n#note(\n  title: \"V\",\n)\n\n= Heading\n";
    const ranges = rangesFor(doc);
    // Both the import line and the locale directive are hidden machinery; the
    // run stops at `#note(` (real content).
    expect(ranges).toHaveLength(2);
    const covered = doc.slice(ranges[0].from, ranges[ranges.length - 1].to);
    expect(covered).toContain('#import "/.inkycap/notebox.typ"');
    expect(covered).toContain('#set text(lang: "fr", region: "CA")');
    expect(covered).not.toContain("#note(");
  });

  it("stops at the note when there is no locale directive (English note)", () => {
    const doc =
      '#import "/.inkycap/notebox.typ": *\n\n#note(\n  title: "V",\n)\n\n= Heading\n';
    const ranges = rangesFor(doc);
    expect(ranges).toHaveLength(1);
    expect(doc.slice(ranges[0].from, ranges[0].to)).toContain("#import");
  });

  it("does not consume a `#set text(font: …)` setup line", () => {
    const doc =
      '#import "/.inkycap/notebox.typ": *\n' +
      '#set text(font: "EB Garamond")\n' +
      "#note()\n";
    const ranges = rangesFor(doc);
    // Only the import is machinery; the font set rule is document setup.
    expect(ranges).toHaveLength(1);
    expect(doc.slice(ranges[0].from, ranges[0].to)).toContain("#import");
  });
});
