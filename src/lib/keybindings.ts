// Hotkey string helpers, shared by the global keyboard dispatcher and the rule
// editor's hotkey recorder so both use the same format.

/** Format a KeyboardEvent as the registry's keybinding string ("Ctrl+Shift+N").
 *  Null for a bare modifier, an unmodified key, or any event that can't be a
 *  shortcut. Single characters are uppercased, so `Ctrl+n` and `Ctrl+N` are
 *  the same combo. */
// With Shift held, `e.key` is the shifted character (Shift+0 → ")", Shift+] →
// "}", Shift+\ → "|"). Map those back to the base key, so "Ctrl+Shift+0"
// matches the key pressed. Covers the US layout; on other layouts the combo
// isn't normalized and can be rebound. Letters are fine (Shift+m gives "M").
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

  // A key without a modifier isn't a shortcut, except the function keys F1–F12,
  // which don't type text, so binding one alone (F2 = rename, F6 = cycle
  // regions) can't block typing. An unbound function key (e.g. F5, F12) finds
  // no command and is left alone.
  if (parts.length === 0 && !/^F\d{1,2}$/.test(key)) return null;

  parts.push(key);
  return parts.join("+");
}

/**
 * True when the focused element opts out of global hotkeys with
 * `data-hotkey-recording="true"`, so the rule editor's "press a combo" field
 * can record a key without its command firing. An attribute on the focused
 * element rather than a flag, so it lifts by itself when focus moves or the
 * field unmounts.
 */
export function isHotkeyRecordingActive(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.closest('[data-hotkey-recording="true"]') !== null;
}
