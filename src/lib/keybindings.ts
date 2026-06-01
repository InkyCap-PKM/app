// Shared utilities for hotkey strings. Used both by the global keyboard
// dispatcher and the rule editor's hotkey-recording UI so they speak the
// same string format.

/** Format a KeyboardEvent into the registry's canonical keybinding string
 *  ("Ctrl+Shift+N"). Returns null for a bare modifier press, an unmodified
 *  key, or any event we don't intend to register as a shortcut. Single-
 *  character keys are uppercased so `Ctrl+n` and `Ctrl+N` collide as the
 *  same combo from the registry's perspective. */
// With Shift held, a printable key reports its *shifted* glyph in `e.key`
// (Shift+0 → ")", Shift+] → "}", Shift+\ → "|"). Map those back to the base key
// so a binding can be written against the key you press ("Ctrl+Shift+0") and
// still match. Covers the US/ANSI layout; on layouts that produce a different
// glyph the combo simply won't normalize and the binding can be remapped (the
// planned user-customizable bindings). Letters are unaffected — Shift+m already
// reports "M", which we uppercase below.
const SHIFTED_TO_BASE: Record<string, string> = {
  ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
  ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

export function formatKeyCombo(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  let key = e.key;
  if (e.shiftKey && SHIFTED_TO_BASE[key]) key = SHIFTED_TO_BASE[key];
  if (key.length === 1) key = key.toUpperCase();
  else if (key === "ArrowUp") key = "Up";
  else if (key === "ArrowDown") key = "Down";
  else if (key === "ArrowLeft") key = "Left";
  else if (key === "ArrowRight") key = "Right";

  // A bare key (no modifier) isn't a shortcut, with one exception: the
  // function keys F1–F12. They aren't produced by text entry, so binding one
  // on its own (F2 = rename, F6 = cycle regions) can't shadow typing. Any
  // un-bound function key still falls through — findCommandByKeybinding returns
  // null and the dispatcher leaves the event alone (e.g. F5, F12).
  if (parts.length === 0 && !/^F\d{1,2}$/.test(key)) return null;

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
