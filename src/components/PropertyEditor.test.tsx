import { describe, it, expect, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import PropertyEditor from "./PropertyEditor";
import type { PropertyValue } from "../lib/types";

// The Properties panel reuses one row per property name as the user moves
// between notes, so every editor has to repaint from its current value rather
// than from whatever it was handed when it was first created.

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

function mount(initial: PropertyValue) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const [value, setValue] = createSignal<PropertyValue>(initial);
  dispose = render(
    () => (
      <PropertyEditor propKey="journalconnection" value={value()} onSave={() => {}} />
    ),
    host,
  );
  return {
    setValue,
    /** Text of the rendered link, or null when the value isn't a link. */
    linkText: () =>
      host!.querySelector(".property-editor__wikilink")?.textContent ?? null,
    text: () => host!.querySelector(".property-editor__value")?.textContent ?? null,
  };
}

describe("PropertyEditor wikilink values", () => {
  it("repaints the link when the value changes under a reused row", () => {
    const row = mount("[[2026-09-14]]");
    expect(row.linkText()).toBe("2026-09-14");

    row.setValue("[[2026-06-15]]");
    expect(row.linkText()).toBe("2026-06-15");
  });

  it("switches between link and plain text as the value changes", () => {
    const row = mount("[[2026-09-14]]");
    row.setValue("no link here");
    expect(row.linkText()).toBeNull();
    expect(row.text()).toBe("no link here");

    row.setValue("see [[Some Note]]");
    expect(row.linkText()).toBe("Some Note");
  });
});
