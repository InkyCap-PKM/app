import { describe, it, expect } from "vitest";
import {
  isToolbarRule,
  swapRules,
  toolbarNeighbourId,
} from "./creation-rule-order";
import type { CreationRule } from "./types";

/** A rule with only the fields ordering cares about set explicitly. */
function rule(
  id: string,
  opts: { toolbar?: boolean; disabled?: boolean } = {},
): CreationRule {
  return {
    id,
    name: id,
    icon_emoji: "",
    scaffold_path: "",
    target_folder: "",
    filename_pattern: "",
    creation_mode: "create_and_open",
    hotkey: null,
    show_in_toolbar: opts.toolbar ?? true,
    description: "",
    builtin: false,
    typst_template: "",
    disabled: opts.disabled ?? false,
  };
}

const ids = (rules: CreationRule[]) => rules.map((r) => r.id);

describe("isToolbarRule", () => {
  it("excludes a disabled rule even when its toolbar setting is on", () => {
    expect(isToolbarRule(rule("a", { toolbar: true, disabled: true }))).toBe(
      false,
    );
  });
});

describe("toolbarNeighbourId", () => {
  it("skips rules that aren't toolbar buttons, so one click moves one slot", () => {
    const rules = [
      rule("first"),
      rule("hidden", { toolbar: false }),
      rule("second"),
    ];
    expect(toolbarNeighbourId(rules, "second", -1)).toBe("first");
    expect(toolbarNeighbourId(rules, "first", 1)).toBe("second");
  });

  it("has no neighbour at either end of the toolbar", () => {
    const rules = [rule("first"), rule("second")];
    expect(toolbarNeighbourId(rules, "first", -1)).toBeNull();
    expect(toolbarNeighbourId(rules, "second", 1)).toBeNull();
  });

  it("has no neighbour for a rule that isn't on the toolbar at all", () => {
    const rules = [rule("a"), rule("hidden", { toolbar: false }), rule("b")];
    expect(toolbarNeighbourId(rules, "hidden", -1)).toBeNull();
    expect(toolbarNeighbourId(rules, "hidden", 1)).toBeNull();
  });
});

describe("swapRules", () => {
  it("leaves the rules in between where they were", () => {
    const rules = [
      rule("first"),
      rule("hidden", { toolbar: false }),
      rule("second"),
    ];
    expect(ids(swapRules(rules, "second", "first"))).toEqual([
      "second",
      "hidden",
      "first",
    ]);
  });

  it("returns the list unchanged when an id matches nothing", () => {
    const rules = [rule("a"), rule("b")];
    expect(ids(swapRules(rules, "a", "nonsense"))).toEqual(["a", "b"]);
  });

  it("does not mutate the list it was given", () => {
    const rules = [rule("a"), rule("b")];
    swapRules(rules, "a", "b");
    expect(ids(rules)).toEqual(["a", "b"]);
  });
});
