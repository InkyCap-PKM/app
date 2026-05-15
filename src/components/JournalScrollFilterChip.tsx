// ---------------------------------------------------------------------------
// Journal Scroll filter chip — shows the active Properties-mode filter in the
// center slot of `.editor-header`. Deliberately rendered as plain text (not a
// button-styled control) with a small ×-to-clear, so it reads as a status
// label rather than another toolbar button.
//
// Renders nothing unless scroll is on, the mode is Properties, and a filter
// is set.
// ---------------------------------------------------------------------------

import { Component, Show } from "solid-js";
import {
  clearPropertyFilter,
  getMode,
  getPropertyFilter,
  isEnabled,
  type PropertyFilter,
} from "../stores/journal-scroll";

interface JournalScrollFilterChipProps {
  tabId: string;
}

function filterLabel(f: PropertyFilter): string {
  if (f.kind === "any") return `${f.name}: any`;
  const v = f.value;
  if (typeof v === "string") return `${f.name} = ${v}`;
  if (typeof v === "number" || typeof v === "boolean") {
    return `${f.name} = ${String(v)}`;
  }
  return `${f.name} = …`;
}

const JournalScrollFilterChip: Component<JournalScrollFilterChipProps> = (
  props,
) => {
  const filter = () => getPropertyFilter(props.tabId);
  const visible = () =>
    isEnabled(props.tabId) && getMode(props.tabId) === "properties" && !!filter();

  return (
    <Show when={visible()}>
      <div class="journal-scroll-filter-text">
        <span class="journal-scroll-filter-text__label">
          {filterLabel(filter()!)}
        </span>
        <button
          type="button"
          class="journal-scroll-filter-text__clear"
          onClick={() => void clearPropertyFilter(props.tabId)}
          title="Clear filter"
          aria-label="Clear filter"
        >
          ×
        </button>
      </div>
    </Show>
  );
};

export default JournalScrollFilterChip;
