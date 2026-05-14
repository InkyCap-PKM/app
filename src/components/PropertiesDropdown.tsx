// ---------------------------------------------------------------------------
// Properties dropdown — UI surface for picking a journal-scroll Properties
// filter. Three sections, in order:
//
//   1. Anchor tags (pinned chips) — one-click filter on `tags == <tag>`.
//      Preserves the original Tag mode's "show me related stuff" affordance.
//   2. Property name selector — populated from `getAllPropertyKeys()`,
//      which already excludes `file.*` properties.
//   3. Value selector — once a name is picked: distinct existing values
//      plus an "any value" option that maps to `property_any`.
// ---------------------------------------------------------------------------

import {
  Component,
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import * as ipc from "../lib/ipc";
import type { PropertyFilter } from "../stores/journal-scroll";

interface PropertiesDropdownProps {
  anchorPath: string;
  /** Floating UI: anchor element (the Properties pill button). */
  triggerEl: HTMLElement;
  onPick: (filter: PropertyFilter) => void;
  onDismiss: () => void;
}

const PropertiesDropdown: Component<PropertiesDropdownProps> = (props) => {
  let popoverRef: HTMLDivElement | undefined;
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);

  const [anchorMeta] = createResource(
    () => props.anchorPath,
    async (p) => ipc.getFileMetadata(p),
  );
  const [propertyKeys] = createResource(async () => ipc.getAllPropertyKeys());
  const [values] = createResource(selectedKey, async (key) => {
    if (!key) return [];
    return ipc.getPropertyValues(key);
  });

  // Position the popover under the trigger.
  createEffect(() => {
    if (!popoverRef) return;
    const rect = props.triggerEl.getBoundingClientRect();
    popoverRef.style.top = `${rect.bottom + 4}px`;
    popoverRef.style.left = `${rect.left}px`;
  });

  // Dismiss on outside click and Escape.
  createEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!popoverRef) return;
      const t = e.target as Node;
      if (popoverRef.contains(t) || props.triggerEl.contains(t)) return;
      props.onDismiss();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onDismiss();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    });
  });

  const anchorTags = () => anchorMeta()?.tags ?? [];

  return (
    <div class="properties-dropdown" ref={popoverRef} role="dialog">
      <Show when={anchorTags().length > 0}>
        <div class="properties-dropdown__section">
          <div class="properties-dropdown__section-label">Anchor tags</div>
          <div class="properties-dropdown__chips">
            <For each={anchorTags()}>
              {(tag) => (
                <button
                  type="button"
                  class="properties-dropdown__chip"
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
        <Show
          when={propertyKeys()?.length}
          fallback={
            <div class="properties-dropdown__empty">
              No user properties in this vault yet.
            </div>
          }
        >
          <div class="properties-dropdown__keys">
            <For each={propertyKeys()}>
              {(key) => (
                <button
                  type="button"
                  class="properties-dropdown__key"
                  classList={{ "is-selected": selectedKey() === key }}
                  onClick={() => setSelectedKey(key)}
                >
                  {key}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={selectedKey()}>
        <div class="properties-dropdown__section">
          <div class="properties-dropdown__section-label">
            Value of {selectedKey()}
          </div>
          <div class="properties-dropdown__values">
            <button
              type="button"
              class="properties-dropdown__value properties-dropdown__value--any"
              onClick={() =>
                props.onPick({ kind: "any", name: selectedKey()! })
              }
            >
              Any value
            </button>
            <For each={values() ?? []}>
              {(v) => (
                <button
                  type="button"
                  class="properties-dropdown__value"
                  onClick={() =>
                    props.onPick({
                      kind: "eq",
                      name: selectedKey()!,
                      value: v,
                    })
                  }
                >
                  {v}
                </button>
              )}
            </For>
            <Show when={values.state === "ready" && (values()?.length ?? 0) === 0}>
              <div class="properties-dropdown__empty">
                No values found for this property.
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default PropertiesDropdown;
