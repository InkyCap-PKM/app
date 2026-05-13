// Shared utilities for hotkey strings. Used both by the global keyboard
// dispatcher and the rule editor's hotkey-recording UI so they speak the
// same string format.

/** Format a KeyboardEvent into the registry's canonical keybinding string
 *  ("Ctrl+Shift+N"). Returns null for a bare modifier press, an unmodified
 *  key, or any event we don't intend to register as a shortcut. Single-
 *  character keys are uppercased so `Ctrl+n` and `Ctrl+N` collide as the
 *  same combo from the registry's perspective. */
export function formatKeyCombo(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (parts.length === 0) return null;

  let key = e.key;
  if (key.length === 1) key = key.toUpperCase();
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";

  parts.push(key);
  return parts.join("+");
}

/** True when the focused element opted out of global hotkeys via
 *  `data-hotkey-recording="true"`. The dispatcher checks this before
 *  firing a command so the rule editor's "press a combo" field can
 *  capture the keystroke without the matching command also firing.
 *
 *  Implemented as a focused-element attribute rather than a module-
 *  level flag: if the editor unmounts mid-recording or focus moves
 *  away, the suppression naturally lifts without any cleanup code. */
export function isHotkeyRecordingActive(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.closest('[data-hotkey-recording="true"]') !== null;
}
