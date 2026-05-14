// ---------------------------------------------------------------------------
// Journal Scroll pill — three-mode toggle (Date / Tree / Properties) plus
// a Connections toggle and an optional active-filter chip. Lives in the
// center slot of `.editor-header` (the grid-restructured header).
//
// Interaction model:
//   * Scroll off → only the on/off toggle button is shown. Clicking it
//     turns scroll on in Date mode.
//   * Scroll on  → three mode buttons + Connections toggle + (when in
//     Properties mode with a filter) a filter chip with ×-to-clear.
//   * Clicking the active mode button while scroll is on turns scroll off.
//   * Clicking "Properties" opens the PropertiesDropdown; picking a filter
//     commits to Properties mode with that filter, dismissing the dropdown
//     leaves the current mode unchanged.
// ---------------------------------------------------------------------------

import { Component, Show, createSignal } from "solid-js";
import {
  clearPropertyFilter,
  getPropertyFilter,
  getShowConnections,
  getMode,
  isEnabled,
  setMode,
  setPropertyFilter,
  toggleConnections,
  toggleScroll,
  type PropertyFilter,
  type ScrollMode,
} from "../stores/journal-scroll";
import PropertiesDropdown from "./PropertiesDropdown";

interface JournalScrollPillProps {
  tabId: string;
  anchorPath: string;
}

const JournalScrollPill: Component<JournalScrollPillProps> = (props) => {
  let propertiesBtnRef: HTMLButtonElement | undefined;
  const [dropdownOpen, setDropdownOpen] = createSignal(false);

  const enabled = () => isEnabled(props.tabId);
  const mode = () => getMode(props.tabId);
  const filter = () => getPropertyFilter(props.tabId);
  const showConnections = () => getShowConnections(props.tabId);

  function onModeClick(target: ScrollMode) {
    if (!enabled()) {
      // First click activates scroll in the chosen mode.
      void toggleScroll(props.tabId, props.anchorPath);
      if (target !== "date") {
        // toggleScroll defaults to Date; switch if user picked another mode.
        // The setMode call below will queue after the initial load.
        void setMode(props.tabId, target);
      }
      if (target === "properties") {
        setDropdownOpen(true);
      }
      return;
    }
    if (mode() === target) {
      if (target === "properties") {
        // Re-open dropdown to change filter.
        setDropdownOpen(true);
      } else {
        // Toggle off: clicking the active mode disables scroll.
        void toggleScroll(props.tabId, props.anchorPath);
      }
      return;
    }
    if (target === "properties") {
      // Show dropdown first; mode switch happens on filter pick.
      setDropdownOpen(true);
      return;
    }
    void setMode(props.tabId, target);
  }

  function onPickFilter(f: PropertyFilter) {
    setDropdownOpen(false);
    void setPropertyFilter(props.tabId, f);
  }

  function filterChipLabel(f: PropertyFilter): string {
    if (f.kind === "any") return `${f.name}: any`;
    const v = f.value;
    if (typeof v === "string") return `${f.name} = ${v}`;
    if (typeof v === "number" || typeof v === "boolean") {
      return `${f.name} = ${String(v)}`;
    }
    return `${f.name} = …`;
  }

  return (
    <div class="journal-scroll-pill" role="group" aria-label="Journal Scroll">
      <button
        type="button"
        class="journal-scroll-pill__toggle"
        classList={{ "is-active": enabled() }}
        onClick={() => void toggleScroll(props.tabId, props.anchorPath)}
        title={enabled() ? "Turn Journal Scroll off" : "Turn Journal Scroll on"}
        aria-pressed={enabled()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21a2 2 0 0 1-2-2V5a2 2 0 0 0-4 0v3H3" />
          <path d="M21 6a2 2 0 0 0-2-2H8" />
          <path d="M3 9v8a4 4 0 0 0 4 4h12" />
        </svg>
      </button>

      <Show when={enabled()}>
        <div class="journal-scroll-pill__modes" role="group" aria-label="Scroll mode">
          <button
            type="button"
            class="journal-scroll-pill__mode"
            classList={{ "is-active": mode() === "date" }}
            onClick={() => onModeClick("date")}
            aria-pressed={mode() === "date"}
          >
            Date
          </button>
          <button
            type="button"
            class="journal-scroll-pill__mode"
            classList={{ "is-active": mode() === "tree" }}
            onClick={() => onModeClick("tree")}
            aria-pressed={mode() === "tree"}
          >
            Tree
          </button>
          <button
            type="button"
            ref={propertiesBtnRef}
            class="journal-scroll-pill__mode"
            classList={{ "is-active": mode() === "properties" }}
            onClick={() => onModeClick("properties")}
            aria-pressed={mode() === "properties"}
          >
            Properties
          </button>
        </div>

        <button
          type="button"
          class="journal-scroll-pill__connections"
          classList={{ "is-active": showConnections() }}
          onClick={() => toggleConnections(props.tabId)}
          title={
            showConnections()
              ? "Hide connection decoration"
              : "Highlight notes linked to / from / sharing tags with the anchor"
          }
          aria-pressed={showConnections()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m13 2-2 2.5h3L12 7" />
            <path d="M10 14v-3a4 4 0 0 1 8 0v3" />
            <path d="M7 21h10a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2z" />
          </svg>
        </button>

        <Show when={mode() === "properties" && filter()}>
          <div class="journal-scroll-pill__filter-chip">
            <span class="journal-scroll-pill__filter-chip-label">
              {filterChipLabel(filter()!)}
            </span>
            <button
              type="button"
              class="journal-scroll-pill__filter-chip-clear"
              onClick={() => void clearPropertyFilter(props.tabId)}
              title="Clear filter"
              aria-label="Clear filter"
            >
              ×
            </button>
          </div>
        </Show>

        <Show when={dropdownOpen() && propertiesBtnRef}>
          <PropertiesDropdown
            anchorPath={props.anchorPath}
            triggerEl={propertiesBtnRef!}
            onPick={onPickFilter}
            onDismiss={() => setDropdownOpen(false)}
          />
        </Show>
      </Show>
    </div>
  );
};

export default JournalScrollPill;
