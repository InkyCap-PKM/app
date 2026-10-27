import { Component, createSignal, createResource, onCleanup, Show } from "solid-js";
import type { PropertyValue, PropertyType } from "../lib/types";
import { propertyType } from "../stores/propertyTypes";
import { sanitizeAlias } from "../lib/typst";
import { compareName } from "../lib/sort";
import * as ipc from "../lib/ipc";
import { showWikilinkContextMenu } from "../lib/wikilink-nav";
import { useI18n } from "../lib/i18n";
import DatePicker from "./DatePicker";
import MultiSelectPicker from "./MultiSelectPicker";

export interface PropertyEditorProps {
  propKey: string;
  value: PropertyValue;
  onSave: (key: string, value: PropertyValue) => void;
  /**
   * Type for keys the registry leaves "auto" (e.g. system fields like
   * `date-due`), so the caller can choose an editor without registering a type.
   */
  typeHint?: PropertyType;
  /**
   * True when the file is a scaffold. Its values are often `{{var}}`
   * placeholders, so the picker-only editors (date, datetime, checkbox) use
   * text entry, since a picker can't accept a variable.
   */
  scaffoldContext?: boolean;
}

/**
 * Whether a value is exactly one `{{var}}` placeholder (e.g. `{{zid}}`,
 * `{{date:YYYY-MM-DD}}`). Scaffolds put these in typed fields; they expand on
 * insert, so they aren't validated or converted. Stored as a quoted string so
 * the scaffold still compiles.
 */
export function isTemplatePlaceholder(value: PropertyValue): value is string {
  return typeof value === "string" && /^\s*\{\{[^{}]+\}\}\s*$/.test(value);
}

/**
 * Check a value against its type. Returns an i18n key for the error (resolved
 * by the caller with `useI18n`), or null if acceptable.
 */
function validateValue(value: PropertyValue, declaredType: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  // Template placeholders are valid in any field — they're not concrete
  // values yet, and validating them as the declared type is meaningless.
  if (isTemplatePlaceholder(value)) return null;
  switch (declaredType) {
    case "number":
      if (typeof value === "string" && isNaN(Number(value))) return "property.editor.expectedNumber";
      break;
    case "checkbox":
      if (typeof value !== "boolean") return "property.editor.expectedBool";
      break;
    case "date":
      if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return "property.editor.expectedDate";
      break;
    case "datetime":
      if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))
        return "property.editor.expectedDatetime";
      break;
    case "list":
      // A single value is a valid list in progress (the ListEditor and the
      // backend's `coerce_value` treat it as one item).
      break;
    case "text":
      if (typeof value !== "string" && !Array.isArray(value)) return "property.editor.expectedText";
      break;
  }
  return null;
}

const PropertyEditor: Component<PropertyEditorProps> = (props) => {
  const t = useI18n();
  // The registry's type for the key if set, otherwise inferred from the value.
  const effectiveType = () => {
    const declared = propertyType(props.propKey);
    if (declared !== "auto") return declared;
    if (props.typeHint && props.typeHint !== "auto") return props.typeHint;
    const v = props.value;
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return "checkbox";
    if (typeof v === "number") return "number";
    if (Array.isArray(v)) return "list";
    return "text";
  };

  const validationError = () => {
    const declared = propertyType(props.propKey);
    if (declared === "auto") return null;
    return validateValue(props.value, declared);
  };

  const isCollectionProp = () => props.propKey === "collection";

  // Use the raw text editor for a placeholder value, or in a scaffold when the
  // type's editor is picker-only (date, datetime, checkbox). Numbers and lists
  // already accept text.
  const usesRawEditor = () => {
    if (isTemplatePlaceholder(props.value)) return true;
    if (!props.scaffoldContext) return false;
    const t = effectiveType();
    return t === "date" || t === "datetime" || t === "checkbox";
  };

  return (
    <div class="property-editor">
      <Show when={isCollectionProp()} fallback={
        <Show when={usesRawEditor()} fallback={
          <>
            <Show when={effectiveType() === "checkbox"}>
              <BooleanEditor {...props} />
            </Show>
            <Show when={effectiveType() === "number"}>
              <NumberEditor {...props} />
            </Show>
            <Show when={effectiveType() === "text" || effectiveType() === "commalist"}>
              <StringEditor {...props} />
            </Show>
            <Show when={effectiveType() === "date"}>
              <DateEditor {...props} withTime={false} />
            </Show>
            <Show when={effectiveType() === "datetime"}>
              <DateEditor {...props} withTime={true} />
            </Show>
            <Show when={effectiveType() === "list"}>
              <ListEditor {...props} />
            </Show>
            <Show when={effectiveType() === "null"}>
              <NullEditor {...props} />
            </Show>
          </>
        }>
          {/* Raw text editor: used for an existing {{placeholder}} value
              (any type), and for date/datetime/checkbox fields while
              authoring a scaffold, where the picker can't accept a variable. */}
          <StringEditor {...props} />
        </Show>
      }>
        <CollectionEditor {...props} />
      </Show>
      <Show when={validationError()}>
        {(err) => <span class="property-editor__error">{t(err())}</span>}
      </Show>
    </div>
  );
};

