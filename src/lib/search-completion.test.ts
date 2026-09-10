import { describe, it, expect } from "vitest";
import { completionContext, applyCompletion, canComplete } from "./search-completion";

/** Context for a query written with `|` marking the caret. */
function at(marked: string) {
  const caret = marked.indexOf("|");
  return completionContext(marked.replace("|", ""), caret);
}

/** Accept `value` for the query written with `|` marking the caret. */
function accept(marked: string, value: string, suffix = "") {
  const query = marked.replace("|", "");
  const context = completionContext(query, marked.indexOf("|"))!;
  const { text, caret } = applyCompletion(query, context, value, suffix);
  return `${text.slice(0, caret)}|${text.slice(caret)}`;
}

describe("values that can be completed at all", () => {
  it("leaves out a value the query language cannot quote", () => {
    // A double quote always opens or closes a run and cannot be escaped, so
    // a filter for such a value would search for some other string.
    expect(canComplete('say "hi"')).toBe(false);
    expect(canComplete("plain")).toBe(true);
    expect(canComplete("with space")).toBe(true);
  });

  it("keeps a quoted value whole", () => {
    expect(accept("tag:|", "in progress")).toBe('tag:"in progress"|');
  });
});

describe("recognizing the filter under the caret", () => {
  it("offers tags inside a tag filter", () => {
    expect(at("tag:|")).toMatchObject({ kind: "tag", typed: "" });
    expect(at("tag:proj|")).toMatchObject({ kind: "tag", typed: "proj" });
  });

  it("offers folders inside a path filter", () => {
    expect(at("path:|")).toMatchObject({ kind: "path", typed: "" });
    expect(at('path:"2 Box|')).toMatchObject({ kind: "path", typed: "2 box" });
    // The quoted form the panel inserts is still recognized for re-editing.
    expect(at('path:"2 Box/"|')).toMatchObject({ kind: "path", typed: "2 box/" });
  });

  it("offers property keys until the `=` is typed, then that key's values", () => {
    expect(at("property:sta|")).toMatchObject({ kind: "property-key", typed: "sta" });
    expect(at("property:status=|")).toMatchObject({
      kind: "property-value",
      key: "status",
      typed: "",
    });
    expect(at("property:status=dra|")).toMatchObject({
      kind: "property-value",
      key: "status",
      typed: "dra",
    });
  });

  it("follows the filter through the query's own operators", () => {
    expect(at("rust tag:|")).toMatchObject({ kind: "tag" });
    expect(at("rust -tag:dra|")).toMatchObject({ kind: "tag", typed: "dra" });
    expect(at("a OR (tag:dra|")).toMatchObject({ kind: "tag", typed: "dra" });
    expect(at("a NOT tag:|")).toMatchObject({ kind: "tag" });
  });

  it("stays quiet away from a tag or property filter", () => {
    expect(at("rust|")).toBeNull();
    expect(at("tag:draft |")).toBeNull();
    expect(at("section:intro|")).toBeNull();
    // Not at a token boundary, so this is a word that merely ends in "tag:".
    expect(at("hashtag:|")).toBeNull();
  });

  it("keeps a quoted value together, spaces and all", () => {
    expect(at('property:author="Jane |')).toMatchObject({
      kind: "property-value",
      key: "author",
      typed: "jane ",
    });
  });

  it("covers the whole value when the caret sits inside it", () => {
    // Accepting mid-word replaces the word, not just the part behind the caret.
    expect(accept("tag:pro|ject", "prototype")).toBe("tag:prototype|");
  });
});

describe("accepting a completion", () => {
  it("fills the value in and leaves the caret after it", () => {
    expect(accept("tag:pro|", "project")).toBe("tag:project|");
    expect(accept("rust tag:|", "draft")).toBe("rust tag:draft|");
    expect(accept("property:sta|", "status")).toBe("property:status|");
    expect(accept("property:status=|", "draft")).toBe("property:status=draft|");
  });

  it("quotes a folder whose name has spaces", () => {
    // The whole point: the user types `path:2` and never has to work out
    // that the quotes and the trailing slash were needed.
    expect(accept("path:2|", "2 Box/")).toBe('path:"2 Box/"|');
    expect(accept("path:|", "Archive/")).toBe("path:Archive/|");
    expect(accept('path:"2 Box/"|', "2 Box/Drafts/")).toBe('path:"2 Box/Drafts/"|');
  });

  it("quotes a value that would otherwise end the token", () => {
    expect(accept("property:author=|", "Jane Doe")).toBe('property:author="Jane Doe"|');
    expect(accept('property:author="Jane |', "Jane Doe")).toBe(
      'property:author="Jane Doe"|',
    );
  });

  it("puts the suffix outside the quotes so the caret lands after it", () => {
    // The panel passes "=" when a property key is chosen, so the value list
    // can follow without the user typing it.
    expect(accept("property:sta|", "status", "=")).toBe("property:status=|");
    expect(accept("property:|", "date created", "=")).toBe(
      'property:"date created"=|',
    );
  });

  it("leaves the rest of the query alone", () => {
    expect(accept("rust tag:| AND draft", "project")).toBe(
      "rust tag:project| AND draft",
    );
  });
});
