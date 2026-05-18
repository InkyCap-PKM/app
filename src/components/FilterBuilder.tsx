import {
  Component,
  createSignal,
  For,
  Index,
  Show,
} from "solid-js";
import type { FilterGroup } from "../lib/types";
import { Dropdown } from "./Dropdown";

/** Operators available in the filter builder. */
const OPERATORS = [
  { value: "==", label: "equals" },
  { value: "!=", label: "not equals" },
  { value: ".contains", label: "contains" },
  { value: ".containsAny", label: "contains any" },
  { value: ".isEmpty", label: "is empty" },
  { value: "!.isEmpty", label: "is not empty" },
] as const;

type Combinator = "and" | "or";

interface FilterRow {
  property: string;
  operator: string;
  value: string;
}

/** Parse a filter expression string into a FilterRow for the UI. */
function parseFilterRow(expr: string): FilterRow {
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

  // contains/containsAny: prop.method("value")
  const methodCall = trimmed.match(/^(.+)\.(contains|containsAny)\("(.*)"\)$/);
  if (methodCall) {
    return {
      property: methodCall[1],
      operator: `.${methodCall[2]}`,
      value: methodCall[3],
    };
  }

  // Comparison: prop == value or prop != value
  const comparison = trimmed.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
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

/** Serialize a FilterRow back to a filter expression string. */
function serializeFilterRow(row: FilterRow): string {
  const prop = row.property.trim();
  if (!prop) return "";

  switch (row.operator) {
    case ".isEmpty":
      return `${prop}.isEmpty()`;
    case "!.isEmpty":
      return `!${prop}.isEmpty()`;
    case ".contains":
      return `${prop}.contains("${row.value}")`;
    case ".containsAny":
      return `${prop}.containsAny("${row.value}")`;
    case "==":
    case "!=": {
      const val = row.value.trim();
      // Booleans and numbers don't need quotes
      if (val === "true" || val === "false" || !isNaN(Number(val))) {
        return `${prop} ${row.operator} ${val}`;
      }
      return `${prop} ${row.operator} "${val}"`;
    }
    default:
      return `${prop} ${row.operator} "${row.value}"`;
  }
}

const FilterBuilder: Component<{
  filters: FilterGroup | null | undefined;
  allKeys: string[];
  onSave: (filters: FilterGroup | null) => void;
  onClose: () => void;
}> = (props) => {
  // Parse initial state
  const initial = props.filters;
  const initialCombinator: Combinator = initial?.or ? "or" : "and";
  const initialExpressions = initial?.or ?? initial?.and ?? [];
  const initialRows = initialExpressions.map((expr) =>
    parseFilterRow(typeof expr === "string" ? expr : String(expr)),
  );

  const [combinator, setCombinator] = createSignal<Combinator>(initialCombinator);
  const [rows, setRows] = createSignal<FilterRow[]>(
    initialRows.length > 0 ? initialRows : [],
  );

  function addRow() {
    setRows([...rows(), { property: "file.name", operator: "==", value: "" }]);
  }

  function removeRow(index: number) {
    setRows(rows().filter((_, i) => i !== index));
  }

  function updateRow(index: number, field: keyof FilterRow, value: string) {
    setRows(
      rows().map((r, i) =>
        i === index ? { ...r, [field]: value } : r,
      ),
    );
  }

  function handleSave() {
    const expressions = rows()
      .map(serializeFilterRow)
      .filter(Boolean);

    if (expressions.length === 0) {
      props.onSave(null);
    } else if (combinator() === "or") {
      props.onSave({ or: expressions });
    } else {
      props.onSave({ and: expressions });
    }
  }

  return (
    <div class="filter-builder">
      <div class="filter-builder__header">
        <span>Filters</span>
        <div class="filter-builder__actions">
          <button class="filter-builder__btn" onClick={handleSave}>
            Apply
          </button>
          <button class="filter-builder__btn filter-builder__btn--secondary" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>

      <Show when={rows().length > 0}>
        <div class="filter-builder__combinator">
          <label>
            <input
              type="radio"
              name="combinator"
              checked={combinator() === "and"}
              onChange={() => setCombinator("and")}
            />
            Match ALL (AND)
          </label>
          <label>
            <input
              type="radio"
              name="combinator"
              checked={combinator() === "or"}
              onChange={() => setCombinator("or")}
            />
            Match ANY (OR)
          </label>
        </div>
      </Show>

      <div class="filter-builder__rows">
        <Index each={rows()}>
          {(row, index) => (
            <div class="filter-builder__row">
              <input
                class="filter-builder__input filter-builder__input--property"
                type="text"
                list="filter-property-keys"
                value={row().property}
                onInput={(e) => updateRow(index, "property", e.currentTarget.value)}
                placeholder="property"
              />

              <Dropdown
                value={row().operator}
                options={OPERATORS.map((op) => ({
                  value: op.value as string,
                  label: op.label,
                }))}
                onChange={(v) => updateRow(index, "operator", v)}
                ariaLabel="Filter operator"
              />

              <Show when={row().operator !== ".isEmpty" && row().operator !== "!.isEmpty"}>
                <input
                  class="filter-builder__input filter-builder__input--value"
                  type="text"
                  value={row().value}
                  onInput={(e) => updateRow(index, "value", e.currentTarget.value)}
                  placeholder="value"
                />
              </Show>

              <button
                class="filter-builder__remove"
                onClick={() => removeRow(index)}
                title="Remove filter"
              >
                &times;
              </button>
            </div>
          )}
        </Index>
      </div>

      <button class="filter-builder__add" onClick={addRow}>
        + Add filter
      </button>

      {/* Datalist for property key suggestions */}
      <datalist id="filter-property-keys">
        <For each={props.allKeys}>
          {(key) => <option value={key} />}
        </For>
      </datalist>
    </div>
  );
};

export default FilterBuilder;
