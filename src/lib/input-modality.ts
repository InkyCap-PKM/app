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
 * The listeners are attached in the capture phase so they run before any
 * element-level handlers that might `stopPropagation`.
 */

let initialized = false;

function setModality(value: "keyboard" | "pointer") {
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
  // Modifier-only keydowns (Shift, Alt, Ctrl on their own) are excluded
  // because they fire when the user holds them for a mouse-chord — e.g.
  // Shift-click for range select — and would flip modality just before
  // the click flips it back, producing a flicker.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Shift" || e.key === "Alt" || e.key === "Control" || e.key === "Meta") {
        return;
      }
      setModality("keyboard");
    },
    true,
  );

  // Any pointer down — mouse, pen, or touch — clears the keyboard
  // indicator. We listen to both pointerdown (modern) and mousedown
  // (fallback) so older webviews still get the signal.
  const toPointer = () => setModality("pointer");
  window.addEventListener("pointerdown", toPointer, true);
  window.addEventListener("mousedown", toPointer, true);
  window.addEventListener("touchstart", toPointer, true);
}
