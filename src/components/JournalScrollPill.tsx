// ---------------------------------------------------------------------------
// Journal Scroll pill — the on/off toggle plus, when scroll is on, the three
// mode buttons (Date / Tree / Properties). Lives in the right group of
// `.editor-header`, immediately before the source/visual/read mode toggle:
//   * Scroll off → only the on/off toggle is shown; the source/visual/read
//     toggle sits to its right.
//   * Scroll on  → the scroll controls (off toggle + modes) take the place
//     of the source/visual/read toggle, which is hidden.
//
// Anchor-connection decoration (accent strips + per-entry header icons) is a
// built-in, always-on feature of the scroll feed — there is no toggle for it.
//
// The active-filter chip is NOT rendered here — it lives in the header's
// center slot as plain text (see JournalScrollFilterChip).
//
// Interaction model:
//   * Scroll off → clicking the toggle turns scroll on in Date mode.
//   * Clicking the active mode button while scroll is on turns scroll off.
//   * Clicking "Properties" opens the PropertiesDropdown; picking a filter
//     commits to Properties mode with that filter, dismissing the dropdown
//     leaves the current mode unchanged.
// ---------------------------------------------------------------------------

import { Component, Show, createSignal } from "solid-js";
import { Scroll, ScrollText } from "lucide-solid";
import {
  clearPropertyFilter,
  getMode,
  getPropertyFilter,
  isEnabled,
  setMode,
  setPropertyFilter,
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
    // Keep the dropdown open so the user can refine the filter; they
    // dismiss it explicitly via outside-click or Escape.
    void setPropertyFilter(props.tabId, f);
  }

  return (
    <div class="journal-scroll-pill" role="group" aria-label="Journal Scroll">
      <button
        type="button"
        class="journal-scroll-pill__toggle"
        classList={{ "is-active": enabled() }}
        onClick={() => void toggleScroll(props.tabId, props.anchorPath)}
        title={enabled() ? "Turn Journal Scroll off" : "Start Journal Scroll anchored from this note"}
        aria-pressed={enabled()}
      >
        {enabled() ? <Scroll size={14} /> : <ScrollText size={14} />}
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

        <Show when={dropdownOpen() && propertiesBtnRef}>
          <PropertiesDropdown
            anchorPath={props.anchorPath}
            triggerEl={propertiesBtnRef!}
            currentFilter={getPropertyFilter(props.tabId)}
            onPick={onPickFilter}
            onClear={() => void clearPropertyFilter(props.tabId)}
            onDismiss={() => setDropdownOpen(false)}
          />
        </Show>
      </Show>
    </div>
  );
};

export default JournalScrollPill;
