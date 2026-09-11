import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typst } from "codemirror-lang-typst";
import { buildDecorations } from "./visual-plugin";

// Typst lexes the `@inkycap.org` in `athena@inkycap.org` as a reference, and
// the language package's syntax highlighting colours it like one. The visual
// layer marks that span as plain text so an address reads like the prose around
// it — and it must do so with the caret on the span too, which is exactly when
// the writer is looking at it. (A resolved or standalone `@key` keeps the usual
// cursor-adjacent reveal.)

/** Decorations over the `@…` span of `doc` with the caret at `caret`: the class
 *  of each mark, or `"widget"` for a replacing widget. */
function refDecorations(doc: string, caret: number): string[] {
  const state = EditorState.create({ doc, selection: { anchor: caret }, extensions: [typst()] });
  const at = doc.indexOf("@");
  const found: string[] = [];
  buildDecorations(state).between(at, at + 1, (_from, _to, value) => {
    const cls = value.spec?.class;
    if (typeof cls === "string") found.push(cls);
    else if (value.spec?.widget) found.push("widget");
  });
  return found;
}

describe("an email's @domain renders as plain text", () => {
  const DOC = "write to athena@inkycap.org today";
  const AT = DOC.indexOf("@");

  it("with the caret elsewhere", () => {
    expect(refDecorations(DOC, 0)).toEqual(["cm-typst-ref-plain"]);
  });

  it("with the caret right after the address, where it lands while typing", () => {
    expect(refDecorations(DOC, DOC.indexOf(" today"))).toEqual(["cm-typst-ref-plain"]);
  });

  it("with the caret inside the domain", () => {
    expect(refDecorations(DOC, AT + 3)).toEqual(["cm-typst-ref-plain"]);
  });
});

describe("a standalone @key keeps the reference treatment", () => {
  const DOC = "see @nowhere here";

  it("is shown as a citation with the caret elsewhere", () => {
    // No bibliography is loaded here, so the span renders optimistically as a
    // citation widget; the point is that it is never marked as plain text.
    expect(refDecorations(DOC, 0)).toEqual(["widget"]);
  });

  it("is left undecorated for editing with the caret on it", () => {
    expect(refDecorations(DOC, DOC.indexOf("@") + 2)).toEqual([]);
  });
});
