import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  blockEditLayout,
  parseRawBlock,
  rawBlockEditLineClasses,
  correctedFuncCallEnd,
} from "./visual-plugin";

// Block quotes, callouts and fenced code blocks each have a rendered widget
// (caret away) and an in-place edit state (caret inside). The edit state must
// show exactly the rows the widget shows, or the block changes height as the
// caret enters and leaves and everything below it shifts. These tests pin the
// row accounting behind that invariant. They are pure string/line-position
// helpers, so they run without the WASM Typst parser (which Vitest's Node
// environment can't load).

function layout(doc: string) {
  const state = EditorState.create({ doc });
  const from = doc.indexOf("[") + 1;
  const to = doc.lastIndexOf("]");
  return { ...blockEditLayout(state, from, to), bodyFrom: from, bodyTo: to };
}

describe("blockEditLayout", () => {
  it("keeps a single-line body on its one line and hides only the brackets", () => {
    const doc = '#callout("Todo")[just one line]';
    const l = layout(doc);
    expect(l.hideOpenTo).toBe(l.bodyFrom);
    expect(l.hideCloseFrom).toBe(l.bodyTo);
    expect([l.firstLine, l.lastLine]).toEqual([1, 1]);
  });

  it("hides the line break after `[` when the body starts on the next line", () => {
    const doc = '#callout("Todo")[\n  body line\nmore]';
    const l = layout(doc);
    // The opener's hidden range runs through the newline and the indentation.
    expect(doc.slice(l.bodyFrom, l.hideOpenTo)).toBe("\n  ");
    expect([l.firstLine, l.lastLine]).toEqual([2, 3]);
  });

  it("hides the line break before a `]` that sits alone on its own line", () => {
    const doc = "#quote(block: true)[this is a blockquote, it works\nits way\n]";
    const l = layout(doc);
    // No empty structural row is left under the visible body.
    expect(doc.slice(l.hideCloseFrom, l.bodyTo)).toBe("\n");
    expect([l.firstLine, l.lastLine]).toEqual([1, 2]);
  });

  it("keeps a blank line the writer left inside the body", () => {
    // Pressing Enter at the end of the body must show a new row for the caret;
    // only the final line break directly before `]` is hidden.
    const doc = "#quote(block: true)[body\n\n]";
    const l = layout(doc);
    expect(doc.slice(l.hideCloseFrom, l.bodyTo)).toBe("\n");
    expect([l.firstLine, l.lastLine]).toEqual([1, 2]);
  });

  it("does not hide plain spaces around the body", () => {
    // Hiding them would make a space the writer just typed vanish.
    const doc = '#callout("note")[ padded ]';
    const l = layout(doc);
    expect(l.hideOpenTo).toBe(l.bodyFrom);
    expect(l.hideCloseFrom).toBe(l.bodyTo);
  });

  it("hides nothing but the brackets for an all-whitespace body", () => {
    const doc = '#callout("note")[\n   \n]';
    const l = layout(doc);
    expect(l.hideOpenTo).toBe(l.bodyFrom);
    expect(l.hideCloseFrom).toBe(l.bodyTo);
    // Every line between the brackets stays editable.
    expect([l.firstLine, l.lastLine]).toEqual([1, 3]);
  });
});

describe("parseRawBlock", () => {
  it("splits the language tag from the body and drops the final line break", () => {
    expect(parseRawBlock("```sh\nnpm test\n```")).toEqual({ lang: "sh", code: "npm test", hasBody: true });
  });

  it("keeps blank body lines so the widget has as many rows as the source", () => {
    expect(parseRawBlock("```\na\n\n\n```").code).toBe("a\n\n");
  });

  it("tells an empty body line apart from no body at all", () => {
    expect(parseRawBlock("```\n```")).toEqual({ lang: "", code: "", hasBody: false });
    expect(parseRawBlock("```\n\n```")).toEqual({ lang: "", code: "", hasBody: true });
  });

  it("handles an unclosed block and a closing fence that shares the last line", () => {
    expect(parseRawBlock("```\nfoo").code).toBe("foo");
    expect(parseRawBlock("```\nfoo```").code).toBe("foo");
  });

  it("matches fences of four or more backticks", () => {
    expect(parseRawBlock("````\nhas ``` inside\n````")).toEqual({ lang: "", code: "has ``` inside", hasBody: true });
  });
});

