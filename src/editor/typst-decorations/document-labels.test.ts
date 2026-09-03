import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { typst } from "codemirror-lang-typst";
import { scanDocumentLabels } from "./document-labels";

// The `@` popup groups its rows by these kinds, and picks the insert form from
// them — a heading row can write `@name`, a prose label has to write a link. So
// the classification is what decides whether the reference compiles.

function mk(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [typst()] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

const kinds = (doc: string) =>
  Object.fromEntries(scanDocumentLabels(mk(doc)).map((l) => [l.name, l.kind]));

describe("scanDocumentLabels", () => {
  it("classifies a heading's own label as a heading, carrying its text", () => {
    const labels = scanDocumentLabels(mk("= Introduction <intro>\n\nBody.\n"));
    expect(labels).toEqual([{ name: "intro", kind: "heading", display: "Introduction" }]);
  });

  it("classifies a label on prose as the catch-all kind", () => {
    expect(kinds("Make a label <label1>\n")).toEqual({ label1: "label" });
  });

  it("classifies figures, tables and block equations", () => {
    const doc = '#figure(image("/a.png")) <fig>\n\n#table(columns: 2)[a][b] <tbl>\n\n$ a = b $ <eq>\n';
    expect(kinds(doc)).toEqual({ fig: "figure", tbl: "table", eq: "equation" });
  });

  it("skips labels written as reference arguments", () => {
    expect(kinds("= Intro <intro>\n\nSee #link(<intro>)[it].\n")).toEqual({ intro: "heading" });
  });
});
