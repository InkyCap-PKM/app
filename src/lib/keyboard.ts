// Global keyboard shortcut dispatcher, registered once from App.tsx. Bindings
// come from the command registry, so any command with a `keybinding` works
// without code here.
//
// The listener runs in the capture phase, for two reasons:
//
//   1. The rule editor's hotkey field sets `data-hotkey-recording="true"` and
//      clears it in its own onKeyDown once a combo is captured. In the bubble
//      phase this would run after the clear and fire the shortcut.
//   2. Global shortcuts take precedence over the focused element's keys: a
//      matched combo is prevented before the input or editor sees it.
//
// The one exception to the registry is Ctrl+1..9 (switch to tab N), which takes
// a number.

import { switchToTabByIndex } from "../stores/tabs";
import { findCommandByKeybinding } from "./command-registry";
import { formatKeyCombo, isHotkeyRecordingActive } from "./keybindings";

/** Initialize the global keyboard dispatcher. Call once from App.tsx. */
export function initKeyboard() {
  document.addEventListener("keydown", handleKeyDown, true);
}

/** Tear down the global dispatcher. */
export function destroyKeyboard() {
  document.removeEventListener("keydown", handleKeyDown, true);
}

function handleKeyDown(e: KeyboardEvent) {
  // The rule editor's "press a combo" field opts out with
  // `data-hotkey-recording="true"`. Capture phase (see the top of the file)
  // means this runs before the field clears it; otherwise Ctrl+N in the field
  // would also create a file.
  if (isHotkeyRecordingActive()) return;

  const ctrl = e.ctrlKey || e.metaKey;

  // Ctrl+1..9 switches to that tab; it can't be a single command, so it's
  // handled before the registry lookup.
  if (ctrl && !e.shiftKey && !e.altKey && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    switchToTabByIndex(parseInt(e.key, 10) - 1);
    return;
  }

  const combo = formatKeyCombo(e);
  if (!combo) return;

  const cmd = findCommandByKeybinding(combo);
  if (!cmd) return;

  e.preventDefault();
  try {
    void cmd.execute();
  } catch (err) {
    // A bound command throwing shouldn't bubble out into the global
    // keydown handler and risk knocking other listeners loose.
    console.error(`Command "${cmd.id}" threw while handling ${combo}:`, err);
  }
}
