import { Component, JSX, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { CircleHelp } from "lucide-solid";

// A small circled "?" trigger that toggles a dismissible help popover next to
// it. Reusable anywhere an inline explanation would otherwise clutter the UI:
// the page stays terse, and the detail is one click away.
//
// Follows the project's floating-surface conventions: the popover renders
// through a `Portal` (so it is never clipped by a scrolling/`overflow` panel),
// is positioned from the trigger's bounding rect — clamped into the viewport
// and flipped above when it would overflow the bottom — and dismisses on a
// click outside or on Escape. Styling uses the `--popup-*` tokens (see
// CLAUDE.md "UI surfaces"); add no bespoke popup colours here.
//
// Mirrors the open/position/outside-click machinery in DatePicker so the two
// floating surfaces behave identically.

export interface HelpButtonProps {
  /** Accessible name for the trigger and the popover (e.g. "What gets packaged?"). */
  label: string;
  /** Help content — a string or arbitrary JSX. */
  children: JSX.Element;
}

const POPOVER_WIDTH = 280;

const HelpButton: Component<HelpButtonProps> = (props) => {
  let triggerRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal<{ left: number; top: number }>({ left: 0, top: 0 });

  // Place the popover below the trigger, clamping its left edge into the
  // viewport and flipping above when it would overflow the bottom. Height is
  // unknown until rendered, so we measure the popover when present and fall
  // back to an estimate for the first frame.
  function place() {
    if (!triggerRef) return;
    const r = triggerRef.getBoundingClientRect();
    const margin = 8;
    const height = popoverRef?.offsetHeight ?? 120;
    const below = r.bottom + 4;
    const flip = below + height > window.innerHeight && r.top > height;
    const top = flip ? Math.max(margin, r.top - height - 4) : below;
    const left = Math.max(
      margin,
      Math.min(r.left, window.innerWidth - POPOVER_WIDTH - margin),
    );
    setPos({ left, top });
  }

  function toggle() {
    if (open()) {
      setOpen(false);
      return;
    }
    place();
    setOpen(true);
  }

  // Close on outside click, close on Escape, and reposition on scroll/resize
  // while open. Capture-phase pointerdown so a click anywhere outside closes
  // before it activates another control.
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popoverRef?.contains(t) || triggerRef?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReflow = () => place();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    // Re-place once the popover has real dimensions (height affects flip).
    queueMicrotask(place);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    });
  });

  return (
    <span class="help-button">
      <button
        ref={triggerRef}
        type="button"
        class="help-button__trigger"
        classList={{ "is-open": open() }}
        aria-label={props.label}
        aria-expanded={open()}
        onClick={toggle}
      >
        <CircleHelp size={14} />
      </button>

      <Show when={open()}>
        <Portal>
          <div
            ref={popoverRef}
            class="help-button__popover"
            role="dialog"
            aria-label={props.label}
            style={{ left: `${pos().left}px`, top: `${pos().top}px`, width: `${POPOVER_WIDTH}px` }}
          >
            <div class="help-button__content">{props.children}</div>
          </div>
        </Portal>
      </Show>
    </span>
  );
};

export default HelpButton;
