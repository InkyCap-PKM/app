import { describe, it, expect, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import MultiSelectPicker from "./MultiSelectPicker";

// Keyboard control of the Properties panel's value pickers. These drive the
// real DOM the component renders (jsdom, no testing library), because what is
// under test is exactly which element has focus and which row the keys move.

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

interface Harness {
  root: HTMLElement;
  trigger: HTMLElement;
  /** Values currently selected. */
  selected: () => string[];
  /** Whether the list is open. */
  open: () => boolean;
  /** Text of the highlighted row, or null when nothing is highlighted. */
  active: () => string | null;
  /** Text of the created value, if the create row was used. */
  created: () => string | null;
  press: (key: string) => void;
}

function mount(options: string[], opts: { filter?: boolean; selected?: string[] } = {}): Harness {
  host = document.createElement("div");
  document.body.appendChild(host);

  const [selected, setSelected] = createSignal(opts.selected ?? []);
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [created, setCreated] = createSignal<string | null>(null);

  const visible = () =>
    filter() ? options.filter((o) => o.toLowerCase().includes(filter().toLowerCase())) : options;

  dispose = render(
    () => (
      <MultiSelectPicker
        selected={selected()}
        options={visible()}
        onToggle={(v) =>
          setSelected((items) => (items.includes(v) ? items.filter((i) => i !== v) : [...items, v]))
        }
        open={open()}
        onOpenChange={setOpen}
        label="Tags"
        emptyLabel="Empty"
        noOptionsLabel="No values yet"
        filterable={opts.filter !== false}
        filterValue={filter()}
        filterPlaceholder="Filter or add new…"
        onFilterChange={setFilter}
        createLabel={
          opts.filter !== false && filter().trim() && !options.includes(filter().trim())
            ? `+ Add "${filter().trim()}"`
            : undefined
        }
        onCreate={() => setCreated(filter().trim())}
      />
    ),
    host,
  );

  const root = host as HTMLElement;
  const trigger = root.querySelector<HTMLElement>(".property-editor__tags")!;
  return {
    root,
    trigger,
    selected,
    open,
    created,
    active: () => root.querySelector(".multi-select__option--active")?.textContent ?? null,
    press: (key: string) => {
      const target = (document.activeElement ?? trigger) as HTMLElement;
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    },
  };
}

/** Let the component's post-open focus timeout run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MultiSelectPicker keyboard control", () => {
  it("opens from the chips row with Enter and focuses the filter box", async () => {
    const h = mount(["alpha", "beta"]);
    h.trigger.focus();
    h.press("Enter");
    await settle();
    expect(h.open()).toBe(true);
    expect(document.activeElement).toBe(h.root.querySelector(".multi-select__filter"));
  });

  it("moves the highlight with the arrow keys and adds with Enter", async () => {
    const h = mount(["alpha", "beta", "gamma"]);
    h.trigger.focus();
    h.press("ArrowDown");
    await settle();
    expect(h.active()).toBe("alpha");
    h.press("ArrowDown");
    expect(h.active()).toBe("beta");
    h.press("Enter");
    expect(h.selected()).toEqual(["beta"]);
  });

  it("removes an already-selected value with a second Enter", async () => {
    const h = mount(["alpha", "beta"], { selected: ["alpha"] });
    h.trigger.focus();
    h.press("Enter");
    await settle();
    h.press("Enter");
    expect(h.selected()).toEqual([]);
  });

  it("stops at the ends of the list", async () => {
    const h = mount(["alpha", "beta"]);
    h.trigger.focus();
    h.press("Enter");
    await settle();
    h.press("ArrowUp");
    expect(h.active()).toBe("alpha");
    h.press("End");
    expect(h.active()).toBe("beta");
    h.press("ArrowDown");
    expect(h.active()).toBe("beta");
    h.press("Home");
    expect(h.active()).toBe("alpha");
  });

  it("closes on Escape and puts focus back on the chips row", async () => {
    const h = mount(["alpha"]);
    h.trigger.focus();
    h.press("Enter");
    await settle();
    h.press("Escape");
    expect(h.open()).toBe(false);
    expect(document.activeElement).toBe(h.trigger);
  });

  it("closes on Tab without stealing focus back", async () => {
    const h = mount(["alpha"]);
    h.trigger.focus();
    h.press("Enter");
    await settle();
    const input = h.root.querySelector(".multi-select__filter");
    h.press("Tab");
    expect(h.open()).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  it("reaches the create row from the keyboard", async () => {
    const h = mount(["alpha"]);
    h.trigger.focus();
    h.press("Enter");
    await settle();
    const input = h.root.querySelector<HTMLInputElement>(".multi-select__filter")!;
    input.value = "brand new";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    h.press("End");
    h.press("Enter");
    expect(h.created()).toBe("brand new");
  });

  it("keeps the filter box (and the focus in it) while typing", async () => {
    // Guards the props shape: a caller that hands the picker a rebuilt object
    // per keystroke would have Solid replace this input mid-word.
    const h = mount(["alpha", "beta"]);
    h.trigger.focus();
    h.press("Enter");
    await settle();
    const input = h.root.querySelector<HTMLInputElement>(".multi-select__filter")!;
    input.value = "al";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(h.root.querySelector(".multi-select__filter")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("drives a list with no filter box from the list itself", async () => {
    const h = mount(["alpha", "beta"], { filter: false });
    h.trigger.focus();
    h.press("Enter");
    await settle();
    expect(document.activeElement).toBe(h.root.querySelector(".multi-select__list"));
    h.press("ArrowDown");
    h.press(" ");
    expect(h.selected()).toEqual(["beta"]);
  });
});

describe("MultiSelectPicker roles for assistive tech", () => {
  // Whichever element holds the focus while the list is open must be the one
  // that describes the list and names the highlighted row; a role on an
  // element that has lost focus is never read out.
  it("makes the focused filter box the combobox that names the highlight", async () => {
    const h = mount(["alpha", "beta"]);
    expect(h.trigger.getAttribute("role")).toBe("button");
    expect(h.trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(h.trigger.getAttribute("aria-expanded")).toBe("false");
    h.trigger.focus();
    h.press("ArrowDown");
    await settle();
    const input = h.root.querySelector<HTMLElement>(".multi-select__filter")!;
    const list = h.root.querySelector<HTMLElement>(".multi-select__list")!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(h.trigger.getAttribute("aria-expanded")).toBe("true");
    h.press("ArrowDown");
    const named = document.getElementById(input.getAttribute("aria-activedescendant")!);
    expect(named?.textContent).toBe("beta");
    expect(list.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("lets a focused list without a filter box name its own highlight", async () => {
    const h = mount(["alpha", "beta"], { filter: false });
    h.trigger.focus();
    h.press("Enter");
    await settle();
    const list = h.root.querySelector<HTMLElement>(".multi-select__list")!;
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("role")).toBe("listbox");
    h.press("ArrowDown");
    const named = document.getElementById(list.getAttribute("aria-activedescendant")!);
    expect(named?.textContent).toBe("beta");
  });
});

describe("MultiSelectPicker highlight bookkeeping", () => {
  it("keeps the highlight on a row that still exists as the list shrinks", () =>
    createRoot(async (disposeRoot) => {
      const h = mount(["alpha", "beta", "gamma"]);
      h.trigger.focus();
      h.press("Enter");
      await settle();
      h.press("End");
      expect(h.active()).toBe("gamma");
      const input = h.root.querySelector<HTMLInputElement>(".multi-select__filter")!;
      input.value = "alp";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(h.active()).toBe("alpha");
      disposeRoot();
    }));
});
