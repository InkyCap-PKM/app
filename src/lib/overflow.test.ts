import { describe, it, expect, vi, beforeAll } from "vitest";
import { createRoot } from "solid-js";
import { createTabStripOverflow } from "./overflow";

// A tab that doesn't fully fit in its row is hidden there and listed in the
// "more" menu, so it is never shown in both places.

beforeAll(() => {
  // jsdom has no ResizeObserver; the first measurement runs without it.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

function button(right: number, active = false): HTMLButtonElement {
  const b = document.createElement("button");
  if (active) b.className = "tab--active";
  b.getBoundingClientRect = () => ({ right, width: 30 }) as DOMRect;
  return b;
}

function strip(buttons: HTMLButtonElement[], overflowing: boolean): HTMLElement {
  const el = document.createElement("div");
  el.append(...buttons);
  el.getBoundingClientRect = () => ({ right: 100 }) as DOMRect;
  Object.defineProperty(el, "clientWidth", { value: 100 });
  Object.defineProperty(el, "scrollWidth", { value: overflowing ? 140 : 100 });
  return el;
}

async function measure(el: HTMLElement) {
  let state!: ReturnType<typeof createTabStripOverflow>;
  createRoot(() => {
    state = createTabStripOverflow("tab--active");
    state.ref(el);
  });
  await Promise.resolve();
  return state;
}

describe("createTabStripOverflow", () => {
  it("hides a partly cut-off tab along with those past the edge", async () => {
    const [fits, partly, past] = [button(60), button(105), button(140, true)];
    const state = await measure(strip([fits, partly, past], true));
    expect(state.overflowing()).toBe(true);
    expect(fits.hasAttribute("data-tab-hidden")).toBe(false);
    expect(partly.hasAttribute("data-tab-hidden")).toBe(true);
    expect(past.hasAttribute("data-tab-hidden")).toBe(true);
    expect(state.hiddenButtons()).toEqual([partly, past]);
    // The open tab is among the hidden ones.
    expect(state.activeHidden()).toBe(true);
  });

  it("hides nothing when every tab fits", async () => {
    const tabs = [button(40), button(90)];
    const state = await measure(strip(tabs, false));
    expect(state.overflowing()).toBe(false);
    expect(tabs.some((b) => b.hasAttribute("data-tab-hidden"))).toBe(false);
  });
});
