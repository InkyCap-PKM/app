import { describe, it, expect } from "vitest";
import { referenceActions } from "./reference-quickfix";

describe("referenceActions", () => {
  it("returns no actions for an unrelated message", () => {
    expect(referenceActions("unknown variable foo")).toBeUndefined();
  });

  it("offers enable-numbering + text-link for a heading reference", () => {
    const actions = referenceActions("cannot reference heading without numbering");
    expect(actions).toHaveLength(2);
  });

  it("offers only enable-numbering for an equation reference", () => {
    const actions = referenceActions("error: cannot reference equation without numbering");
    expect(actions).toHaveLength(1);
  });

  it("offers only the text link when the target can't be numbered at all", () => {
    // A label on prose: no `#set` rule can ever make `@name` compile.
    const actions = referenceActions("error: cannot reference text");
    expect(actions).toHaveLength(1);
  });
});
