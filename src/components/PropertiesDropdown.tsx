// ---------------------------------------------------------------------------
// Properties dropdown — UI surface for picking a journal-scroll Properties
// filter. Two in-place views:
//
//   View 1 — Property picker:
//     * Anchor-tag shortcuts — one-click `tags == <tag>` filter on the
//       anchor note's own tags. A convenience shortcut; the same filter is
//       reachable via the `tags` property below.
//     * A text filter to narrow the property list.
//     * The property-name list, from `getAllPropertyKeys()` (excludes
//       `file.*`). Picking a name navigates to View 2.
//
//   View 2 — Value picker (for the chosen property):
//     * A back arrow returns to View 1.
//     * The currently-selected value (if any) shows as a chip with ×-to-clear.
//     * A text filter to narrow the value list.
//     * An "Any value" option (maps to `property_any`) plus the distinct
//       existing values. Selection is single-value: picking a value replaces
//       any prior selection.
//
// The dropdown stays open across picks so the user can refine the filter; it
// dismisses on outside click, or on Escape (Escape in View 2 first steps
// back to View 1).
// ---------------------------------------------------------------------------

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { ArrowLeft } from "lucide-solid";
import * as ipc from "../lib/ipc";
import type { PropertyFilter } from "../stores/journal-scroll";

interface PropertiesDropdownProps {
  anchorPath: string;
  /** Floating UI: anchor element (the Properties pill button). */
  triggerEl: HTMLElement;
  /** The filter currently applied to the scroll, if any — drives the
   *  initial view and the "selected value" chip. */
  currentFilter: PropertyFilter | null;
  onPick: (filter: PropertyFilter) => void;
  onClear: () => void;
  onDismiss: () => void;
}

