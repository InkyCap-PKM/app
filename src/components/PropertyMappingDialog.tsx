/**
 * PropertyMappingDialog — the in-between step of markdown import.
 *
 * After the user picks an archive and InkyCap scans its YAML frontmatter,
 * this dialog shows every distinct property found and how it will map onto
 * an InkyCap property. Each row lets the user:
 *   - re-map the YAML key to a different system / existing property,
 *   - auto-create a new property (and choose its value type),
 *   - or exclude the property from the import entirely.
 *
 * System properties are type-locked (their type column is disabled). On
 * confirm the assembled mappings are handed back to the importer.
 */

import { For, Show, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import * as ipc from "../lib/ipc";
import type { PropertyType } from "../lib/types";
import { Dropdown, type DropdownOption } from "./Dropdown";

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

const TYPE_LABELS: Record<PropertyType, string> = {
  auto: "Auto",
  text: "Text",
  number: "Number",
  list: "List",
  commalist: "Comma list",
  date: "Date",
  datetime: "Date & time",
  checkbox: "Checkbox",
};

// Concrete types the user may assign to a newly-created property. "auto" is
// intentionally excluded — a new property always gets a concrete type
// (defaulting to the type inferred from the YAML values).
const TYPE_OPTIONS: DropdownOption<PropertyType>[] = (
  ["text", "number", "list", "commalist", "date", "datetime", "checkbox"] as PropertyType[]
).map((value) => ({ value, label: TYPE_LABELS[value] }));

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
    props.targets.filter((t) => !t.isSystem).sort((a, b) => a.key.localeCompare(b.key)),
  );

  // System property names are reserved: a user may map onto them but must not
  // create a new property that shadows one. Case-insensitive.
  const systemNames = createMemo(
    () => new Set(systemTargets().map((t) => t.key.toLowerCase())),
  );

  // "Create new" is always available — the user names the property (defaulting
  // to the YAML key) — alongside mapping onto any existing system/user property
  // or excluding it.
  const targetOptions = (): DropdownOption<string>[] => [
    { value: CREATE, label: "Create new property", group: "New / exclude" },
    { value: SKIP, label: "Don't import", group: "New / exclude" },
    ...systemTargets().map((t) => ({ value: t.key, label: t.key, group: "System properties" })),
    ...userTargets().map((t) => ({ value: t.key, label: t.key, group: "Your properties" })),
  ];

  // The effective value type a row will be formatted as — fixed for an
  // existing/system target, user-chosen for a new property. An existing
  // target that's still untyped ("auto") resolves to the type inferred from
  // the YAML values, so the locked Type cell never shows "Auto".
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
    if (!name) return "Enter a property name";
    if (systemNames().has(name.toLowerCase())) {
      return `"${name}" is a system property — map onto it instead of creating it`;
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
          <h3>Map imported properties</h3>
        </div>
        <div class="app-modal__body">
          <p class="app-modal__hint">
            InkyCap found these properties in your files' YAML frontmatter. Confirm how each maps to
            an InkyCap property, change the type of any new properties, or exclude ones you don't
            want to import.
          </p>
          <div class="property-map">
            <div class="property-map__head">
              <div>YAML property</div>
              <div>Maps to</div>
              <div>Type</div>
            </div>
            <For each={props.rows}>
              {(row, i) => (
                <div class="property-map__row">
                  <div class="property-map__source">
                    <span class="property-map__key">{row.source_key}</span>
                    <span class="property-map__meta">
                      {row.sample_value
                        ? `e.g. ${row.sample_value}`
                        : "no value"}
                      {" · "}
                      {row.occurrences} file{row.occurrences === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div class="property-map__target">
                    <Dropdown
                      class="dropdown--block"
                      value={sel[i()].choice}
                      options={targetOptions()}
                      onChange={(v) => setSel(i(), "choice", v)}
                      ariaLabel={`Map ${row.source_key} to`}
                    />
                    <Show when={sel[i()].choice === CREATE}>
                      <input
                        class="property-map__name-input"
                        classList={{ "property-map__name-input--error": createNameError(i()) !== null }}
                        value={sel[i()].createName}
                        placeholder="New property name"
                        spellcheck={false}
                        onInput={(e) => setSel(i(), "createName", e.currentTarget.value)}
                        aria-label={`Name for new property from ${row.source_key}`}
                      />
                    </Show>
                    <Show
                      when={createNameError(i())}
                      fallback={
                        <Show when={sel[i()].choice !== SKIP}>
                          <span class="property-map__status">
                            {sel[i()].choice === CREATE
                              ? "New property"
                              : props.targets.find((t) => t.key === sel[i()].choice)?.isSystem
                                ? "System property"
                                : "Existing property"}
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
                              ? "Not imported"
                              : "Determined by the target property"
                          }
                        >
                          {sel[i()].choice === SKIP ? "—" : TYPE_LABELS[effectiveType(i())]}
                        </span>
                      }
                    >
                      <Dropdown
                        class="dropdown--block dropdown--sm"
                        value={sel[i()].createType}
                        options={TYPE_OPTIONS}
                        onChange={(v) => setSel(i(), "createType", v)}
                        ariaLabel={`Type for ${row.source_key}`}
                      />
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="app-modal__footer">
          <button class="app-modal__btn app-modal__btn--secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            class="app-modal__btn app-modal__btn--primary"
            onClick={confirm}
            disabled={hasErrors()}
          >
            Import {includedCount()} propert{includedCount() === 1 ? "y" : "ies"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PropertyMappingDialog;
