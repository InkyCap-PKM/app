import { describe, it, expect } from "vitest";
import { parseInlineBody, type BodySegment } from "./block-body-parse";

// `parseInlineBody` is what lets a `#task(...)`, `#tag(...)`, `#wikilink(...)`
// or `#link(...)` written *inside* a callout / quote / annotation render as its
// semantic element in the cursor-away block preview, instead of as raw Typst
// source (Bug 2: a task inside a callout showed the literal `#task("…")` text).

// `start` (the in-body offset) is asserted separately; strip it for the shape
// checks so they read cleanly.
function shapes(text: string): Omit<BodySegment, "start">[] {
  return parseInlineBody(text).map(({ start: _start, ...rest }) => rest);
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
    expect(shapes("plain #strong[bold] and #unknown(1) text")).toEqual([
      { kind: "text", text: "plain #strong[bold] and #unknown(1) text" },
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
});
