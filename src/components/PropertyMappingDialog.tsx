/**
 * PropertyMappingDialog: the middle step of Markdown import.
 *
 * After the archive's YAML frontmatter is scanned, this shows each property
 * found and the InkyCap property it will map to. For each row the user can:
 *
 *   - map the YAML key to another system or existing property,
 *   - create a new property (and choose its type),
 *   - or leave the property out.
 *
 * System properties have fixed types (the type column is disabled). On confirm
 * the mappings go back to the importer.
 */

import { For, Show, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import * as ipc from "../lib/ipc";
import type { PropertyType } from "../lib/types";
import { compareName } from "../lib/sort";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { useI18n, tPlural } from "../lib/i18n";

/** An InkyCap property the YAML key can be mapped onto. */
export interface TargetOption {
  key: string;
  type: PropertyType;
  isSystem: boolean;
}

interface PropertyMappingDialogProps {
  rows: ipc.FrontmatterKeyInfo[];
  /** Existing system + user properties offered in the "Maps to" dropdown. */
  targets: TargetOption[];
  onConfirm: (mappings: ipc.PropertyMapping[]) => void;
  onCancel: () => void;
}

// Sentinel dropdown values that aren't real property keys.
const CREATE = "::create";
const SKIP = "::skip";

const TYPE_LABEL_KEYS: Record<PropertyType, string> = {
  auto: "property.type.auto",
  text: "property.type.text",
  number: "property.type.number",
  list: "property.type.list",
  commalist: "property.type.commalist",
  date: "property.type.date",
  datetime: "property.type.datetime",
  checkbox: "property.type.checkbox",
};

// Types a new property can be given. "auto" isn't offered: a new property
// always gets a real type (by default the one inferred from the YAML). Labels
// are translated when shown.
const TYPE_VALUES: PropertyType[] = [
  "text", "number", "list", "commalist", "date", "datetime", "checkbox",
];

/** Mirror of the backend `sanitize_ident` so "Create new" names are valid
 *  Typst identifiers and match what the importer would register. */
function sanitizeIdent(key: string): string {
  let out = "";
  let prevDash = false;
  for (const ch of key.trim()) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      out += ch.toLowerCase();
      prevDash = false;
    } else if (ch === "_" || ch === "-") {
      out += ch;
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  out = out.replace(/^-+|-+$/g, "");
  if (!out || !/[a-z]/.test(out[0])) {
    out = `field-${out}`.replace(/-+$/g, "");
  }
  return out;
}

interface RowSelection {
  // A real target key, or the CREATE / SKIP sentinel.
  choice: string;
  // Name and type of the property to create when choice === CREATE.
  createName: string;
  createType: PropertyType;
}

export function PropertyMappingDialog(props: PropertyMappingDialogProps) {
  const t = useI18n();
  const typeLabel = (type: PropertyType) => t(TYPE_LABEL_KEYS[type]);
  const typeOptions = (): DropdownOption<PropertyType>[] =>
    TYPE_VALUES.map((value) => ({ value, label: typeLabel(value) }));
  const [sel, setSel] = createStore<RowSelection[]>(
    props.rows.map((row) => ({
      choice: row.will_create ? CREATE : row.suggested_target,
      // Default new-property name: the backend's suggestion (already a valid,
      // non-system identifier) when creating, else the sanitized source key.
      createName: row.will_create ? row.suggested_target : sanitizeIdent(row.source_key),
      createType: row.suggested_type,
    })),
  );

  const systemTargets = createMemo(() => props.targets.filter((t) => t.isSystem));
  const userTargets = createMemo(() =>
    props.targets.filter((t) => !t.isSystem).sort((a, b) => compareName(a.key, b.key)),
  );

  // System property names are reserved: a user may map onto them but must not
  // create a new property that shadows one. Case-insensitive.
  const systemNames = createMemo(
    () => new Set(systemTargets().map((t) => t.key.toLowerCase())),
  );

  // "Create new" (named after the YAML key by default) is always offered, along
  // with any existing property and excluding it.
  const targetOptions = (): DropdownOption<string>[] => [
    { value: CREATE, label: t("import.mapping.createNew"), group: t("import.mapping.groupNewExclude") },
    { value: SKIP, label: t("import.mapping.dontImport"), group: t("import.mapping.groupNewExclude") },
    ...systemTargets().map((opt) => ({ value: opt.key, label: opt.key, group: t("import.mapping.groupSystem") })),
    ...userTargets().map((opt) => ({ value: opt.key, label: opt.key, group: t("import.mapping.groupUser") })),
  ];

  // The type a row's values are formatted as: fixed for an existing or system
  // property, chosen for a new one. An existing property still set to "auto"
  // uses the type inferred from the YAML, so the locked Type cell never shows
  // "Auto".
  const effectiveType = (i: number): PropertyType => {
    const s = sel[i];
    if (s.choice === CREATE) return s.createType;
    if (s.choice === SKIP) return props.rows[i].inferred_type;
    const t = props.targets.find((t) => t.key === s.choice)?.type ?? "auto";
    return t === "auto" ? props.rows[i].inferred_type : t;
  };

  const typeLocked = (i: number) => sel[i].choice !== CREATE;

  // A new-property name is invalid if empty or if it collides with a reserved
  // system property name (which would attempt to hijack/duplicate it).
  const createNameError = (i: number): string | null => {
    if (sel[i].choice !== CREATE) return null;
    const name = sel[i].createName.trim();
    if (!name) return t("import.mapping.errEmpty");
    if (systemNames().has(name.toLowerCase())) {
      return t("import.mapping.errSystem", { name });
    }
    return null;
  };

  const includedCount = createMemo(() => sel.filter((s) => s.choice !== SKIP).length);
  const hasErrors = createMemo(() => props.rows.some((_, i) => createNameError(i) !== null));

  function confirm() {
    if (hasErrors()) return;
    const mappings: ipc.PropertyMapping[] = props.rows.map((row, i) => {
      const s = sel[i];
      if (s.choice === SKIP) {
        return { source_key: row.source_key, target_key: null, target_type: "auto", create: false };
      }
      if (s.choice === CREATE) {
        return {
          source_key: row.source_key,
          target_key: s.createName.trim(),
          target_type: s.createType,
          create: true,
        };
      }
      return {
        source_key: row.source_key,
        target_key: s.choice,
        target_type: effectiveType(i),
        create: false,
      };
    });
    props.onConfirm(mappings);
  }

  return (
    <div class="app-modal__backdrop" onClick={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div class="app-modal property-map-dialog">
        <div class="app-modal__header">
          <h3>{t("import.mapping.title")}</h3>
        </div>
        <div class="app-modal__body">
          <p class="app-modal__hint">
            {t("import.mapping.hint")}
          </p>
          <div class="property-map">
            <div class="property-map__head">
              <div>{t("import.mapping.yamlProperty")}</div>
              <div>{t("import.mapping.mapsTo")}</div>
              <div>{t("import.mapping.type")}</div>
            </div>
            <For each={props.rows}>
              {(row, i) => (
                <div class="property-map__row">
                  <div class="property-map__source">
                    <span class="property-map__key">{row.source_key}</span>
                    <span class="property-map__meta">
                      {row.sample_value
                        ? t("import.mapping.eg", { value: row.sample_value })
                        : t("import.mapping.noValue")}
                      {" · "}
                      {tPlural("common.file", row.occurrences)}
                    </span>
                  </div>
                  <div class="property-map__target">
                    <Dropdown
                      class="dropdown--block"
                      value={sel[i()].choice}
                      options={targetOptions()}
                      onChange={(v) => setSel(i(), "choice", v)}
                      ariaLabel={t("import.mapping.mapAria", { key: row.source_key })}
                    />
                    <Show when={sel[i()].choice === CREATE}>
                      <input
                        class="property-map__name-input"
                        classList={{ "property-map__name-input--error": createNameError(i()) !== null }}
                        value={sel[i()].createName}
                        placeholder={t("import.mapping.newNamePlaceholder")}
                        spellcheck={false}
                        onInput={(e) => setSel(i(), "createName", e.currentTarget.value)}
                        aria-label={t("import.mapping.newNameAria", { key: row.source_key })}
                      />
                    </Show>
                    <Show
                      when={createNameError(i())}
                      fallback={
                        <Show when={sel[i()].choice !== SKIP}>
                          <span class="property-map__status">
                            {sel[i()].choice === CREATE
                              ? t("import.mapping.statusNew")
                              : props.targets.find((opt) => opt.key === sel[i()].choice)?.isSystem
                                ? t("import.mapping.statusSystem")
                                : t("import.mapping.statusExisting")}
                          </span>
                        </Show>
                      }
                    >
                      <span class="property-map__error">{createNameError(i())}</span>
                    </Show>
                  </div>
                  <div class="property-map__type">
                    <Show
                      when={!typeLocked(i())}
                      fallback={
                        <span
                          class="property-map__type-locked"
                          title={
                            sel[i()].choice === SKIP
                              ? t("import.mapping.notImported")
                              : t("import.mapping.determinedByTarget")
                          }
                        >
                          {sel[i()].choice === SKIP ? "—" : typeLabel(effectiveType(i()))}
                        </span>
                      }
                    >
                      <Dropdown
                        class="dropdown--block dropdown--sm"
                        value={sel[i()].createType}
                        options={typeOptions()}
                        onChange={(v) => setSel(i(), "createType", v)}
                        ariaLabel={t("import.mapping.typeAria", { key: row.source_key })}
                      />
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="app-modal__footer">
          <button class="btn btn--secondary" onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
          <button
            class="btn btn--primary"
            onClick={confirm}
            disabled={hasErrors()}
          >
            {tPlural("import.mapping.importBtn", includedCount())}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PropertyMappingDialog;
