import { Component, createSignal, createResource, createEffect, onCleanup, For, Show } from "solid-js";
import type { PropertyValue, PropertyType } from "../lib/types";
import { propertyType } from "../stores/propertyTypes";
import { sanitizeAlias } from "../lib/typst";
import * as ipc from "../lib/ipc";
import { showWikilinkContextMenu } from "../lib/wikilink-nav";
import { useI18n } from "../lib/i18n";
import DatePicker from "./DatePicker";

export interface PropertyEditorProps {
  propKey: string;
  value: PropertyValue;
  onSave: (key: string, value: PropertyValue) => void;
  /**
   * Fallback type for keys the registry leaves as "auto" (e.g. the known
   * system fields like `date-due`). Lets the caller pin an editor without
   * registering the type globally.
   */
  typeHint?: PropertyType;
  /**
   * True when the edited file is a scaffold template. Scaffold property values
   * are routinely `{{var}}` placeholders, so the picker-only editors
   * (date/datetime/checkbox) relax to raw text entry — the picker can't accept
   * a variable, and a scaffold author needs to type one.
   */
  scaffoldContext?: boolean;
}

/** A value that is entirely a single `{{var}}` template placeholder (e.g.
 *  `{{zid}}`, `{{date:YYYY-MM-DD}}`). Scaffold authoring puts these in typed
 *  fields — they expand at insert time, so they shouldn't be type-validated or
 *  coerced. Stored as a (quoted) string so the scaffold still compiles and the
 *  value round-trips through the property index. */
export function isTemplatePlaceholder(value: PropertyValue): value is string {
  return typeof value === "string" && /^\s*\{\{[^{}]+\}\}\s*$/.test(value);
}

/** Validate a value against its declared type. Returns an i18n key for the
 *  error message (resolved by the caller through `useI18n`), or null when the
 *  value is acceptable. */
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
      // A single scalar is a valid in-progress list — the user may be about to
      // add more items, and the ListEditor (and the backend's `coerce_value`)
      // both treat a lone scalar as a one-item list. Only an object-shaped value
      // would be genuinely wrong here, and `PropertyValue` can't produce one.
      break;
    case "text":
      if (typeof value !== "string" && !Array.isArray(value)) return "property.editor.expectedText";
      break;
  }
  return null;
}