// -- Individual type editors --

const WIKILINK_BRACKET_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Whether `text` holds a `[[…]]` wikilink. */
function hasWikilink(text: string): boolean {
  return text.includes("[[") && text.includes("]]");
}

function renderStringWithWikilinks(text: string): (string | HTMLSpanElement)[] {
  const parts: (string | HTMLSpanElement)[] = [];
  WIKILINK_BRACKET_RE.lastIndex = 0;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_BRACKET_RE.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    const target = match[1];
    const display = match[2] || target;
    const link = document.createElement("span");
    link.className = "property-editor__wikilink";
    link.textContent = display;
    link.title = target;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(
        new CustomEvent("inkycap:navigate-wikilink", { detail: { target } }),
      );
    });
    link.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWikilinkContextMenu(e.clientX, e.clientY, target);
    });
    parts.push(link);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

/**
 * Let the row menu's "Edit" open an editor in edit mode. A wikilink value
 * follows the link when clicked, so there's no other in-row way to edit it.
 * RightPanel dispatches `inkycap:edit-property` with the key; the matching
 * editor responds. Removed on unmount.
 */
function useEditRequest(propKey: () => string, startEdit: () => void) {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ propKey: string }>).detail;
    if (detail?.propKey === propKey()) startEdit();
  };
  document.addEventListener("inkycap:edit-property", handler);
  onCleanup(() => document.removeEventListener("inkycap:edit-property", handler));
}

