import { describe, it, expect } from "vitest";
import { parseInlineBody, type BodySegment } from "./block-body-parse";

// `parseInlineBody` is what lets a `#task(...)`, `#tag(...)`, `#wikilink(...)`
// or `#link(...)` written *inside* a callout / quote / annotation render as its
// semantic element in the cursor-away block preview, instead of as raw Typst
// source (Bug 2: a task inside a callout showed the literal `#task("…")` text).

// `start` (the in-body offset) is asserted separately; strip it recursively
// (including from nested `format` children) for the shape checks so they read
// cleanly.
function stripStart(seg: BodySegment): Omit<BodySegment, "start"> {
  const { start: _start, ...rest } = seg;
  if (rest.kind === "format") {
    return { ...rest, children: rest.children.map(stripStart) } as Omit<BodySegment, "start">;
  }
  if (rest.kind === "list") {
    return { ...rest, items: rest.items.map((item) => item.map(stripStart)) } as Omit<BodySegment, "start">;
  }
  return rest;
}
function shapes(text: string): Omit<BodySegment, "start">[] {
  return parseInlineBody(text).map(stripStart);
}

describe("parseInlineBody", () => {
  it("renders a task inside body text (the Bug 2 case)", () => {
    expect(shapes('way #wikilink("BAnQ") #task("feed the dog!")\neven more')).toEqual([
      { kind: "text", text: "way " },
      { kind: "wikilink", target: "BAnQ", display: "BAnQ" },
      { kind: "text", text: " " },
      { kind: "task", body: "feed the dog!", done: false, due: null },
      { kind: "text", text: "\neven more" },
    ]);
  });

  it("marks a done task and keeps its due date", () => {
    expect(shapes('#task("Feed the dog!", done: true, due: "2026-06-01")')).toEqual([
      { kind: "task", body: "Feed the dog!", done: true, due: "2026-06-01" },
    ]);
  });

  it("reads a wikilink display override", () => {
    expect(shapes('#wikilink("Real Name", display: "shown")')).toEqual([
      { kind: "wikilink", target: "Real Name", display: "shown" },
    ]);
  });

  it("renders a tag", () => {
    expect(shapes("see #tag(\"physics\") here")).toEqual([
      { kind: "text", text: "see " },
      { kind: "tag", name: "physics" },
      { kind: "text", text: " here" },
    ]);
  });

  it("renders a link with a trailing content label", () => {
    expect(shapes('#link("https://x.test")[click]')).toEqual([
      { kind: "link", url: "https://x.test", display: "click" },
    ]);
  });

  it("does not choke on a `)` inside a string argument", () => {
    expect(shapes('#task("buy milk (2L)")')).toEqual([
      { kind: "task", body: "buy milk (2L)", done: false, due: null },
    ]);
  });

  it("leaves unrecognized funcs and plain text alone", () => {
    expect(shapes("plain #unknown(1) text")).toEqual([
      { kind: "text", text: "plain #unknown(1) text" },
    ]);
  });

  it("renders `*bold*` and `_italic_` markup", () => {
    expect(shapes("a *bold* and _soft_ end")).toEqual([
      { kind: "text", text: "a " },
      { kind: "format", className: "cm-typst-bold", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " and " },
      { kind: "format", className: "cm-typst-italic", children: [{ kind: "text", text: "soft" }] },
      { kind: "text", text: " end" },
    ]);
  });

  it("renders content-bracket formatting funcs (highlight, strike, strong)", () => {
    expect(shapes("#highlight[key]")).toEqual([
      { kind: "format", className: "cm-typst-highlight", children: [{ kind: "text", text: "key" }] },
    ]);
    expect(shapes("#strong[B]")).toEqual([
      { kind: "format", className: "cm-typst-bold", children: [{ kind: "text", text: "B" }] },
    ]);
    expect(shapes("#strike[old]")).toEqual([
      { kind: "format", className: "cm-typst-strike", children: [{ kind: "text", text: "old" }] },
    ]);
  });

  it("nests markup recursively", () => {
    expect(shapes("#highlight[a *b*]")).toEqual([
      {
        kind: "format",
        className: "cm-typst-highlight",
        children: [
          { kind: "text", text: "a " },
          { kind: "format", className: "cm-typst-bold", children: [{ kind: "text", text: "b" }] },
        ],
      },
    ]);
  });

  it("renders an inline raw span verbatim", () => {
    expect(shapes("run `npm test` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "raw", text: "npm test", block: false },
      { kind: "text", text: " now" },
    ]);
  });

  it("parses a fenced code block, dropping the language token and fences", () => {
    expect(shapes("before\n```typ\n#import \"/x\": *\n```\nafter")).toEqual([
      { kind: "text", text: "before\n" },
      { kind: "raw", text: "#import \"/x\": *", block: true },
      { kind: "text", text: "\nafter" },
    ]);
  });

  it("does not mistake a fence for inline brackets/markup inside it", () => {
    // The `[[` and `*` inside a fenced block stay literal code, not a wikilink
    // or bold run.
    expect(shapes("```\ntype `[[` and *x*\n```")).toEqual([
      { kind: "raw", text: "type `[[` and *x*", block: true },
    ]);
  });

  it("does not treat underscores inside a word as emphasis", () => {
    expect(shapes("see my_file_name here")).toEqual([
      { kind: "text", text: "see my_file_name here" },
    ]);
  });

  it("keeps an escaped marker literal", () => {
    expect(shapes("a \\*literal\\* star")).toEqual([
      { kind: "text", text: "a \\*literal\\* star" },
    ]);
  });

  it("returns a single text segment when there are no inline funcs", () => {
    expect(shapes("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });

  it("reports each segment's in-body start offset", () => {
    const text = 'way #task("x") end';
    const segs = parseInlineBody(text);
    const task = segs.find((s) => s.kind === "task")!;
    // The offset must point at the `#` so callers can recover the call's
    // absolute source position (body start + offset) to toggle `done`.
    expect(task.start).toBe(text.indexOf("#task"));
    expect(text.slice(task.start)).toMatch(/^#task\(/);
  });

  it("renders a `+ ` ordered list (the literal-+ bug)", () => {
    expect(shapes("+ first\n+ second")).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          [{ kind: "text", text: "first" }],
          [{ kind: "text", text: "second" }],
        ],
      },
    ]);
  });

  it("renders a `- ` unordered list", () => {
    expect(shapes("- a\n- b")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]],
      },
    ]);
  });

  it("parses inline markup inside list items", () => {
    expect(shapes('+ see #wikilink("X")')).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          [
            { kind: "text", text: "see " },
            { kind: "wikilink", target: "X", display: "X" },
          ],
        ],
      },
    ]);
  });

  it("keeps text before and after a list, without blank-line padding", () => {
    expect(shapes("intro\n+ one\n+ two\noutro")).toEqual([
      { kind: "text", text: "intro" },
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
      { kind: "text", text: "outro" },
    ]);
  });

  it("starts a fresh list when the marker type switches", () => {
    const segs = shapes("+ a\n- b");
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ kind: "list", ordered: true });
    expect(segs[1]).toMatchObject({ kind: "list", ordered: false });
  });

  it("preserves a list item's start offset for an inner task", () => {
    const text = "+ #task(\"x\")";
    const segs = parseInlineBody(text);
    const list = segs.find((s) => s.kind === "list")!;
    const task = (list.kind === "list" ? list.items[0][0] : null)!;
    expect(text.slice(task.start)).toMatch(/^#task\(/);
  });
});
