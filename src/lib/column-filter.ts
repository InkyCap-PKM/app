// Type-aware per-column filters for collections.
//
// Each column header offers a quick filter shaped to the column's property
// type. This module is the single source of truth for:
//   • which operators each type offers,
//   • how a chosen operator + value(s) lower to the backend filter DSL
//     (`FilterGroup` of expression strings — see filter-expr.ts), and
//   • the equivalent client-side predicate the Agenda uses for its date filter
//     (the Agenda filters an already-fetched list in TS rather than re-querying
//     the backend).
//
// Date operators never need backend date math: they lower to day-boundary
// range comparisons over ISO-8601 strings, which the Rust evaluator compares
// lexically (chronologically correct for ISO dates). "is within" and numeric
// "between" likewise decompose into two relational comparisons ANDed together,
// so no new backend operator is required beyond `< <= > >=`.

import type { FilterGroup, PropertyType } from "./types";
import { type FilterRow, parseFilterRow, serializeFilterRow } from "./filter-expr";
import { compareName } from "./sort";

/** The control shape a column header presents, derived from its property type.
 *  `list` and `commalist` both render a multi-select checklist but lower to
 *  different operators (membership vs. substring). */
export type ColumnFilterKind = "list" | "commalist" | "text" | "number" | "date" | "checkbox";

/** Fixed types for the filesystem-derived `file.*` columns. These are NOT
 *  declared property types and must never be inferred from cell content — a
 *  notebox of `YYYY-MM-DD.typ` files would otherwise make `file.name` look like
 *  a date and offer the wrong filter. Names/paths are text; the stat
 *  timestamps are ISO dates (`file.ctime`/`file.mtime` are RFC3339, which sort
 *  chronologically); the byte size is numeric. */
const FILE_COLUMN_TYPES: Record<string, PropertyType> = {
  "file.name": "text",
  "file.folder": "text",
  "file.path": "text",
  "file.ext": "text",
  "file.ctime": "date",
  "file.mtime": "date",
  "file.size": "number",
};

/** The fixed type for a `file.*` column, or `undefined` for any other key. */
export function fileColumnType(col: string): PropertyType | undefined {
  return FILE_COLUMN_TYPES[col];
}

/** Resolve a property type to the header-filter control it should use. `auto`
 *  is treated as text; callers that can infer a concrete type from values
 *  should do so before calling this. */
export function columnFilterKind(type: PropertyType): ColumnFilterKind {
  switch (type) {
    case "list":
      return "list";
    case "commalist":
      return "commalist";
    case "number":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "checkbox":
      return "checkbox";
    case "text":
    case "auto":
    default:
      return "text";
  }
}

// ── Date filter ───────────────────────────────────────────────────────

/** The AnyType-style date operators. `within` uses two dates; `empty` /
 *  `notEmpty` use none. */
export type DateOp =
  | "is"
  | "after"
  | "before"
  | "onOrAfter"
  | "onOrBefore"
  | "within"
  | "empty"
  | "notEmpty";

export interface DateFilterState {
  op: DateOp;
  /** Primary value: a fixed `YYYY-MM-DD`, a relative `@today±N` token (see
   *  the relative-date helpers below), or `""` until the user picks one. */
  date: string;
  /** End value for `within` (same shape as {@link date}). */
  date2: string;
}

export const DEFAULT_DATE_FILTER: DateFilterState = { op: "is", date: "", date2: "" };

/** Date operators in menu order, with the i18n key for each label. */
export const DATE_OPS: { value: DateOp; labelKey: string }[] = [
  { value: "is", labelKey: "columnFilter.date.is" },
  { value: "after", labelKey: "columnFilter.date.after" },
  { value: "before", labelKey: "columnFilter.date.before" },
  { value: "onOrAfter", labelKey: "columnFilter.date.onOrAfter" },
  { value: "onOrBefore", labelKey: "columnFilter.date.onOrBefore" },
  { value: "within", labelKey: "columnFilter.date.within" },
  { value: "empty", labelKey: "columnFilter.date.empty" },
  { value: "notEmpty", labelKey: "columnFilter.date.notEmpty" },
];

