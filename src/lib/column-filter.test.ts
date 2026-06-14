// Unit tests for the per-column filter builders and the Agenda date predicate.
// These pin the lowering rules the backend relies on: list multi-select →
// OR-of-equality, commalist → OR-of-contains, numeric "between" / date "within"
// → two relational comparisons ANDed, and the day-boundary date semantics
// shared between the table (expression strings) and the Agenda (predicate).

import { describe, it, expect } from "vitest";
import {
  buildCheckboxFilter,
  buildDateFilter,
  buildMultiSelectFilter,
  buildNumberFilter,
  buildTextFilter,
  fileColumnType,
  matchesDateFilter,
  multiSelectOptions,
  parseDateFilter,
  parseNumberFilter,
  type DateFilterState,
} from "./column-filter";

describe("file.* column types are fixed (never content-inferred)", () => {
  it("names and paths are text", () => {
    expect(fileColumnType("file.name")).toBe("text");
    expect(fileColumnType("file.folder")).toBe("text");
    expect(fileColumnType("file.path")).toBe("text");
    expect(fileColumnType("file.ext")).toBe("text");
  });
  it("stat timestamps are dates, size is a number", () => {
    expect(fileColumnType("file.ctime")).toBe("date");
    expect(fileColumnType("file.mtime")).toBe("date");
    expect(fileColumnType("file.size")).toBe("number");
  });
  it("a user property is not a file column", () => {
    expect(fileColumnType("tags")).toBeUndefined();
  });
});

describe("multi-select filter", () => {
  it("lowers a list selection to OR-of-equality (membership)", () => {
    expect(buildMultiSelectFilter("status", ["draft", "review"], "list")).toEqual({
      or: ['status == "draft"', 'status == "review"'],
    });
  });

  it("lowers a commalist selection to OR-of-contains", () => {
    expect(buildMultiSelectFilter("tags", ["rust"], "commalist")).toEqual({
      or: ['tags.contains("rust")'],
    });
  });

  it("clears (null) when nothing is selected", () => {
    expect(buildMultiSelectFilter("status", [], "list")).toBeNull();
  });

  it("splits commalist facet values into distinct options", () => {
    expect(multiSelectOptions(["a, b", "b, c"], "commalist")).toEqual(["a", "b", "c"]);
  });

  it("leaves list facet values untouched", () => {
    expect(multiSelectOptions(["b", "a"], "list")).toEqual(["b", "a"]);
  });
});

describe("number filter", () => {
  it("emits an unquoted relational comparison", () => {
    expect(buildNumberFilter("priority", { op: "<", value: "5", value2: "" })).toEqual({
      and: ["priority < 5"],
    });
  });

  it("lowers between to two comparisons ANDed", () => {
    expect(buildNumberFilter("priority", { op: "between", value: "1", value2: "10" })).toEqual({
      and: ["priority >= 1", "priority <= 10"],
    });
  });

  it("is incomplete (null) until both between bounds are set", () => {
    expect(buildNumberFilter("priority", { op: "between", value: "1", value2: "" })).toBeNull();
  });

  it("emits isEmpty / not isEmpty for the emptiness operators", () => {
    expect(buildNumberFilter("priority", { op: "empty", value: "", value2: "" })).toEqual({
      and: ["priority.isEmpty()"],
    });
    expect(buildNumberFilter("priority", { op: "notEmpty", value: "", value2: "" })).toEqual({
      and: ["!priority.isEmpty()"],
    });
  });

  it("round-trips between through parseNumberFilter", () => {
    const built = buildNumberFilter("n", { op: "between", value: "2", value2: "8" });
    expect(parseNumberFilter(built)).toEqual({ op: "between", value: "2", value2: "8" });
  });
});

describe("text filter", () => {
  it("lowers to a quoted contains", () => {
    expect(buildTextFilter("note", "hello")).toEqual({ and: ['note.contains("hello")'] });
  });
  it("clears (null) when blank", () => {
    expect(buildTextFilter("note", "   ")).toBeNull();
  });
});

describe("checkbox filter", () => {
  it("emits an unquoted boolean equality", () => {
    expect(buildCheckboxFilter("done", "checked")).toEqual({ and: ["done == true"] });
    expect(buildCheckboxFilter("done", "unchecked")).toEqual({ and: ["done == false"] });
  });
  it("clears (null) for 'any'", () => {
    expect(buildCheckboxFilter("done", "any")).toBeNull();
  });
});

