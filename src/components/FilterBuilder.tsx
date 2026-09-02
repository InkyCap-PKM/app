import { Component, Index, Show, createSignal } from "solid-js";
import type { FilterGroup, FilterNode } from "../lib/types";
import { Dropdown } from "./Dropdown";
import { propertyLabel } from "../lib/property-labels";
import { useI18n } from "../lib/i18n";
import {
  FILTER_OPERATORS,
  type FilterRow,
  parseFilterRow,
  serializeFilterRow,
} from "../lib/filter-expr";

/** Operators available in the filter builder. Labels resolve through i18n at
 *  render time (see `labelKey`). The relational operators (< ≤ > ≥) compare
 *  numerically or, for ISO dates, chronologically — see the Rust evaluator. */
const OPERATORS = FILTER_OPERATORS;

/** Group combinators, mapped to the backend `and`/`or`/`not` keys. The UI
 *  labels them All / Any / None, following the convention in the reference
 *  filter UIs (and reading naturally as "All of the following are true"). */
type Combinator = "and" | "or" | "not";

const COMBINATORS: { value: Combinator; labelKey: string }[] = [
  { value: "and", labelKey: "filter.combinator.all" },
  { value: "or", labelKey: "filter.combinator.any" },
  { value: "not", labelKey: "filter.combinator.none" },
];

/** How deep nested groups may go. Keeps the recursive UI bounded — three
 *  levels is already more than any realistic collection query needs. */
const MAX_DEPTH = 3;

// The editor works on a tree of nodes rather than raw expression strings so
// that nested groups can be added, edited, and removed in place. A node is
// either a leaf row (one property/operator/value triple) or a group with its
// own combinator and child nodes. The tree round-trips to the backend
// `FilterGroup` shape on save.
type LeafNode = { kind: "leaf"; row: FilterRow };
type GroupNode = { kind: "group"; combinator: Combinator; members: BuilderNode[] };
type BuilderNode = LeafNode | GroupNode;

// ── Tree ⇄ FilterGroup conversion ─────────────────────────────────────

/** Read a backend `FilterGroup` into an editable group node. The builder
 *  presents one combinator per group, so the first present of and/or/not
 *  wins — which is exactly what the builder ever writes back. */
function groupToNode(group: FilterGroup | null | undefined): GroupNode {
  let combinator: Combinator = "and";
  let members: FilterNode[] = [];
  if (group?.and) {
    combinator = "and";
    members = group.and;
  } else if (group?.or) {
    combinator = "or";
    members = group.or;
  } else if (group?.not) {
    combinator = "not";
    members = group.not;
  }
  return {
    kind: "group",
    combinator,
    members: members.map(memberToNode),
  };
}

function memberToNode(member: FilterNode): BuilderNode {
  if (typeof member === "string") {
    return { kind: "leaf", row: parseFilterRow(member) };
  }
  return groupToNode(member);
}

/** Serialize a node back to a `FilterNode`, or `null` when it carries nothing
 *  worth saving (an empty row, or a group with no non-empty members). */
function nodeToMember(node: BuilderNode): FilterNode | null {
  if (node.kind === "leaf") {
    return serializeFilterRow(node.row) || null;
  }
  return groupToFilter(node);
}

function groupToFilter(node: GroupNode): FilterGroup | null {
  const members = node.members
    .map(nodeToMember)
    .filter((m): m is FilterNode => m !== null);
  if (members.length === 0) return null;
  return { [node.combinator]: members };
}

// ── Leaf row editor ───────────────────────────────────────────────────

/** Build the property-picker options for a leaf row. `file.*` keys get their
 *  friendly label (matching the column headers); user-authored properties show
 *  verbatim. The two are split into "Properties" and "File" groups, and the
 *  row's current property is injected if it isn't in `allKeys` — so editing a
 *  filter that references a since-removed property never silently drops it. */
function propertyOptions(
  allKeys: string[],
  current: string,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  const keys = current && !allKeys.includes(current) ? [...allKeys, current] : allKeys;
  const toOption = (key: string, group: string) => ({
    value: key,
    label: propertyLabel(key),
    group,
  });
  return [
    ...keys.filter((k) => !k.startsWith("file.")).map((k) => toOption(k, t("filter.group.properties"))),
    ...keys.filter((k) => k.startsWith("file.")).map((k) => toOption(k, t("filter.group.file"))),
  ];
}

/** One property/operator/value row. Exported so other filter surfaces (the
 *  Mycelial exclusion editor) present the same row UI as the FilterBuilder. */
export const FilterRowEditor: Component<{
  row: FilterRow;
  allKeys: string[];
  onChange: (row: FilterRow) => void;
  onRemove: () => void;
}> = (props) => {
  const t = useI18n();
  const update = (field: keyof FilterRow, value: string) =>
    props.onChange({ ...props.row, [field]: value });

  return (
    <div class="filter-builder__row">
      <Dropdown<string>
        class="filter-builder__property-dropdown"
        value={props.row.property}
        options={propertyOptions(props.allKeys, props.row.property, t)}
        onChange={(v) => update("property", v)}
        placeholder={t("filter.property")}
        ariaLabel={t("filter.propertyAria")}
      />

      <Dropdown
        value={props.row.operator}
        options={OPERATORS.map((op) => ({ value: op.value as string, label: t(op.labelKey) }))}
        onChange={(v) => update("operator", v)}
        ariaLabel={t("filter.operatorAria")}
      />

      <Show when={props.row.operator !== ".isEmpty" && props.row.operator !== "!.isEmpty"}>
        <input
          class="filter-builder__input filter-builder__input--value"
          type="text"
          value={props.row.value}
          onInput={(e) => update("value", e.currentTarget.value)}
          placeholder={t("filter.value")}
        />
      </Show>

      <button
        class="filter-builder__remove"
        onClick={props.onRemove}
        title={t("filter.removeRow")}
        aria-label={t("filter.removeRow")}
      >
        ×
      </button>
    </div>
  );
};

