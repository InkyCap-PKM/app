import { describe, it, expect } from "vitest";
import { buildGroups, scoreReferenceQuery } from "./reference-suggest";
import type { DocLabel } from "./document-labels";

// The `@` citation popup matches a query against a candidate's
// `key + title + authors` search text. The load-bearing invariant is that a
// query may span spaces (most titles/authors contain them), and the popup stays
// alive only while *every* typed word still matches — the moment a word matches
// nothing, the writer has left the citation for prose and the candidate drops
// out (and, when every candidate drops, the popup closes).
describe("scoreReferenceQuery", () => {
  const einstein = "einstein1905 On the Electrodynamics of Moving Bodies Albert Einstein";

  it("matches everything on an empty query, preserving source order (score 0)", () => {
    expect(scoreReferenceQuery("", einstein)).toBe(0);
  });

  it("matches a single token like a plain fuzzy match", () => {
    expect(scoreReferenceQuery("einstein", einstein)).not.toBeNull();
  });

  it("keeps matching across a space when every word is present", () => {
    // The exact case the space-dismissal bug broke: a multi-word title/author
    // search must still resolve to its citation.
    expect(scoreReferenceQuery("electrodynamics moving", einstein)).not.toBeNull();
    expect(scoreReferenceQuery("einstein moving bodies", einstein)).not.toBeNull();
  });

  it("drops the candidate when any one word matches nothing (writer typed into prose)", () => {
    // "einstein" matches but "groceries" does not → the writer has moved on.
    expect(scoreReferenceQuery("einstein groceries", einstein)).toBeNull();
    expect(scoreReferenceQuery("moving qqzzx", einstein)).toBeNull();
  });

  it("matches whole words only, not scattered letters", () => {
    // The relevance fix: a word must appear as a contiguous substring. "etrb"
    // is a scattered subsequence of "Elec*t*rodynamics ... *B*odies" but not a
    // substring, so it must NOT match — that scattered behaviour was the source
    // of unrelated results.
    expect(scoreReferenceQuery("etrb", einstein)).toBeNull();
    expect(scoreReferenceQuery("mvng", einstein)).toBeNull();
  });

  it("is order-independent across words (AND, not a phrase match)", () => {
    expect(scoreReferenceQuery("moving electrodynamics", einstein)).not.toBeNull();
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(scoreReferenceQuery("  einstein   bodies  ", einstein)).not.toBeNull();
  });

  it("scores more matched words higher than fewer", () => {
    const one = scoreReferenceQuery("einstein", einstein)!;
    const two = scoreReferenceQuery("einstein bodies", einstein)!;
    expect(one).not.toBeNull();
    expect(two).toBeGreaterThan(one);
  });
});

// Which syntax each row writes. `@name` is `#ref`, which renders the target's
// number, so it only works where a number exists; everything else has to go out
// as `#link(<name>)[…]` or it will not compile.
describe("buildGroups insert form", () => {
  const label = (name: string, kind: DocLabel["kind"]): DocLabel => ({
    name,
    kind,
    display: name,
  });
  const forms = (labels: DocLabel[], headingsNumbered: boolean) =>
    Object.fromEntries(
      buildGroups([], labels, "", headingsNumbered)
        .flatMap((g) => g.items)
        .filter((item) => item.type === "label")
        .map((item) => [item.label.name, item.form]),
    );

  it("writes a link for a label on prose, whatever the document settings", () => {
    expect(forms([label("l", "label")], true)).toEqual({ l: "link" });
    expect(forms([label("l", "label")], false)).toEqual({ l: "link" });
  });

  it("writes @ for figures, tables and equations", () => {
    const labels = [label("f", "figure"), label("t", "table"), label("e", "equation")];
    expect(forms(labels, false)).toEqual({ f: "ref", t: "ref", e: "ref" });
  });

  it("switches heading rows between @ and link on heading numbering", () => {
    expect(forms([label("h", "heading")], true)).toEqual({ h: "ref" });
    expect(forms([label("h", "heading")], false)).toEqual({ h: "link" });
  });
});
