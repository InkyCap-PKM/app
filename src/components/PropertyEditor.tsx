import { Component, createSignal, createResource, createEffect, onCleanup, For, Show } from "solid-js";
import type { PropertyValue } from "../lib/types";
import { propertyType } from "../stores/propertyTypes";
import { sanitizeAlias } from "../lib/typst";
import * as ipc from "../lib/ipc";

export interface PropertyEditorProps {
  propKey: string;
  value: PropertyValue;
  onSave: (key: string, value: PropertyValue) => void;
}

function validateValue(value: PropertyValue, declaredType: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  switch (declaredType) {
    case "number":
      if (typeof value === "string" && isNaN(Number(value))) return "Expected a number";
      break;
    case "checkbox":
      if (typeof value !== "boolean") return "Expected true or false";
      break;
    case "date":
      if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return "Expected date (YYYY-MM-DD)";
      break;
    case "datetime":
      if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))
        return "Expected date and time";
      break;
    case "list":
      if (!Array.isArray(value)) return "Expected a list";
      break;
    case "text":
      if (typeof value !== "string" && !Array.isArray(value)) return "Expected text";
      break;
  }
  return null;
}

const PropertyEditor: Component<PropertyEditorProps> = (props) => {
  // If the registry declares an explicit type for this key, use it.
  // Otherwise fall back to inferring from the actual value (legacy
  // behavior) so untyped properties still render sensibly.
  const effectiveType = () => {
    const declared = propertyType(props.propKey);
    if (declared !== "auto") return declared;
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

  return (
    <div class="property-editor">
      <Show when={isCollectionProp()} fallback={
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
        <CollectionEditor {...props} />
      </Show>
      <Show when={validationError()}>
        {(err) => <span class="property-editor__error">{err()}</span>}
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
    parts.push(link);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

const StringEditor: Component<PropertyEditorProps> = (props) => {
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
              {isEmpty() ? "Empty" : displayValue()}
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
        placeholder="Empty"
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
  );
};

const NumberEditor: Component<PropertyEditorProps> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(String(props.value ?? ""));
  const [error, setError] = createSignal<string | null>(null);
  const isEmpty = () => props.value === null || props.value === undefined || props.value === "";

  function startEdit() {
    setDraft(String(props.value ?? ""));
    setError(null);
    setEditing(true);
  }

  function commit() {
    const raw = draft().trim();
    if (raw === "") {
      setError(null);
      setEditing(false);
      return;
    }
    const num = parseFloat(raw);
    if (isNaN(num)) {
      setError("Not a valid number");
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
          {isEmpty() ? "Empty" : String(props.value)}
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
        placeholder="Empty"
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
      <Show when={error()}>
        {(msg) => <span class="property-editor__error">{msg()}</span>}
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
          {(item) => <span class="property-editor__tag">{item}</span>}
        </For>
        <Show when={currentItems().length === 0}>
          <span class="property-editor__value property-editor__value--empty">
            Empty
          </span>
        </Show>
      </div>

      <Show when={isOpen()}>
        <div class="collection-picker__dropdown">
          <input
            class="property-editor__input list-picker__filter"
            type="text"
            placeholder="Filter or add new…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            ref={(el) => (inputRef = el)}
          />
          <For each={candidates()} fallback={
            <Show when={!canCreate()}>
              <span class="collection-picker__empty">No values yet</span>
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
              + Add "{filter().trim()}"
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
};

const DateEditor: Component<PropertyEditorProps & { withTime: boolean }> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(String(props.value ?? ""));
  const isEmpty = () => !props.value;

  function startEdit() {
    setDraft(String(props.value ?? ""));
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const newVal = draft();
    if (newVal !== String(props.value ?? "")) {
      props.onSave(props.propKey, newVal);
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
          class={`property-editor__value${isEmpty() ? " property-editor__value--empty" : ""}`}
          onClick={startEdit}
        >
          {isEmpty() ? "Empty" : String(props.value)}
        </span>
      }
    >
      <input
        class="property-editor__input"
        type={props.withTime ? "datetime-local" : "date"}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
  );
};

const NullEditor: Component<PropertyEditorProps> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

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
          Empty
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
        placeholder="Enter value..."
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
  );
};

// Shared signal so the dropdown survives component re-renders from refetchMetadata
const [collectionPickerOpen, setCollectionPickerOpen] = createSignal(false);

const CollectionEditor: Component<PropertyEditorProps> = (props) => {
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
            <span class="property-editor__tag">{item}</span>
          )}
        </For>
        <Show when={currentItems().length === 0}>
          <span class="property-editor__value property-editor__value--empty">
            Click to assign collections
          </span>
        </Show>
      </div>

      <Show when={collectionPickerOpen()}>
        <div class="collection-picker__dropdown">
          <For each={collections() ?? []} fallback={
            <span class="collection-picker__empty">No collections defined</span>
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
