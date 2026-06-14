// Shared leaf-expression (de)serialization for the collection filter DSL.
//
// A "leaf" is a single property/operator/value triple that the backend
// evaluates (`prop.contains("x")`, `prop >= "2025-01-01"`, …). Both the
// advanced FilterBuilder and the per-column header filters
// (ColumnFilterPopover, column-filter.ts) build the same expression strings,
// so the serializer lives here, in one place, rather than being duplicated.

/** A single filter clause in editable form. `value` is unused for the
 *  empty/not-empty operators. */
export interface FilterRow {
  property: string;
  operator: string;
  value: string;
}

/** Parse a filter expression string into a FilterRow for the UI. Unrecognized
 *  syntax falls back to an equality row carrying the raw text as the property,
 *  so a hand-authored expression is never silently dropped. */
export function parseFilterRow(expr: string): FilterRow {
  const trimmed = expr.trim();

  // Negated isEmpty: !prop.isEmpty()
  const negIsEmpty = trimmed.match(/^!(.+)\.isEmpty\(\)$/);
  if (negIsEmpty) {
    return { property: negIsEmpty[1], operator: "!.isEmpty", value: "" };
  }

  // isEmpty: prop.isEmpty()
  const isEmpty = trimmed.match(/^(.+)\.isEmpty\(\)$/);
  if (isEmpty) {
    return { property: isEmpty[1], operator: ".isEmpty", value: "" };
  }

  // Negated contains: !prop.contains("value"). Checked before the plain
  // contains/isEmpty cases so the leading "!" isn't swallowed into the
  // property name.
  const negContains = trimmed.match(/^!(.+)\.contains\("(.*)"\)$/);
  if (negContains) {
    return { property: negContains[1], operator: "!.contains", value: negContains[2] };
  }

  // contains: prop.contains("value")
  const methodCall = trimmed.match(/^(.+)\.contains\("(.*)"\)$/);
  if (methodCall) {
    return { property: methodCall[1], operator: ".contains", value: methodCall[2] };
  }

  // Comparison: prop OP value, where OP is ==, !=, <=, >=, < or >. Two-char
  // operators are listed first in the alternation so `<=`/`>=` aren't split.
  const comparison = trimmed.match(/^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
  if (comparison) {
    let val = comparison[3].trim();
    // Strip quotes from string values
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return { property: comparison[1].trim(), operator: comparison[2], value: val };
  }

  // Fallback: treat as raw expression
  return { property: trimmed, operator: "==", value: "" };
}

/** Operators that compare against a literal value (everything except the
 *  empty/not-empty predicates). Shared so callers can decide whether a value
 *  input is needed. */
export const RELATIONAL_OPERATORS = ["==", "!=", "<", "<=", ">", ">="] as const;

/** Serialize a FilterRow back to a filter expression string, or "" when the
 *  row has no property yet (such rows are dropped on save). */
export function serializeFilterRow(row: FilterRow): string {
  const prop = row.property.trim();
  if (!prop) return "";

  switch (row.operator) {
    case ".isEmpty":
      return `${prop}.isEmpty()`;
    case "!.isEmpty":
      return `!${prop}.isEmpty()`;
    case ".contains":
      return `${prop}.contains("${row.value}")`;
    case "!.contains":
      return `!${prop}.contains("${row.value}")`;
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const val = row.value.trim();
      // Booleans, numbers, and property references (this.*, file.*, note[…])
      // are emitted unquoted — quoting a reference like `this.file.name`
      // would compare against that literal string instead of the referenced
      // value, breaking e.g. the default self-exclusion row.
      if (
        val === "true" ||
        val === "false" ||
        (val !== "" && !isNaN(Number(val))) ||
        /^(this\.|file\.|note\[)/.test(val)
      ) {
        return `${prop} ${row.operator} ${val}`;
      }
      return `${prop} ${row.operator} "${val}"`;
    }
    default:
      return `${prop} ${row.operator} "${row.value}"`;
  }
}