describe("rawBlockEditLineClasses", () => {
  const classesFor = (doc: string) =>
    rawBlockEditLineClasses(EditorState.create({ doc }), 0, doc.length);

  it("marks the fences as header and footer and the lines between as the body", () => {
    expect(classesFor("```sh\na\nb\nc\n```")).toEqual([
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--open",
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--first",
      "cm-typst-codeblock-edit",
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--last",
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--close",
    ]);
  });

  it("gives a one-line body both body paddings", () => {
    expect(classesFor("```\na\n```")[1]).toBe(
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--first cm-typst-codeblock-edit--last",
    );
  });

  it("has no body lines when the fences are adjacent", () => {
    expect(classesFor("```\n```")).toEqual([
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--open",
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--close",
    ]);
  });

  it("treats a closing fence that shares the last code line as body, not footer", () => {
    expect(classesFor("```\nfoo```")).toEqual([
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--open",
      "cm-typst-codeblock-edit cm-typst-codeblock-edit--first cm-typst-codeblock-edit--last",
    ]);
  });
});

// `correctedFuncCallEnd` is the single source of truth for where a block call
// ends — shared by the decoration builder and the incremental dirty-range
// expander. If lezer truncates a multi-line call at an inner `)` (as it does
// for `#quote(block: true)[…]`), both consumers must still agree on the real
// end past the closing `]`; otherwise a cursor move strands a stale editing
// border behind the rendered widget (a doubled / "nested" bar).
function callEnd(doc: string, funcFrom: number, lezerTo: number) {
  return correctedFuncCallEnd(EditorState.create({ doc }), funcFrom, lezerTo);
}

describe("correctedFuncCallEnd", () => {
  it("extends past `]` when lezer truncates a multi-line quote at the args `)`", () => {
    const doc = "#quote(block: true)[this is a blockquote, it works\nits way]";
    // Simulate the parser truncating at the `)` that closes `(block: true)`.
    const truncated = doc.indexOf(")") + 1;
    expect(callEnd(doc, 0, truncated)).toBe(doc.length); // ends just after the final `]`
  });

  it("follows the content `[` even across a newline after the args", () => {
    const doc = '#callout("todo")[a\nb\nc]';
    const truncated = doc.indexOf(")") + 1;
    expect(callEnd(doc, 0, truncated)).toBe(doc.length);
  });

  it("stops at `)` for a no-trailing-bracket func and ignores a later `[`", () => {
    // `image` never takes a trailing content block; a `[` on the next line is
    // unrelated markup and must NOT be swept into the call.
    const doc = '#image("/a.png")\n[not part of the call]';
    const end = callEnd(doc, 0, doc.indexOf(")") + 1);
    expect(end).toBe(doc.indexOf(")") + 1);
  });

  it("leaves an already-correct single-line call unchanged", () => {
    const doc = '#wikilink("Note")';
    expect(callEnd(doc, 0, doc.length)).toBe(doc.length);
  });

  it("does not run past the closing `]` into trailing markup", () => {
    const doc = '#callout("todo")[body] trailing text';
    const truncated = doc.indexOf(")") + 1;
    expect(callEnd(doc, 0, truncated)).toBe(doc.indexOf("]") + 1);
  });

  it("treats a `[[` inside inline raw as literal, not an unbalanced bracket", () => {
    // The body documents the wikilink shortcut by showing a literal `[[`
    // inside backticks. A naive bracket count would never rebalance and the
    // call end would overshoot (dropping the callout to raw source); the
    // raw-aware matcher must end the call right after the body's `]`.
    const doc = '#callout("example")[Type `[[` then pick a note]\nnext para';
    const truncated = doc.indexOf(")") + 1;
    expect(callEnd(doc, 0, truncated)).toBe(doc.indexOf("]") + 1);
  });

  it("ignores an escaped bracket inside the body", () => {
    const doc = '#callout("note")[a \\] b]\nmore';
    const truncated = doc.indexOf(")") + 1;
    // The escaped `\]` is literal; the real close is the final `]`.
    expect(callEnd(doc, 0, truncated)).toBe(doc.lastIndexOf("]") + 1);
  });
});
