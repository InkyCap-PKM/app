import { describe, it, expect } from "vitest";
import { parseCanonicalTable } from "./table-parser";

// The visual editor renders a `#table(...)` as an editable grid only when
// `parseCanonicalTable` recognizes it. A cell whose inline-raw content carries
// a literal `[` or `]` — common in a keyboard-shortcut reference, e.g.
// `[`Ctrl+Shift+]`]` — must not unbalance the cell's brackets and drop the
// whole table back to raw source.
describe("parseCanonicalTable", () => {
  it("parses a simple two-column table", () => {
    const t = parseCanonicalTable(
      "#table(\n  columns: (auto, auto),\n  table.header([Shortcut], [Action]),\n  [`Ctrl+/`], [Toggle the left sidebar],\n)",
    );
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual(["auto", "auto"]);
    expect(t!.header?.map((c) => c.content)).toEqual(["Shortcut", "Action"]);
    expect(t!.rows).toHaveLength(1);
    expect(t!.rows[0].map((c) => c.content)).toEqual(["`Ctrl+/`", "Toggle the left sidebar"]);
  });

  it("handles cells whose inline raw contains literal brackets", () => {
    const t = parseCanonicalTable(
      "#table(\n  columns: (auto, auto),\n" +
        "  [`Ctrl+Shift+]`], [Split the editor to the right],\n" +
        "  [`Ctrl+Shift+[`], [Split the editor downward],\n)",
    );
    expect(t).not.toBeNull();
    expect(t!.rows).toHaveLength(2);
    expect(t!.rows[0].map((c) => c.content)).toEqual([
      "`Ctrl+Shift+]`",
      "Split the editor to the right",
    ]);
    expect(t!.rows[1].map((c) => c.content)).toEqual([
      "`Ctrl+Shift+[`",
      "Split the editor downward",
    ]);
  });

  it("keeps the cell ranges pointing at the real bracket bounds", () => {
    const src = "#table(\n  columns: (auto, auto),\n  [`Ctrl+Shift+]`], [Done],\n)";
    const t = parseCanonicalTable(src);
    expect(t).not.toBeNull();
    const cell = t!.rows[0][0];
    // The recorded range must span the whole `[…]`, raw bracket included.
    expect(src.slice(cell.relFrom, cell.relTo)).toBe("[`Ctrl+Shift+]`]");
  });
});
