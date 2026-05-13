// Global keyboard shortcut dispatcher. Registered once from App.tsx
// onMount. Reads keybindings from the command registry, so every command
// with a `keybinding` field fires automatically — there's no per-key
// `if (e.key === "x")` ladder to keep in sync.
//
// The listener runs in **capture phase** (third arg `true`). Two reasons:
//
//   1. Suppression must see live state. The rule editor's hotkey-record
//      field flips `data-hotkey-recording="true"` while active, and its
//      onKeyDown synchronously clears that flag once a combo is captured.
//      If our dispatcher ran in bubble phase it would fire *after* that
//      clear and see `recording=false`, defeating the suppression. In
//      capture phase, the dispatcher runs before any other handler can
//      mutate state.
//
//   2. Global shortcuts should override focused-element keymaps. Capture
//      lets us preventDefault on a matched combo before the focused
//      input/editor sees it, instead of racing against its handlers.
//
// Two exceptions don't fit the registry model and remain hardcoded:
//   - Ctrl+1..9 (switch to tab N) is parametric.
//   - Nothing else.

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
  // The rule editor's "press a combo" field opts out via
  // `data-hotkey-recording="true"` on the focused element. We run in
  // capture phase (see top-of-file note) so this check happens before
  // any other handler can clear the attribute. Without that ordering,
  // pressing Ctrl+N in the record field both registers a conflict AND
  // fires the New Simple File command.
  if (isHotkeyRecordingActive()) return;

  const ctrl = e.ctrlKey || e.metaKey;

  // Parametric shortcut: Ctrl+1..9 → switch to that tab by index.
  // Not registrable as a single command — handle it directly before
  // the registry lookup.
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