// ── Group editor (recursive) ──────────────────────────────────────────

const FilterGroupEditor: Component<{
  group: GroupNode;
  allKeys: string[];
  onChange: (group: GroupNode) => void;
  /** Remove this group from its parent. Absent for the root group. */
  onRemove?: () => void;
  depth: number;
}> = (props) => {
  const t = useI18n();
  const setCombinator = (c: Combinator) =>
    props.onChange({ ...props.group, combinator: c });

  const updateMember = (i: number, node: BuilderNode) =>
    props.onChange({
      ...props.group,
      members: props.group.members.map((m, idx) => (idx === i ? node : m)),
    });

  const removeMember = (i: number) =>
    props.onChange({
      ...props.group,
      members: props.group.members.filter((_, idx) => idx !== i),
    });

  const addLeaf = () => {
    // Insert the new row just before the first nested group (or at the end if
    // there are none), so a group's own filter rows stay grouped together
    // above its sub-groups — order doesn't affect evaluation, only clarity.
    const members = props.group.members;
    const firstGroupIdx = members.findIndex((m) => m.kind === "group");
    const insertAt = firstGroupIdx === -1 ? members.length : firstGroupIdx;
    const newLeaf: BuilderNode = { kind: "leaf", row: { property: "", operator: "==", value: "" } };
    props.onChange({
      ...props.group,
      members: [...members.slice(0, insertAt), newLeaf, ...members.slice(insertAt)],
    });
  };

  const addGroup = () =>
    props.onChange({
      ...props.group,
      members: [
        ...props.group.members,
        // A nested group is almost always meant to mix combinators with its
        // parent, so seed it with the opposite of the parent's.
        { kind: "group", combinator: props.group.combinator === "and" ? "or" : "and", members: [] },
      ],
    });

  const isRoot = () => props.depth === 0;

  return (
    <div
      class="filter-builder__group"
      classList={{ "filter-builder__group--nested": !isRoot() }}
    >
      <div class="filter-builder__group-header">
        <Dropdown<Combinator>
          class="dropdown--sm"
          value={props.group.combinator}
          options={COMBINATORS.map((c) => ({ value: c.value, label: t(c.labelKey) }))}
          onChange={setCombinator}
          ariaLabel={t("filter.combinatorAria")}
        />
        <span class="filter-builder__group-caption">{t("filter.caption")}</span>
        <Show when={props.onRemove}>
          <button
            class="filter-builder__remove filter-builder__remove--group"
            onClick={() => props.onRemove?.()}
            title={t("filter.removeGroup")}
            aria-label={t("filter.removeGroup")}
          >
            ×
          </button>
        </Show>
      </div>

      <div class="filter-builder__rows">
        <Index each={props.group.members}>
          {(member, index) => (
            <Show
              when={member().kind === "group"}
              fallback={
                <FilterRowEditor
                  row={(member() as LeafNode).row}
                  allKeys={props.allKeys}
                  onChange={(row) => updateMember(index, { kind: "leaf", row })}
                  onRemove={() => removeMember(index)}
                />
              }
            >
              <FilterGroupEditor
                group={member() as GroupNode}
                allKeys={props.allKeys}
                onChange={(g) => updateMember(index, g)}
                onRemove={() => removeMember(index)}
                depth={props.depth + 1}
              />
            </Show>
          )}
        </Index>
      </div>

      <div class="filter-builder__add-row">
        <button class="filter-builder__add" onClick={addLeaf}>
          {t("filter.addRow")}
        </button>
        <Show when={props.depth < MAX_DEPTH}>
          <button class="filter-builder__add" onClick={addGroup}>
            {t("filter.addGroup")}
          </button>
        </Show>
      </div>
    </div>
  );
};

// ── Top-level builder ─────────────────────────────────────────────────

const FilterBuilder: Component<{
  filters: FilterGroup | null | undefined;
  allKeys: string[];
  onSave: (filters: FilterGroup | null) => void;
  onClose: () => void;
}> = (props) => {
  const t = useI18n();
  const [root, setRoot] = createSignal<GroupNode>(groupToNode(props.filters));

  const handleSave = () => props.onSave(groupToFilter(root()));

  return (
    <div class="filter-builder">
      <div class="filter-builder__header">
        <span>{t("filter.title")}</span>
        <div class="filter-builder__actions">
          <button class="btn btn--primary btn--sm" onClick={handleSave}>
            {t("common.apply")}
          </button>
          <button class="btn btn--secondary btn--sm" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>

      <FilterGroupEditor group={root()} allKeys={props.allKeys} onChange={setRoot} depth={0} />
    </div>
  );
};

export default FilterBuilder;
