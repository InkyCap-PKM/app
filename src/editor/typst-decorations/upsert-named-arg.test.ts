import { describe, it, expect } from "vitest";
import { upsertNamedArg } from "./pill";

// Pill menus and the task checkbox edit one named argument of a call and leave
// the rest as written.

describe("upsertNamedArg", () => {
  it("adds an argument list before a body that has none", () => {
    expect(upsertNamedArg("#task[Buy milk]", "done", "true")).toBe("#task(done: true)[Buy milk]");
  });

  it("drops the emptied list before a body", () => {
    expect(upsertNamedArg("#task(done: true)[Buy milk]", "done", "false", { defaultValue: "false" }))
      .toBe("#task[Buy milk]");
    expect(upsertNamedArg('#highlight(fill: rgb("#ff9f97"))[x]', "fill", null)).toBe("#highlight[x]");
  });

  it("keeps the list when other arguments remain, or when there is no body", () => {
    expect(upsertNamedArg('#task(due: "2026-06-23", done: true)[x]', "done", null))
      .toBe('#task(due: "2026-06-23")[x]');
    expect(upsertNamedArg("#line(length: 100%)", "length", null)).toBe("#line()");
  });
});
