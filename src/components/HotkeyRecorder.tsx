// Shared "press a key combo" record button.
//
// Encapsulates the one fiddly part of hotkey capture that must be identical
// everywhere it's used: while recording, the button carries
// `data-hotkey-recording="true"` so the global dispatcher in `lib/keyboard.ts`
// suppresses command firing (otherwise pressing e.g. Ctrl+N would both record
// the combo AND fire "New Note"). Explicit `focus()` on click is required
// because WebKit (Tauri's webview) does not auto-focus <button> on click on
// every platform.
//
// Behaviour only: the button reports captured combos, clears, and conflicts
// through callbacks. Each call site owns its own conflict display and any
// toast, since they differ (creation-rule editor vs. shortcut customization).
// Used by CreationRuleEditor and the Help panel's shortcut rows.

import { Component, createSignal } from "solid-js";
import { formatKeyCombo } from "../lib/keybindings";
import { useI18n } from "../lib/i18n";

export interface HotkeyRecorderProps {
  /** Current combo shown while idle, or null/undefined for unbound. */
  value: string | null | undefined;
  /** Return a label for whatever already claims `combo`, or null if free. */
  findConflict: (combo: string) => string | null;
  /** A valid, conflict-free combo was captured. */
  onChange: (combo: string) => void;
  /** User pressed Backspace/Delete to unbind. */
  onClear: () => void;
  /** A conflicting combo was rejected — the call site can toast / show it. */
  onConflict?: (combo: string, conflict: string) => void;
  /** Label while idle when `value` is empty. Defaults to t("common.none"). */
  noneLabel?: string;
  /** Label while recording. Defaults to t("shortcuts.recording"). */
  recordingLabel?: string;
  /** Class on the record button. */
  buttonClass?: string;
  ariaLabel?: string;
}

/** A button that captures a single key combo when clicked. */
const HotkeyRecorder: Component<HotkeyRecorderProps> = (props) => {
  const t = useI18n();
  const [recording, setRecording] = createSignal(false);

  function handleKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();

    // Escape abandons recording without changing the binding.
    if (e.key === "Escape") {
      setRecording(false);
      return;
    }

    // Backspace / Delete clears the binding.
    if (e.key === "Backspace" || e.key === "Delete") {
      props.onClear();
      setRecording(false);
      return;
    }

    const combo = formatKeyCombo(e);
    if (!combo) return; // bare modifier or non-bindable key: keep listening

    const conflict = props.findConflict(combo);
    if (conflict) {
      props.onConflict?.(combo, conflict);
      setRecording(false);
      return;
    }

    props.onChange(combo);
    setRecording(false);
  }

  return (
    <button
      type="button"
      class={props.buttonClass}
      classList={{ recording: recording() }}
      // See file header: the global dispatcher keys off this attribute.
      data-hotkey-recording={recording() ? "true" : undefined}
      aria-label={props.ariaLabel}
      onClick={(e) => {
        setRecording(true);
        e.currentTarget.focus();
      }}
      onBlur={() => {
        if (recording()) setRecording(false);
      }}
      onKeyDown={(e) => {
        if (recording()) handleKeyDown(e);
      }}
    >
      {recording()
        ? props.recordingLabel ?? t("shortcuts.recording")
        : props.value ?? props.noneLabel ?? t("common.none")}
    </button>
  );
};

export default HotkeyRecorder;
