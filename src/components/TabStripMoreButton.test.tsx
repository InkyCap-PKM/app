import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "solid-js/web";
import TabStripMoreButton from "./TabStripMoreButton";
import type { TabStripOverflowState } from "../lib/overflow";

// The "more" button lists the tabs that don't fit, by icon and name, and
// choosing one clicks that tab.

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  dispose?.();
  host?.remove();
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());
});

function tab(label: string, active = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = active ? "right-panel__tab right-panel__tab--active" : "right-panel__tab";
  b.setAttribute("aria-label", label);
  b.innerHTML = '<svg class="lucide" width="18" height="18"></svg>';
  return b;
}

function mount(hidden: HTMLButtonElement[], overflowing = true) {
  const overflow: TabStripOverflowState = {
    overflowing: () => overflowing,
    activeHidden: () => hidden.some((b) => b.classList.contains("right-panel__tab--active")),
    hiddenButtons: () => hidden,
    activeClass: "right-panel__tab--active",
    ref: () => {},
  };
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => <TabStripMoreButton overflow={overflow} />,
    host,
  );
  return host.querySelector<HTMLButtonElement>("[data-tab-overflow]");
}

describe("TabStripMoreButton", () => {
  it("is absent while every tab fits", () => {
    expect(mount([], false)).toBeNull();
  });

  it("lists the hidden tabs and clicks the one chosen", () => {
    const refs = tab("References");
    const onThisDate = tab("On This Date", true);
    const clicked = vi.fn();
    refs.addEventListener("click", clicked);
    const more = mount([refs, onThisDate])!;
    // The open pane is behind the button, so the button shows as active.
    expect(more.classList.contains("panel-tab-more--active")).toBe(true);

    more.click();
    const items = [...document.querySelectorAll<HTMLElement>(".context-menu__item")];
    expect(items.map((i) => i.textContent)).toEqual(["References", "On This Date"]);
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[1].classList.contains("context-menu__item--active")).toBe(true);

    items[0].click();
    expect(clicked).toHaveBeenCalledOnce();
    expect(document.querySelector(".context-menu")).toBeNull();
  });
});