const PropertyEditor: Component<PropertyEditorProps> = (props) => {
  const t = useI18n();
  // If the registry declares an explicit type for this key, use it.
  // Otherwise fall back to inferring from the actual value (legacy
  // behavior) so untyped properties still render sensibly.
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

  // Route to the raw text editor when the value is already a placeholder, or
  // when we're authoring a scaffold and the declared type is a picker-only
  // editor (date/datetime/checkbox) that can't accept a typed `{{var}}`.
  // Number and list already have text-entry paths, so they keep their editors.
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
 * Let the property-row kebab menu's "Edit" action open an editor's edit mode.
 * When a value renders as a navigable wikilink, clicking it follows the link
 * instead of starting an edit, so there's otherwise no in-row way to change it.
 * RightPanel dispatches `inkycap:edit-property` with the row's key; the matching
 * editor enters edit mode. Auto-cleans up on unmount.
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
  const hasWikilinks = () => {
    const v = displayValue();
    return v.includes("[[") && v.includes("]]");
  };

  function startEdit() {
    setDraft(displayValue());
    setEditing(true);
  }
  useEditRequest(() => props.propKey, startEdit);

  function commit() {
    setEditing(false);
    const newVal = draft();
    if (newVal !== displayValue()) {
      // CommaList fields look like single-line text in the UI but
      // serialize as an array so the Typst-side `#note(...)` call gets
      // the right shape. `aliases` is the only such field today; future
      // CommaList fields ride the same path automatically.
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
          <span
            class="property-editor__value"
            ref={(el) => {
              el.innerHTML = "";
              for (const part of renderStringWithWikilinks(displayValue())) {
                if (typeof part === "string") {
                  el.appendChild(document.createTextNode(part));
                } else {
                  el.appendChild(part);
                }
              }
            }}
            onDblClick={startEdit}
          />
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
      // Clearing the field clears the value (persisted as empty) rather than
      // silently reverting to the old number. Stored as an empty string —
      // `none` would round-trip back as the literal string "none".
      setError(null);
      setEditing(false);
      if (props.value !== "" && props.value !== null && props.value !== undefined) {
        props.onSave(props.propKey, "");
      }
      return;
    }
    // A `{{var}}` template placeholder is accepted verbatim (saved as a
    // string) so a numeric field can hold a scaffold variable — see
    // isTemplatePlaceholder.
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
  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

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
  function openPicker() {
    setFilter("");
    setListPickerOpen(props.propKey);
    refetchValues();
    setTimeout(() => inputRef?.focus(), 0);
  }
  function closePicker() {
    if (isOpen()) setListPickerOpen(null);
  }

  // Items the user can pick from: union of values-in-this-property and any
  // currently-selected items (so a stale entry not yet propagated to the
  // global index still appears as checked).
  const candidates = (): string[] => {
    const universe = new Set<string>(allValues() ?? []);
    for (const it of currentItems()) universe.add(it);
    const filt = filter().trim().toLowerCase();
    const arr = [...universe].sort((a, b) => a.localeCompare(b));
    return filt ? arr.filter((v) => v.toLowerCase().includes(filt)) : arr;
  };

  const canCreate = () => {
    const f = filter().trim();
    if (!f) return false;
    const universe = new Set<string>(allValues() ?? []);
    for (const it of currentItems()) universe.add(it);
    return !universe.has(f);
  };

  function toggle(name: string) {
    const items = currentItems();
    const next = items.includes(name)
      ? items.filter((i) => i !== name)
      : [...items, name];
    props.onSave(props.propKey, next);
  }

  function commitNew() {
    const v = filter().trim();
    if (!v) return;
    if (!currentItems().includes(v)) {
      props.onSave(props.propKey, [...currentItems(), v]);
    }
    setFilter("");
    setTimeout(() => inputRef?.focus(), 0);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      // If the typed text uniquely matches a candidate, toggle it; else create.
      const f = filter().trim();
      const matches = candidates();
      if (f && matches.length === 1) {
        toggle(matches[0]);
        setFilter("");
        return;
      }
      if (canCreate()) commitNew();
    } else if (e.key === "Escape") {
      closePicker();
    } else if (e.key === "Backspace" && filter() === "" && currentItems().length > 0) {
      // Backspace with empty filter pops the last selected value.
      const items = currentItems();
      props.onSave(props.propKey, items.slice(0, -1));
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      closePicker();
    }
  }

  createEffect(() => {
    if (isOpen()) {
      document.addEventListener("mousedown", handleClickOutside);
    } else {
      document.removeEventListener("mousedown", handleClickOutside);
    }
  });
  onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));

  return (
    <div class="list-picker" ref={containerRef}>
      <div
        class="property-editor__tags"
        onClick={() => (isOpen() ? closePicker() : openPicker())}
      >
        <For each={currentItems()}>
          {(item) => <span class="badge badge--accent">{item}</span>}
        </For>
        <Show when={currentItems().length === 0}>
          <span class="property-editor__value property-editor__value--empty">
            {t("property.editor.empty")}
          </span>
        </Show>
      </div>

      <Show when={isOpen()}>
        <div class="collection-picker__dropdown">
          <input
            class="property-editor__input list-picker__filter"
            type="text"
            placeholder={t("property.editor.filterOrAdd")}
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            ref={(el) => (inputRef = el)}
          />
          <For each={candidates()} fallback={
            <Show when={!canCreate()}>
              <span class="collection-picker__empty">{t("property.editor.noValues")}</span>
            </Show>
          }>
            {(val) => (
              <label class="collection-picker__item">
                <input
                  type="checkbox"
                  checked={currentItems().includes(val)}
                  onChange={() => toggle(val)}
                />
                <span>{val}</span>
              </label>
            )}
          </For>
          <Show when={canCreate()}>
            <button
              class="collection-picker__item list-picker__create"
              onClick={commitNew}
              type="button"
            >
              {t("property.editor.addValue", { value: filter().trim() })}
            </button>
          </Show>
        </div>
      </Show>
    </div>
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
  let containerRef: HTMLDivElement | undefined;

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

  function handleClickOutside(e: MouseEvent) {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setCollectionPickerOpen(false);
    }
  }

  // Attach/detach click-outside listener when dropdown opens/closes
  createEffect(() => {
    if (collectionPickerOpen()) {
      document.addEventListener("mousedown", handleClickOutside);
    } else {
      document.removeEventListener("mousedown", handleClickOutside);
    }
  });

  onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));

  return (
    <div class="collection-picker" ref={containerRef}>
      <div class="property-editor__tags" onClick={() => setCollectionPickerOpen(!collectionPickerOpen())}>
        <For each={currentItems()}>
          {(item) => (
            <span class="badge badge--accent">{item}</span>
          )}
        </For>
        <Show when={currentItems().length === 0}>
          <span class="property-editor__value property-editor__value--empty">
            {t("property.editor.assignCollections")}
          </span>
        </Show>
      </div>

      <Show when={collectionPickerOpen()}>
        <div class="collection-picker__dropdown">
          <For each={collections() ?? []} fallback={
            <span class="collection-picker__empty">{t("property.editor.noCollections")}</span>
          }>
            {(col) => (
              <label class="collection-picker__item">
                <input
                  type="checkbox"
                  checked={currentItems().includes(col.name)}
                  onChange={() => toggleCollection(col.name)}
                />
                <span>{col.name}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default PropertyEditor;
