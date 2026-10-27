/**
 * Track whether the last input was keyboard or pointer, as `<html
 * data-input-modality="keyboard|pointer">`, so CSS can show or hide focus
 * indicators.
 *
 * `:focus-visible` only matches the focused element itself. Tree-style controls
 * (the file tree, list panels) focus a container and move a cursor through rows
 * with `aria-activedescendant`, so the outline is on a descendant.
 * `html[data-input-modality="keyboard"] .container:focus-within .row` does what
 * a "focus-visible-within" would.
 *
 * It also decides whether the shared focus ring is drawn at all
 * (`--focus-ring-drawn` in themes.css), which stops WebKitGTK drawing one round
 * the last-clicked control when the window regains focus.
 *
 * Listeners use the capture phase, so they run before handlers that stop
 * propagation.
 */

type Modality = "keyboard" | "pointer";

/**
 * How long after a modified keydown a window blur still counts as the desktop
 * having taken the key: long enough for a workspace-switch animation, short
 * enough not to catch an unrelated blur.
 */
const CHORD_GRACE_MS = 500;

/**
 * Modifier key names, to ignore a bare modifier press. `getModifierState`
 * covers the standard names, but engines still report some legacy or vendor
 * spellings.
 */
const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

function isModifierPress(e: KeyboardEvent): boolean {
  if (MODIFIER_KEYS.has(e.key)) return true;
  // Catches any spelling the engine and `getModifierState` agree on, including
  // ones not in the list above.
  try {
    return e.getModifierState(e.key);
  } catch {
    return false;
  }
}

let initialized = false;
let current: Modality = "pointer";

/**
 * Set by a modified keydown and cleared by anything showing the key was meant
 * for this app. A window blur while it is set means the desktop took the key,
 * and the modality change is undone.
 */
let pendingChord: { previous: Modality; at: number } | null = null;

function setModality(value: Modality) {
  current = value;
  document.documentElement.setAttribute("data-input-modality", value);
}

export function initInputModality(): void {
  if (initialized) return;
  initialized = true;

  // Start as pointer, so outlines don't show before the user does anything.
  setModality("pointer");

  // Any key except a bare modifier counts as keyboard. Modifiers alone are held
  // for mouse chords (Shift-click), and would flip modality just before the
  // click flips it back.
  window.addEventListener(
    "keydown",
    (e) => {
      if (isModifierPress(e)) return;

      // A chord the desktop uses (Alt-Super, Super-Tab, …) can still reach the
      // window on some systems, with nothing in the event to say so. So if the
      // window loses focus while this is pending, the key went to the window
      // manager and the modality is rolled back (see the blur handler).
      // Unmodified keys never set this.
      pendingChord =
        e.altKey || e.metaKey || e.ctrlKey ? { previous: current, at: Date.now() } : null;

      setModality("keyboard");
    },
    true,
  );

  // A blur while a chord is pending shows the key was the desktop's.
  // CHORD_GRACE_MS is checked here rather than on a timer, so a leftover chord
  // the app did handle can't undo a later unrelated blur.
  window.addEventListener("blur", () => {
    if (pendingChord && Date.now() - pendingChord.at < CHORD_GRACE_MS) {
      setModality(pendingChord.previous);
    }
    pendingChord = null;
  });

  // Any pointer press switches to pointer; both pointerdown and mousedown, for
  // older webviews.
  const toPointer = () => {
    pendingChord = null;
    setModality("pointer");
  };
  window.addEventListener("pointerdown", toPointer, true);
  window.addEventListener("mousedown", toPointer, true);
  window.addEventListener("touchstart", toPointer, true);
}
