import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";
import { noteBodyStart, noteHeaderItems } from "./note-header";
import { findStylePreamble } from "./visual-plugin";
import { computeProtectedRanges } from "./visual-protected";

const state = (doc: string) => EditorState.create({ doc, extensions: [typst()] });
const body = (doc: string) => doc.slice(noteBodyStart(state(doc)));

describe("noteHeaderItems", () => {
  it("classifies each kind of header item in order", () => {
    const doc = [
      "// comment",
      '#import "/.inkycap/notebox.typ": *',
      '#set text(lang: "fr")',
      '#include "a.typ"',
      "#note(",
      '  title: "T",',
      '  collection: ("A",),',
      ")",
      "#set-notebox(x: 1)",
      '#bibliography("/r.bib")',
      "#set par(leading: 1em)",
      "#show heading: it => it",
      "#let f(x) = x",
      "",
      "Hello",
    ].join("\n");
    expect(noteHeaderItems(state(doc)).map((i) => i.kind)).toEqual([
      "comment",
      "import",
      "locale",
      "include",
      "note",
      "set-notebox",
      "bibliography",
      "set",
      "show",
      "let",
    ]);
  });

  it("starts each item at its #", () => {
    const doc = '#import "/lib.typ": *\nBody';
    expect(noteHeaderItems(state(doc))[0]).toEqual({ kind: "import", from: 0, to: 21 });
  });

  it("ends at the first other function call", () => {
    const doc = '#image("/a.png")\n#note(title: "late")';
    expect(noteHeaderItems(state(doc))).toEqual([]);
  });

  it("treats an unclosed block comment as body", () => {
    const doc = '#import "/lib.typ": *\n/* still typing\n#note()';
    expect(noteHeaderItems(state(doc)).map((i) => i.kind)).toEqual(["import"]);
  });
});

describe("noteBodyStart", () => {
  it("is 0 when the document opens straight into body", () => {
    expect(noteBodyStart(state("Hello @intro world"))).toBe(0);
  });

  it("skips an import line", () => {
    expect(body('#import "/.inkycap/notebox.typ": *\nBody @intro')).toBe("Body @intro");
  });

  it("skips a multi-line #note(...) whose values hold parentheses", () => {
    const doc = [
      '#import "/lib.typ": *',
      "#note(",
      '  title: "Scratch (draft)",',
      '  collection: ("Foo",),',
      ")",
      "First paragraph @intro",
    ].join("\n");
    expect(body(doc)).toBe("First paragraph @intro");
  });

  it("skips blank lines, comments, includes and a bibliography", () => {
    const doc = '// a note\n\n#import "/lib.typ": *\n#include "x.typ"\n#bibliography("/r.bib")\n\nbody';
    expect(body(doc)).toBe("body");
  });

  it("stops before style rules, which apply to what follows them", () => {
    const doc = '#import "/lib.typ": *\n#note()\n#set par(leading: 1em)\nText';
    expect(body(doc)).toBe("#set par(leading: 1em)\nText");
  });

  it("is the end of the document when there is no body", () => {
    const doc = '#import "/lib.typ": *\n#note()\n\n';
    expect(noteBodyStart(state(doc))).toBe(doc.length);
  });

  it("starts right after the header when body text shares its line", () => {
    const doc = "#note() Hello";
    expect(body(doc)).toBe(" Hello");
  });
});

describe("findStylePreamble", () => {
  it("covers the set/show/let run after the imports and note", () => {
    const doc = '#import "/lib.typ": *\n#note()\n#set par(leading: 1em)\n#let f(x) = x\n\nText';
    const found = findStylePreamble(state(doc));
    expect(found?.count).toBe(2);
    expect(doc.slice(found!.from, found!.to)).toBe("#set par(leading: 1em)\n#let f(x) = x");
  });

  it("leaves out a language directive before the note", () => {
    const doc =
      '#import "/lib.typ": *\n#set text(lang: "fr")\n#note()\n#set par(leading: 1em)\nText';
    const found = findStylePreamble(state(doc));
    expect(found?.count).toBe(1);
    expect(doc.slice(found!.from, found!.to)).toBe("#set par(leading: 1em)");
  });

  it("finds nothing when body text comes before any rule", () => {
    expect(findStylePreamble(state("Text\n#set par(leading: 1em)"))).toBeNull();
  });
});

describe("computeProtectedRanges (header calls)", () => {
  const covered = (doc: string, expandedPos: number | null = null) =>
    computeProtectedRanges(state(doc), expandedPos).map((r) => doc.slice(r.from, r.to));

  it("locks a multi-line #note(...) with its line break and one blank line", () => {
    const doc = '#note(\n  collection: ("A",),\n)\n\nBody';
    expect(covered(doc)).toEqual(['#note(\n  collection: ("A",),\n)\n\n']);
  });

  it("leaves a header bibliography editable while it is open", () => {
    const doc = '#note()\n#bibliography("/r.bib")\nBody';
    expect(covered(doc)).toEqual(["#note()\n", '#bibliography("/r.bib")\n']);
    expect(covered(doc, doc.indexOf("#bib"))).toEqual(["#note()\n"]);
  });

  it("does not lock a bibliography in the body", () => {
    expect(covered('Body\n#bibliography("/r.bib")\n')).toEqual([]);
  });
});