const StringEditor: Component<PropertyEditorProps> = (props) => {
  const t = useI18n();
  const [editing, setEditing] = createSignal(false);

  const displayValue = (): string => {
    const v = props.value;
    if (Array.isArray(v)) return v.join(", ");
    return String(v ?? "");
  };

  const [draft, setDraft] = createSignal(displayValue());
  const isEmpty = () => {
    const v = props.value;
    if (Array.isArray(v)) return v.length === 0;
    return !v && v !== 0 && v !== false;
  };
  const hasWikilinks = () => hasWikilink(displayValue());

  function startEdit() {
    setDraft(displayValue());
    setEditing(true);
  }
  useEditRequest(() => props.propKey, startEdit);

  function commit() {
    setEditing(false);
    const newVal = draft();
    if (newVal !== displayValue()) {
      // CommaList fields look like text but are saved as arrays, so
      // `#note(...)` gets the right shape. Currently only `aliases`.
      if (propertyType(props.propKey) === "commalist") {
        const items = newVal
          .split(",")
          .map((s) => (props.propKey === "aliases" ? sanitizeAlias(s) : s.trim()))
          .filter((s) => s.length > 0);
        props.onSave(props.propKey, items);
      } else {
        props.onSave(props.propKey, newVal);
      }
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") setEditing(false);
  }

  return (
    <Show
      when={editing()}
      fallback={
        <Show
          when={!isEmpty() && hasWikilinks()}
          fallback={
            <span
              class={`property-editor__value${isEmpty() ? " property-editor__value--empty" : ""}`}
              onClick={startEdit}
            >
              {isEmpty() ? t("property.editor.empty") : displayValue()}
            </span>
          }
        >
          {/* The parts array mixes plain strings with ready-made link spans,
              which Solid inserts as children directly. It has to stay a
              reactive child expression rather than a one-shot `ref` that fills
              the element: the property rows are reused across notes (they are
              keyed by property name), so a `ref` would only ever run for the
              first note and every later note would keep showing that note's
              links. */}
          <span class="property-editor__value" onDblClick={startEdit}>
            {renderStringWithWikilinks(displayValue())}
          </span>
        </Show>
      }
    >
      <input
        class="property-editor__input"
        type="text"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        placeholder={t("property.editor.empty")}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
  );
};

const NumberEditor: Component<PropertyEditorProps> = (props) => {
  const t = useI18n();
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(String(props.value ?? ""));
  const [error, setError] = createSignal<string | null>(null);
  const isEmpty = () => props.value === null || props.value === undefined || props.value === "";

  function startEdit() {
    setDraft(String(props.value ?? ""));
    setError(null);
    setEditing(true);
  }
  useEditRequest(() => props.propKey, startEdit);

  function commit() {
    const raw = draft().trim();
    if (raw === "") {
      // An emptied field clears the value (saved as an empty string; `none`
      // would come back as the text "none").
      setError(null);
      setEditing(false);
      if (props.value !== "" && props.value !== null && props.value !== undefined) {
        props.onSave(props.propKey, "");
      }
      return;
    }
    // A `{{var}}` placeholder is accepted as is (see isTemplatePlaceholder).
    if (isTemplatePlaceholder(raw)) {
      setError(null);
      setEditing(false);
      if (raw !== props.value) props.onSave(props.propKey, raw);
      return;
    }
    const num = parseFloat(raw);
    if (isNaN(num)) {
      setError("property.editor.notANumber");
      return;
    }
    setError(null);
    setEditing(false);
    if (num !== props.value) {
      props.onSave(props.propKey, num);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setError(null); setEditing(false); }
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class={`property-editor__value${isEmpty() ? " property-editor__value--empty" : ""}`}
          onClick={startEdit}
        >
          {isEmpty() ? t("property.editor.empty") : String(props.value)}
        </span>
      }
    >
      <input
        class={`property-editor__input${error() ? " property-editor__input--error" : ""}`}
        type="text"
        inputMode="numeric"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        placeholder={t("property.editor.empty")}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
      <Show when={error()}>
        {(msg) => <span class="property-editor__error">{t(msg())}</span>}
      </Show>
    </Show>
  );
};

const BooleanEditor: Component<PropertyEditorProps> = (props) => {
  function toggle() {
    props.onSave(props.propKey, !(props.value as boolean));
  }

  return (
    <label class="property-editor__checkbox">
      <input
        type="checkbox"
        checked={props.value as boolean}
        onChange={toggle}
      />
    </label>
  );
};

// Same shared-signal trick as the collection picker so the dropdown
// survives parent re-renders triggered by metadata refetch on save.
const [listPickerOpen, setListPickerOpen] = createSignal<string | null>(null);

