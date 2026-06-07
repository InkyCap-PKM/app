import { describe, it, expect } from "vitest";
import { parseCanonicalTable, serializeTable } from "./table-parser";

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

  // A styled table (stroke / inset / fill / …) must still render as a widget.
  // Those named args are preserved verbatim on `extraArgs` and re-emitted on
  // serialize so the styling round-trips losslessly through a cell edit.
  it("preserves unmodelled named args instead of rejecting the table", () => {
    const t = parseCanonicalTable(
      "#table(\n  columns: 2,\n  stroke: 0.5pt + luma(200),\n  inset: 7pt,\n" +
        "  [*Operator*], [*What it does*],\n  [`OR`], [Either term may appear.],\n)",
    );
    expect(t).not.toBeNull();
    // Integer shorthand expands to per-column `auto`.
    expect(t!.columns).toEqual(["auto", "auto"]);
    expect(t!.extraArgs).toEqual([
      { key: "stroke", value: "0.5pt + luma(200)" },
      { key: "inset", value: "7pt" },
    ]);
    expect(t!.rows[0].map((c) => c.content)).toEqual(["*Operator*", "*What it does*"]);
  });

  it("round-trips preserved styling args through serialize", () => {
    const t = parseCanonicalTable(
      "#table(\n  columns: (auto, auto),\n  stroke: 0.5pt + luma(200),\n  inset: 7pt,\n" +
        "  [A], [B],\n)",
    );
    expect(t).not.toBeNull();
    const out = serializeTable(t!);
    // Re-parsing the serialized form yields the same preserved args.
    const again = parseCanonicalTable(out);
    expect(again).not.toBeNull();
    expect(again!.extraArgs).toEqual(t!.extraArgs);
    expect(out).toContain("stroke: 0.5pt + luma(200),");
    expect(out).toContain("inset: 7pt,");
  });

  it("preserves a non-array align/rows verbatim rather than dropping the table", () => {
    const t = parseCanonicalTable(
      "#table(\n  columns: (auto, auto),\n  align: center,\n  [A], [B],\n)",
    );
    expect(t).not.toBeNull();
    // A bare (non-array) align can't map to per-column handles, so it is kept
    // as an opaque arg, not modelled structurally.
    expect(t!.align).toBeNull();
    expect(t!.extraArgs).toEqual([{ key: "align", value: "center" }]);
  });
});