const PropertiesDropdown: Component<PropertiesDropdownProps> = (props) => {
  let popoverRef: HTMLDivElement | undefined;
  let keyFilterRef: HTMLInputElement | undefined;
  let valueFilterRef: HTMLInputElement | undefined;

  // Re-opening with a live filter lands directly on that property's values.
  const [selectedKey, setSelectedKey] = createSignal<string | null>(
    props.currentFilter?.name ?? null,
  );
  const [keyQuery, setKeyQuery] = createSignal("");
  const [valueQuery, setValueQuery] = createSignal("");

  const [anchorMeta] = createResource(
    () => props.anchorPath,
    async (p) => ipc.getFileMetadata(p),
  );
  const [propertyKeys] = createResource(async () => ipc.getAllPropertyKeys());
  const [values] = createResource(selectedKey, async (key) => {
    if (!key) return [];
    return ipc.getPropertyValues(key);
  });

  const anchorTags = () => anchorMeta()?.tags ?? [];

  const filteredKeys = createMemo(() => {
    const q = keyQuery().trim().toLowerCase();
    const keys = propertyKeys() ?? [];
    if (!q) return keys;
    return keys.filter((k) => k.toLowerCase().includes(q));
  });

  const filteredValues = createMemo(() => {
    const q = valueQuery().trim().toLowerCase();
    const vs = values() ?? [];
    if (!q) return vs;
    return vs.filter((v) => String(v).toLowerCase().includes(q));
  });

  /** The active filter's value, when it applies to the property currently
   *  being viewed — drives the "Selected" chip in View 2. */
  const selectedForKey = createMemo(() => {
    const f = props.currentFilter;
    const key = selectedKey();
    if (!f || !key || f.name !== key) return null;
    return f;
  });

  function pickKey(key: string) {
    setSelectedKey(key);
    setValueQuery("");
  }

  function back() {
    setSelectedKey(null);
    setKeyQuery("");
  }

  // Position the popover under the trigger.
  createEffect(() => {
    if (!popoverRef) return;
    const rect = props.triggerEl.getBoundingClientRect();
    popoverRef.style.top = `${rect.bottom + 4}px`;
    popoverRef.style.left = `${rect.left}px`;
  });

  // Focus the relevant filter input whenever the view changes.
  createEffect(() => {
    const input = selectedKey() ? valueFilterRef : keyFilterRef;
    if (input) queueMicrotask(() => input.focus({ preventScroll: true }));
  });
  onMount(() => keyFilterRef?.focus({ preventScroll: true }));

  // Dismiss on outside click; Escape steps back from View 2, else dismisses.
  createEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!popoverRef) return;
      const t = e.target as Node;
      if (popoverRef.contains(t) || props.triggerEl.contains(t)) return;
      props.onDismiss();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedKey()) {
        e.stopPropagation();
        back();
      } else {
        props.onDismiss();
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    });
  });

  return (
    // Portal to <body> so the dropdown escapes the editor header's
    // stacking context (which has its own z-index for the lip shadow);
    // otherwise --z-menu can't lift it above the right sidebar.
    <Portal>
    <div class="properties-dropdown" ref={popoverRef} role="dialog">
      {/* ── View 1: property picker ── */}
      <Show when={!selectedKey()}>
        <Show when={anchorTags().length > 0}>
          <div class="properties-dropdown__section">
            <div class="properties-dropdown__section-label">
              Filter by this note's tags
            </div>
            <div class="properties-dropdown__chips">
              <For each={anchorTags()}>
                {(tag) => (
                  <button
                    type="button"
                    class="properties-dropdown__chip"
                    classList={{
                      "is-selected":
                        props.currentFilter?.kind === "eq" &&
                        props.currentFilter.name === "tags" &&
                        props.currentFilter.value === tag,
                    }}
                    onClick={() =>
                      props.onPick({ kind: "eq", name: "tags", value: tag })
                    }
                  >
                    {tag}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div class="properties-dropdown__section">
          <div class="properties-dropdown__section-label">Property</div>
          <input
            ref={keyFilterRef}
            type="text"
            class="properties-dropdown__filter"
            placeholder="Filter properties…"
            value={keyQuery()}
            onInput={(e) => setKeyQuery(e.currentTarget.value)}
          />
          <Show
            when={propertyKeys()?.length}
            fallback={
              <div class="properties-dropdown__empty">
                No user properties in this notebox yet.
              </div>
            }
          >
            <div class="properties-dropdown__keys">
              <For each={filteredKeys()}>
                {(key) => (
                  <button
                    type="button"
                    class="properties-dropdown__key"
                    classList={{
                      "is-selected": props.currentFilter?.name === key,
                    }}
                    onClick={() => pickKey(key)}
                  >
                    {key}
                  </button>
                )}
              </For>
              <Show when={filteredKeys().length === 0}>
                <div class="properties-dropdown__empty">
                  No properties match “{keyQuery()}”.
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      {/* ── View 2: value picker ── */}
      <Show when={selectedKey()}>
        <div class="properties-dropdown__section">
          <div class="properties-dropdown__view-header">
            <button
              type="button"
              class="properties-dropdown__back"
              onClick={back}
              title="Back to properties"
              aria-label="Back to properties"
            >
              <ArrowLeft size={15} />
            </button>
            <div class="properties-dropdown__section-label">
              Value of {selectedKey()}
            </div>
          </div>

          <Show when={selectedForKey()}>
            <div class="properties-dropdown__selected">
              <span class="properties-dropdown__selected-chip">
                <span class="properties-dropdown__selected-value">
                  {selectedForKey()!.kind === "any"
                    ? "Any value"
                    : String((selectedForKey() as { value: unknown }).value)}
                </span>
                <button
                  type="button"
                  class="properties-dropdown__selected-clear"
                  onClick={() => props.onClear()}
                  title="Remove filter"
                  aria-label="Remove filter"
                >
                  ×
                </button>
              </span>
            </div>
          </Show>

          <input
            ref={valueFilterRef}
            type="text"
            class="properties-dropdown__filter"
            placeholder="Filter values…"
            value={valueQuery()}
            onInput={(e) => setValueQuery(e.currentTarget.value)}
          />

          <div class="properties-dropdown__values">
            <button
              type="button"
              class="properties-dropdown__value properties-dropdown__value--any"
              classList={{ "is-selected": selectedForKey()?.kind === "any" }}
              onClick={() => props.onPick({ kind: "any", name: selectedKey()! })}
            >
              Any value
            </button>
            <For each={filteredValues()}>
              {(v) => (
                <button
                  type="button"
                  class="properties-dropdown__value"
                  classList={{
                    "is-selected":
                      selectedForKey()?.kind === "eq" &&
                      (selectedForKey() as { value: unknown }).value === v,
                  }}
                  onClick={() =>
                    props.onPick({
                      kind: "eq",
                      name: selectedKey()!,
                      value: v,
                    })
                  }
                >
                  {String(v)}
                </button>
              )}
            </For>
            <Show
              when={
                values.state === "ready" && (values()?.length ?? 0) === 0
              }
            >
              <div class="properties-dropdown__empty">
                No values found for this property.
              </div>
            </Show>
            <Show
              when={
                (values()?.length ?? 0) > 0 && filteredValues().length === 0
              }
            >
              <div class="properties-dropdown__empty">
                No values match “{valueQuery()}”.
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
    </Portal>
  );
};

export default PropertiesDropdown;