describe("date filter — day-boundary lowering", () => {
  const D = (op: DateFilterState["op"], date = "", date2 = ""): DateFilterState => ({
    op,
    date,
    date2,
  });

  it("is → same-day range", () => {
    expect(buildDateFilter("due", D("is", "2025-09-30"))).toEqual({
      and: ['due >= "2025-09-30"', 'due < "2025-10-01"'],
    });
  });

  it("after → from the next day on", () => {
    expect(buildDateFilter("due", D("after", "2025-09-30"))).toEqual({
      and: ['due >= "2025-10-01"'],
    });
  });

  it("before → strictly before the day", () => {
    expect(buildDateFilter("due", D("before", "2025-09-30"))).toEqual({
      and: ['due < "2025-09-30"'],
    });
  });

  it("within → inclusive range to the end of the second day", () => {
    expect(buildDateFilter("due", D("within", "2025-09-01", "2025-09-30"))).toEqual({
      and: ['due >= "2025-09-01"', 'due < "2025-10-01"'],
    });
  });

  it("empty / notEmpty", () => {
    expect(buildDateFilter("due", D("empty"))).toEqual({ and: ["due.isEmpty()"] });
    expect(buildDateFilter("due", D("notEmpty"))).toEqual({ and: ["!due.isEmpty()"] });
  });

  it("clears (null) before a date is chosen", () => {
    expect(buildDateFilter("due", D("is"))).toBeNull();
  });
});

describe("matchesDateFilter — Agenda predicate", () => {
  const D = (op: DateFilterState["op"], date = "", date2 = ""): DateFilterState => ({
    op,
    date,
    date2,
  });

  it("is matches only that calendar day", () => {
    const f = D("is", "2025-09-30");
    expect(matchesDateFilter("2025-09-30", f)).toBe(true);
    expect(matchesDateFilter("2025-09-30T14:00", f)).toBe(true); // datetime same day
    expect(matchesDateFilter("2025-10-01", f)).toBe(false);
    expect(matchesDateFilter("2025-09-29", f)).toBe(false);
  });

  it("within matches the inclusive range", () => {
    const f = D("within", "2025-09-01", "2025-09-30");
    expect(matchesDateFilter("2025-09-01", f)).toBe(true);
    expect(matchesDateFilter("2025-09-30", f)).toBe(true);
    expect(matchesDateFilter("2025-10-01", f)).toBe(false);
  });

  it("before / after", () => {
    expect(matchesDateFilter("2025-09-29", D("before", "2025-09-30"))).toBe(true);
    expect(matchesDateFilter("2025-09-30", D("before", "2025-09-30"))).toBe(false);
    expect(matchesDateFilter("2025-10-01", D("after", "2025-09-30"))).toBe(true);
    expect(matchesDateFilter("2025-09-30", D("after", "2025-09-30"))).toBe(false);
  });

  it("empty / notEmpty", () => {
    expect(matchesDateFilter("", D("empty"))).toBe(true);
    expect(matchesDateFilter(null, D("empty"))).toBe(true);
    expect(matchesDateFilter("2025-09-30", D("empty"))).toBe(false);
    expect(matchesDateFilter("2025-09-30", D("notEmpty"))).toBe(true);
    expect(matchesDateFilter("", D("notEmpty"))).toBe(false);
  });

  it("an unset date imposes no constraint (everything matches)", () => {
    expect(matchesDateFilter("2025-09-30", D("is"))).toBe(true);
    expect(matchesDateFilter(null, D("is"))).toBe(true);
  });

  it("a relational op never matches an empty value", () => {
    expect(matchesDateFilter("", D("onOrAfter", "2025-01-01"))).toBe(false);
  });

  it("round-trips is/within through parseDateFilter", () => {
    expect(parseDateFilter(buildDateFilter("due", D("is", "2025-09-30")))).toEqual(
      D("is", "2025-09-30"),
    );
    expect(parseDateFilter(buildDateFilter("due", D("within", "2025-09-01", "2025-09-30")))).toEqual(
      D("within", "2025-09-01", "2025-09-30"),
    );
  });
});
