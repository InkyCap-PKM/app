import { Component, createSignal, createResource, createEffect, onCleanup, For, Show } from "solid-js";
import type { PropertyValue } from "../lib/types";
import { propertyType } from "../stores/propertyTypes";
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
      if (typeof value !== "string") return "Expected text";
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
          <Show when={effectiveType() === "text"}>
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
  const [draft, setDraft] = createSignal(String(props.value ?? ""));
  const isEmpty = () => !props.value && props.value !== 0 && props.value !== false;
  const hasWikilinks = () => {
    const v = String(props.value ?? "");
    return v.includes("[[") && v.includes("]]");
  };

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
        <Show
          when={!isEmpty() && hasWikilinks()}
          fallback={
            <span
              class={`property-editor__value${isEmpty() ? " property-editor__value--empty" : ""}`}
              onClick={startEdit}
            >
              {isEmpty() ? "Empty" : String(props.value)}
            </span>
          }
        >
          <span
            class="property-editor__value"
            ref={(el) => {
              el.innerHTML = "";
              for (const part of renderStringWithWikilinks(String(props.value))) {
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
      <span>{props.value ? "true" : "false"}</span>
    </label>
  );
};

const ListEditor: Component<PropertyEditorProps> = (props) => {
  const items = (): PropertyValue[] => {
    const v = props.value;
    if (Array.isArray(v)) return v;
    if (v !== null && v !== undefined && v !== "") return [v];
    return [];
  };

  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  function startEdit() {
    setDraft(items().map((i) => String(i ?? "")).join(", "));
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const newItems = draft()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    props.onSave(props.propKey, newItems);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") setEditing(false);
  }

  return (
    <Show
      when={editing()}
      fallback={
        <div class="property-editor__tags" onClick={startEdit}>
          <For each={items()}>
            {(item) => (
              <span class="property-editor__tag">{String(item ?? "")}</span>
            )}
          </For>
          <Show when={items().length === 0}>
            <span class="property-editor__value property-editor__value--empty">Empty</span>
          </Show>
        </div>
      }
    >
      <input
        class="property-editor__input"
        type="text"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        placeholder="item1, item2, item3"
        ref={(el) => setTimeout(() => el.focus(), 0)}
      />
    </Show>
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
