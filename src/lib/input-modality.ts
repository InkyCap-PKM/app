/**
 * Track whether the user's last input was a keyboard or pointer event, and
 * expose the answer on `<html data-input-modality="keyboard|pointer">` so
 * CSS rules can show or hide focus indicators accordingly.
 *
 * Why: CSS's built-in `:focus-visible` only applies to the element holding
 * focus, not to descendant rules. InkyCap's tree-style controls (file
 * tree, list-nav panels) put `tabindex={0}` on a container and move a
 * keyboard cursor through child rows via `aria-activedescendant`. The
 * outline lives on a descendant, so `:focus-visible` on the container
 * doesn't reach it via CSS alone. This attribute is the workaround:
 * `html[data-input-modality="keyboard"] .container:focus-within .row` is
 * equivalent to "focus-visible-within" until the spec catches up.
 *
 * The attribute also decides whether the shared focus ring is drawn at all
 * (`--focus-ring-drawn` in themes.css), which is what keeps WebKitGTK from
 * painting one around the last-clicked control each time the window regains
 * focus.
 *
 * The listeners are attached in the capture phase so they run before any
 * element-level handlers that might `stopPropagation`.
 */

type Modality = "keyboard" | "pointer";

/** How long after a modified keydown a window blur still counts as that key
 *  having been swallowed by the desktop. Long enough to cover the compositor
 *  animating a workspace switch, short enough that an unrelated blur seconds
 *  later is never mistaken for one. */
const CHORD_GRACE_MS = 500;

/** Modifier key names, for excluding a bare modifier press. `getModifierState`
 *  covers the standard set by name, but engines still report a few legacy or
 *  vendor spellings that it does not recognize, so those are listed too. */
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

/** Set by a modified keydown, cleared by anything that proves the key was
 *  meant for this app. If a window blur arrives while it is still set, the
 *  keydown went to the desktop instead and its modality change is undone. */
let pendingChord: { previous: Modality; at: number } | null = null;

function setModality(value: Modality) {
  current = value;
  document.documentElement.setAttribute("data-input-modality", value);
}

export function initInputModality(): void {
  if (initialized) return;
  initialized = true;

  // Default to pointer so initial state doesn't flash outlines before the
  // user has done anything. Keyboard focus indicators come back the
  // instant the user presses any key.
  setModality("pointer");

  // Tab, arrow keys, Enter, anything keyed counts as keyboard intent.
  // Modifier-only keydowns (Shift, Alt, Super on their own) are excluded
  // because they fire when the user holds them for a mouse-chord — e.g.
  // Shift-click for range select — and would flip modality just before
  // the click flips it back, producing a flicker.
  window.addEventListener(
    "keydown",
    (e) => {
      if (isModifierPress(e)) return;

      // A chord the desktop has bound for itself — Alt-Super, Super-Tab,
      // whatever the compositor takes — can still reach the window on some
      // setups. It is not the user navigating this app, but nothing in the
      // event says so, so we watch what happens next instead: if the window
      // loses focus while this is pending, the key went to the window manager
      // and the modality it set is rolled back (see the blur handler).
      // Unmodified keys never arm this, so ordinary keyboard navigation is
      // never second-guessed.
      pendingChord =
        e.altKey || e.metaKey || e.ctrlKey ? { previous: current, at: Date.now() } : null;

      setModality("keyboard");
    },
    true,
  );

  // The window going away while a chord is pending is the proof that the key
  // was the desktop's, not ours. Nothing else clears the pending chord on a
  // timer: CHORD_GRACE_MS is checked here instead, so a stale one left by a
  // chord the app did handle can never undo an unrelated blur later on.
  window.addEventListener("blur", () => {
    if (pendingChord && Date.now() - pendingChord.at < CHORD_GRACE_MS) {
      setModality(pendingChord.previous);
    }
    pendingChord = null;
  });

  // Any pointer down — mouse, pen, or touch — clears the keyboard
  // indicator. We listen to both pointerdown (modern) and mousedown
  // (fallback) so older webviews still get the signal.
  const toPointer = () => {
    pendingChord = null;
    setModality("pointer");
  };
  window.addEventListener("pointerdown", toPointer, true);
  window.addEventListener("mousedown", toPointer, true);
  window.addEventListener("touchstart", toPointer, true);
}
