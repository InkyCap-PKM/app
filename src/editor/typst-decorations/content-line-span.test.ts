import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { contentLineSpan, correctedFuncCallEnd } from "./visual-plugin";

// `contentLineSpan` decides which document lines the editing-mode blockquote /
// callout border decoration paints over. These tests pin the load-bearing
// invariant behind Bug 1: a closing `]` that sits alone on its own line must
// NOT contribute an extra border-left segment ("nested"/doubled bar) on the
// otherwise-empty structural line below the visible body.
//
// It is a pure string/line-position helper, so it runs without the WASM Typst
// parser (which Vitest's Node environment can't load).
function span(doc: string, from: number, to: number) {
  const state = EditorState.create({ doc });
  return contentLineSpan(state, from, to);
}

// Body range = the slice between the opening `[` and the matching `]`.
function bodyRange(doc: string) {
  return { from: doc.indexOf("[") + 1, to: doc.lastIndexOf("]") };
}

describe("contentLineSpan", () => {
  it("trims a trailing `]`-only line (Bug 1 repro)", () => {
    const doc = "#quote(block: true)[this is a blockquote, it works\nits way\n]";
    const { from, to } = bodyRange(doc);
    // Lines 1–2 hold the text; line 3 holds only the closing bracket.
    expect(span(doc, from, to)).toEqual({ start: 1, end: 2 });
  });

  it("keeps both lines when `]` is inline after the last word", () => {
    const doc = "#quote(block: true)[this is a blockquote, it works\nits way]";
    const { from, to } = bodyRange(doc);
    expect(span(doc, from, to)).toEqual({ start: 1, end: 2 });
  });

  it("trims a leading newline after `[`", () => {
    const doc = '#callout("Todo")[\nbody line\nmore]';
    const { from, to } = bodyRange(doc);
    expect(span(doc, from, to)).toEqual({ start: 2, end: 3 });
  });

  it("collapses a single-line body to one line", () => {
    const doc = '#callout("Todo")[just one line]';
    const { from, to } = bodyRange(doc);
    expect(span(doc, from, to)).toEqual({ start: 1, end: 1 });
  });

  it("collapses an all-whitespace body to the opening line", () => {
    const doc = "#callout(\"note\")[\n   \n]";
    const { from, to } = bodyRange(doc);
    const opening = 1; // the `[` is on line 1
    expect(span(doc, from, to)).toEqual({ start: opening, end: opening });
  });
});

// `correctedFuncCallEnd` is the single source of truth for where a block call
// ends — shared by the decoration builder and the incremental dirty-range
// expander. If lezer truncates a multi-line call at an inner `)` (as it does
// for `#quote(block: true)[…]`), both consumers must still agree on the real
// end past the closing `]`; otherwise a cursor move strands a stale editing
// border behind the rendered widget (the doubled / "nested" bar of Bug 1).
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