const ListEditor: Component<PropertyEditorProps> = (props) => {
  const t = useI18n();

  const currentItems = (): string[] => {
    const v = props.value;
    if (Array.isArray(v)) return v.map((i) => String(i ?? ""));
    if (v !== null && v !== undefined && v !== "") return [String(v)];
    return [];
  };

  const [allValues, { refetch: refetchValues }] = createResource(
    () => props.propKey,
    async (key) => {
      try {
        return await ipc.getPropertyValues(key);
      } catch {
        return [];
      }
    },
  );

  const [filter, setFilter] = createSignal("");

  const isOpen = () => listPickerOpen() === props.propKey;

  // The choices: values used in this property plus the currently selected ones
  // (so one not yet in the index still shows as checked).
  const universe = (): Set<string> => {
    const all = new Set<string>(allValues() ?? []);
    for (const it of currentItems()) all.add(it);
    return all;
  };

  const candidates = (): string[] => {
    const filt = filter().trim().toLowerCase();
    const arr = [...universe()].sort((a, b) => compareName(a, b));
    return filt ? arr.filter((v) => v.toLowerCase().includes(filt)) : arr;
  };

  const canCreate = () => {
    const f = filter().trim();
    return !!f && !universe().has(f);
  };

  function toggle(name: string) {
    const items = currentItems();
    const next = items.includes(name)
      ? items.filter((i) => i !== name)
      : [...items, name];
    props.onSave(props.propKey, next);
    // The filter was a way of finding that value; clear it so the next one can
    // be typed straight away.
    setFilter("");
  }

  function commitNew() {
    const v = filter().trim();
    if (!v) return;
    if (!currentItems().includes(v)) {
      props.onSave(props.propKey, [...currentItems(), v]);
    }
    setFilter("");
  }

  return (
    <MultiSelectPicker
      selected={currentItems()}
      // A value holding a wikilink (a `link-ref` in the source) reads and
      // clicks like the single-value links in other rows.
      renderSelected={(item) =>
        hasWikilink(item) ? (
          <span class="property-editor__links-item">{renderStringWithWikilinks(item)}</span>
        ) : (
          <span class="badge badge--accent">{item}</span>
        )
      }
      options={candidates()}
      onToggle={toggle}
      open={isOpen()}
      onOpenChange={(open) => {
        if (open) {
          setFilter("");
          setListPickerOpen(props.propKey);
          refetchValues();
        } else if (isOpen()) {
          setListPickerOpen(null);
        }
      }}
      label={t("property.editor.chooseValues", { key: props.propKey })}
      emptyLabel={t("property.editor.empty")}
      noOptionsLabel={t("property.editor.noValues")}
      filterable
      filterValue={filter()}
      filterPlaceholder={t("property.editor.filterOrAdd")}
      onFilterChange={setFilter}
      createLabel={
        canCreate() ? t("property.editor.addValue", { value: filter().trim() }) : undefined
      }
      onCreate={commitNew}
      // Backspace with an empty filter pops the last selected value.
      onBackspaceEmpty={() => {
        const items = currentItems();
        if (items.length > 0) props.onSave(props.propKey, items.slice(0, -1));
      }}
    />
  );
};

const DateEditor: Component<PropertyEditorProps & { withTime: boolean }> = (props) => {
  return (
    <DatePicker
      value={String(props.value ?? "")}
      withTime={props.withTime}
      onSave={(v) => props.onSave(props.propKey, v)}
    />
  );
};

const NullEditor: Component<PropertyEditorProps> = (props) => {
  const t = useI18n();
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  useEditRequest(() => props.propKey, () => setEditing(true));

  function commit() {
    setEditing(false);
    if (draft().trim()) {
      props.onSave(props.propKey, draft().trim());
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") setEditing(false);
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class="property-editor__value property-editor__value--empty"
          onClick={() => setEditing(true)}
        >
          {t("property.editor.empty")}
        </span>
      }
    >
      <input
        class="property-editor__input"
        type="text"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        placeholder={t("property.editor.enterValue")}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
  );
};

// Shared signal so the dropdown survives component re-renders from refetchMetadata
const [collectionPickerOpen, setCollectionPickerOpen] = createSignal(false);

const CollectionEditor: Component<PropertyEditorProps> = (props) => {
  const t = useI18n();

  const [collections] = createResource(async () => {
    try {
      return await ipc.listCollections();
    } catch {
      return [];
    }
  });

  const currentItems = (): string[] => {
    const v = props.value;
    if (Array.isArray(v)) return v.map((i) => String(i ?? ""));
    if (typeof v === "string" && v) return [v];
    return [];
  };

  function toggleCollection(name: string) {
    const items = currentItems();
    const newItems = items.includes(name)
      ? items.filter((i) => i !== name)
      : [...items, name];
    props.onSave(props.propKey, newItems);
  }

  return (
    <MultiSelectPicker
      selected={currentItems()}
      options={(collections() ?? []).map((c) => c.name)}
      onToggle={toggleCollection}
      open={collectionPickerOpen()}
      onOpenChange={setCollectionPickerOpen}
      label={t("property.editor.chooseCollections")}
      emptyLabel={t("property.editor.assignCollections")}
      noOptionsLabel={t("property.editor.noCollections")}
    />
  );
};

export default PropertyEditor;
