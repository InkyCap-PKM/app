/**
 * Mouse-vs-keyboard arbitration for signal-based picker lists (command
 * palette, quick-open, citation / reference-note / scaffold pickers).
 *
 * The bug this fixes: binding row selection to `onMouseEnter` lets a
 * *stationary* pointer steal the selection back from the keyboard. When the
 * list scrolls under a still cursor (because the user pressed Arrow/Page/
 * Home/End), the browser fires mouseenter/mouseover on whichever row slid
 * under the pointer — and may also synthesize a `mousemove` at the *same*
 * screen coordinates to re-evaluate `:hover`. Either way the highlighted row
 * snaps back to wherever the mouse happens to sit, fighting the keyboard.
 *
 * The fix: drive hover selection from `onMouseMove` and act only on *real*
 * pointer movement — a change in client coordinates since the last event.
 * Keyboard navigation then owns the selection until the user physically
 * moves the mouse, at which point hover takes over again. That is exactly
 * the "keyboard is in control until you move the mouse" behaviour users
 * expect from a picker.
 *
 * Usage: create one guard per picker instance and call `move` from each
 * row's `onMouseMove`:
 *
 *   const hover = createHoverGuard();
 *   // …
 *   onMouseMove={(e) => hover.move(e, () => setSelectedIndex(index()))}
 */
export interface HoverGuard {
  /** Row `onMouseMove` handler. Runs `select` only when the pointer has
   *  actually moved since the last event, filtering out scroll-synthesized
   *  moves and enter-on-stationary-cursor events. */
  move(e: MouseEvent, select: () => void): void;
}

export function createHoverGuard(): HoverGuard {
  // Sentinel that no real coordinate will match, so the first genuine hover
  // after the picker opens always registers.
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  return {
    move(e: MouseEvent, select: () => void) {
      if (e.clientX === lastX && e.clientY === lastY) return;
      lastX = e.clientX;
      lastY = e.clientY;
      select();
    },
  };
}