// ── Relative dates ("today ± N days") ─────────────────────────────────
//
// A date filter value is either a fixed `YYYY-MM-DD` string or a relative
// token anchored to the current day: `@today`, `@today+N`, or `@today-N`
// (N = whole days, so `@today` means today, `@today+7` a week out, `@today-1`
// yesterday). Relative tokens are stored symbolically and resolved to a
// concrete date only at evaluation time — by the Rust filter evaluator for
// collections (filter.rs `resolve_relative_date`) and by `matchesDateFilter`
// below for the Agenda. Storing them symbolically is what keeps a saved
// "within the next 7 days" filter meaning the next 7 days every session
// instead of freezing to the day it was created.

const REL_PREFIX = "@today";

/** True when `v` is a relative `@today±N` token rather than a fixed date. */
export function isRelativeDate(v: string): boolean {
  return v.trim().startsWith(REL_PREFIX);
}

/** The day offset of a relative token (`@today` → 0, `@today+7` → 7,
 *  `@today-3` → -3), or `null` when `v` is not a relative token. */
export function relativeOffset(v: string): number | null {
  if (!isRelativeDate(v)) return null;
  const rest = v.trim().slice(REL_PREFIX.length);
  if (rest === "") return 0;
  const n = Number(rest);
  return Number.isInteger(n) ? n : null;
}

/** Canonical token for a day offset: `@today`, `@today+N`, or `@today-N`. */
export function makeRelativeDate(offset: number): string {
  if (offset === 0) return REL_PREFIX;
  return `${REL_PREFIX}${offset > 0 ? "+" : "-"}${Math.abs(offset)}`;
}

/** Today as a local `YYYY-MM-DD` (matching the backend's `Local::now`), so the
 *  Agenda's in-memory resolution agrees with the collection evaluator. */
