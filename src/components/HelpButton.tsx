import { Component, JSX, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { CircleHelp } from "lucide-solid";

// A small circled "?" that toggles a help popover beside it, so explanations
// are one click away without cluttering the UI.
//
// The popover renders through a `Portal` (so scrolling or `overflow` panels
// can't clip it), is placed from the button's position (kept in the window, and
// above when there's no room below), and closes on an outside click or Escape.
// Uses the `--popup-*` tokens. Works like DatePicker's popup.

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

  // Place the popover below the button, keeping its left edge in the window and
  // moving it above when it would pass the bottom. Its height is only known
  // once rendered, so the first frame uses an estimate.
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

  // Close on outside click or Escape, and reposition on scroll or resize while
  // open. Pointerdown in the capture phase, so an outside click closes it
  // before activating another control.
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