export function localTodayISO(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(
    n.getDate(),
  ).padStart(2, "0")}`;
}

/** Resolve a filter value to a concrete `YYYY-MM-DD`: relative tokens against
 *  `today`, fixed dates returned unchanged. */
export function resolveRelativeDate(v: string, today = localTodayISO()): string {
  const off = relativeOffset(v);
  if (off === null) return v;
  return shiftDayFixed(today, off);
}

// Day arithmetic on a fixed date, in UTC so a local timezone never shifts the
// boundary across midnight. Input/output are bare `YYYY-MM-DD` strings.
function shiftDayFixed(iso: string, delta: number): string {
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Shift a date filter *value* by whole days, preserving its kind: a relative
// token shifts its offset (so `nextDay("@today")` is `"@today+1"`) while a
// fixed date shifts its calendar day. This lets the single lowering in
// `dateClauses` treat both kinds uniformly.
function shiftDay(value: string, delta: number): string {
  const off = relativeOffset(value);
  if (off !== null) return makeRelativeDate(off + delta);
  return shiftDayFixed(value, delta);
}
const nextDay = (v: string) => shiftDay(v, 1);
const prevDay = (v: string) => shiftDay(v, -1);

/** A single lowered comparison: an ordered bound, or an emptiness predicate. */
type DateClause =
  | { kind: "cmp"; op: ">=" | "<"; bound: string }
  | { kind: "empty" }
  | { kind: "notEmpty" };

/** Lower a date filter to the comparison clauses it represents. The one place
 *  the operator semantics live — both the expression builder and the Agenda
 *  predicate read from here, so they can never diverge. Returns `[]` when the
 *  filter is incomplete (no date chosen yet), meaning "no constraint". */
function dateClauses(f: DateFilterState): DateClause[] {
  if (f.op === "empty") return [{ kind: "empty" }];
  if (f.op === "notEmpty") return [{ kind: "notEmpty" }];
  if (!f.date) return [];
  switch (f.op) {
    case "is":
      return [
        { kind: "cmp", op: ">=", bound: f.date },
        { kind: "cmp", op: "<", bound: nextDay(f.date) },
      ];
    case "after":
      return [{ kind: "cmp", op: ">=", bound: nextDay(f.date) }];
    case "before":
      return [{ kind: "cmp", op: "<", bound: f.date }];
    case "onOrAfter":
      return [{ kind: "cmp", op: ">=", bound: f.date }];
    case "onOrBefore":
      return [{ kind: "cmp", op: "<", bound: nextDay(f.date) }];
    case "within": {
      const start: DateClause = { kind: "cmp", op: ">=", bound: f.date };
      if (!f.date2) return [start];
      return [start, { kind: "cmp", op: "<", bound: nextDay(f.date2) }];
    }
    default:
      return [];
  }
}

function clauseToExpr(prop: string, c: DateClause): string {
  if (c.kind === "empty") return serializeFilterRow({ property: prop, operator: ".isEmpty", value: "" });
  if (c.kind === "notEmpty") return serializeFilterRow({ property: prop, operator: "!.isEmpty", value: "" });
  return serializeFilterRow({ property: prop, operator: c.op, value: c.bound });
}

/** Build the backend FilterGroup for a date column filter, or `null` when the
 *  filter is empty (no constraint → clear the column). */
export function buildDateFilter(prop: string, f: DateFilterState): FilterGroup | null {
  const clauses = dateClauses(f);
  if (clauses.length === 0) return null;
  return { and: clauses.map((c) => clauseToExpr(prop, c)) };
}

/** Client-side predicate matching the same semantics as {@link buildDateFilter},
 *  for the Agenda (which filters an in-memory list). ISO strings compare
 *  lexically, exactly as the Rust evaluator does. */
export function matchesDateFilter(value: string | null, f: DateFilterState): boolean {
  const clauses = dateClauses(f);
  if (clauses.length === 0) return true;
  const v = (value ?? "").trim();
  const today = localTodayISO();
  return clauses.every((c) => {
    if (c.kind === "empty") return v === "";
    if (c.kind === "notEmpty") return v !== "";
    if (v === "") return false;
    const bound = resolveRelativeDate(c.bound, today);
    return c.op === ">=" ? v >= bound : v < bound;
  });
}

/** True when the date filter expresses an actual constraint (so the header
 *  shows its active indicator). */
export function isDateFilterActive(f: DateFilterState): boolean {
  return dateClauses(f).length > 0;
}

/** Recover an editable date-filter state from a saved FilterGroup. Best-effort:
 *  it returns a state that is *equivalent* to the saved filter, not necessarily
 *  the exact operator originally chosen (e.g. a lone `>=` reads back as
 *  `onOrAfter`, which produces the identical query). */
export function parseDateFilter(group: FilterGroup | undefined | null): DateFilterState {
  const rows = leafRows(group);
  if (rows.some((r) => r.operator === ".isEmpty")) return { op: "empty", date: "", date2: "" };
  if (rows.some((r) => r.operator === "!.isEmpty")) return { op: "notEmpty", date: "", date2: "" };
  const ge = rows.find((r) => r.operator === ">=");
  const lt = rows.find((r) => r.operator === "<");
  if (ge && lt) {
    if (lt.value === nextDay(ge.value)) return { op: "is", date: ge.value, date2: "" };
    return { op: "within", date: ge.value, date2: prevDay(lt.value) };
  }
  if (ge) return { op: "onOrAfter", date: ge.value, date2: "" };
  if (lt) return { op: "before", date: lt.value, date2: "" };
  return { ...DEFAULT_DATE_FILTER };
}

// ── Number filter ─────────────────────────────────────────────────────

export type NumberOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "between" | "empty" | "notEmpty";

export interface NumberFilterState {
  op: NumberOp;
  value: string;
  /** Upper bound for `between`. */
  value2: string;
}

export const DEFAULT_NUMBER_FILTER: NumberFilterState = { op: "==", value: "", value2: "" };

export const NUMBER_OPS: { value: NumberOp; labelKey: string }[] = [
  { value: "==", labelKey: "columnFilter.number.eq" },
  { value: "!=", labelKey: "columnFilter.number.ne" },
  { value: "<", labelKey: "columnFilter.number.lt" },
  { value: "<=", labelKey: "columnFilter.number.le" },
  { value: ">", labelKey: "columnFilter.number.gt" },
  { value: ">=", labelKey: "columnFilter.number.ge" },
  { value: "between", labelKey: "columnFilter.number.between" },
  { value: "empty", labelKey: "columnFilter.number.empty" },
  { value: "notEmpty", labelKey: "columnFilter.number.notEmpty" },
];

export function buildNumberFilter(prop: string, f: NumberFilterState): FilterGroup | null {
  if (f.op === "empty") {
    return { and: [serializeFilterRow({ property: prop, operator: ".isEmpty", value: "" })] };
  }
  if (f.op === "notEmpty") {
    return { and: [serializeFilterRow({ property: prop, operator: "!.isEmpty", value: "" })] };
  }
  if (f.op === "between") {
    if (f.value.trim() === "" || f.value2.trim() === "") return null;
    return {
      and: [
        serializeFilterRow({ property: prop, operator: ">=", value: f.value.trim() }),
        serializeFilterRow({ property: prop, operator: "<=", value: f.value2.trim() }),
      ],
    };
  }
  if (f.value.trim() === "") return null;
  return { and: [serializeFilterRow({ property: prop, operator: f.op, value: f.value.trim() })] };
}

export function parseNumberFilter(group: FilterGroup | undefined | null): NumberFilterState {
  const rows = leafRows(group);
  if (rows.some((r) => r.operator === ".isEmpty")) return { op: "empty", value: "", value2: "" };
  if (rows.some((r) => r.operator === "!.isEmpty")) return { op: "notEmpty", value: "", value2: "" };
  const ge = rows.find((r) => r.operator === ">=");
  const le = rows.find((r) => r.operator === "<=");
  if (ge && le) return { op: "between", value: ge.value, value2: le.value };
  const single = rows[0];
  if (single) return { op: single.operator as NumberOp, value: single.value, value2: "" };
  return { ...DEFAULT_NUMBER_FILTER };
}

// ── Text filter ───────────────────────────────────────────────────────

export function buildTextFilter(prop: string, contains: string): FilterGroup | null {
  const v = contains.trim();
  if (!v) return null;
  return { and: [serializeFilterRow({ property: prop, operator: ".contains", value: v })] };
}

export function parseTextFilter(group: FilterGroup | undefined | null): string {
  const row = leafRows(group).find((r) => r.operator === ".contains");
  return row?.value ?? "";
}

// ── Multi-select (list / commalist) ───────────────────────────────────

/** Build the OR-of-equality (list) or OR-of-contains (commalist) group for a
 *  multi-select. A list cell is an array, so `==` tests membership; a commalist
 *  cell is one comma-joined string, so `.contains` tests for the value. */
export function buildMultiSelectFilter(
  prop: string,
  selected: string[],
  kind: "list" | "commalist",
): FilterGroup | null {
  if (selected.length === 0) return null;
  const operator = kind === "commalist" ? ".contains" : "==";
  return { or: selected.map((v) => serializeFilterRow({ property: prop, operator, value: v })) };
}

export function parseMultiSelectFilter(group: FilterGroup | undefined | null): string[] {
  const members = group?.or ?? group?.and ?? [];
  return members
    .filter((m): m is string => typeof m === "string")
    .map(parseFilterRow)
    .filter((r) => r.operator === "==" || r.operator === ".contains")
    .map((r) => r.value);
}

/** Split a column's raw facet values into the distinct options a multi-select
 *  should show. For commalist columns each cell is one comma-joined string, so
 *  it is split into its parts; list columns already arrive as separate values. */
export function multiSelectOptions(rawValues: string[], kind: "list" | "commalist"): string[] {
  if (kind === "list") return rawValues;
  const set = new Set<string>();
  for (const raw of rawValues) {
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (v) set.add(v);
    }
  }
  return Array.from(set).sort((a, b) => compareName(a, b));
}

// ── Checkbox filter ───────────────────────────────────────────────────

export type CheckboxState = "any" | "checked" | "unchecked";

export function buildCheckboxFilter(prop: string, state: CheckboxState): FilterGroup | null {
  if (state === "any") return null;
  const value = state === "checked" ? "true" : "false";
  return { and: [serializeFilterRow({ property: prop, operator: "==", value })] };
}

export function parseCheckboxFilter(group: FilterGroup | undefined | null): CheckboxState {
  const row = leafRows(group).find((r) => r.operator === "==");
  if (!row) return "any";
  return row.value === "true" ? "checked" : "unchecked";
}

// ── Shared ────────────────────────────────────────────────────────────

/** Flatten a group's leaf expression strings (from either `and` or `or`) into
 *  parsed rows. Header filters only ever produce single-combinator groups, so
 *  reading both is enough to recover their state. */
function leafRows(group: FilterGroup | undefined | null): FilterRow[] {
  const members = [...(group?.and ?? []), ...(group?.or ?? [])];
  return members.filter((m): m is string => typeof m === "string").map(parseFilterRow);
}
