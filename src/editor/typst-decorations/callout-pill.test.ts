// The callout pill menu: kind, heading words, accent colour.
//
// Each of the three writes one argument of the `#callout(...)` call and leaves
// the rest of the source alone, so a callout edited through the menu stays the
// same Typst a writer would have typed by hand.

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getPillOptions } from "./pill-options";
import type { PillMenuItem, PillMenuSection } from "./pill";

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc }), parent });
}

/** The menu a callout's pill would show for the call at the start of `doc`. */
function calloutMenu(view: EditorView): PillMenuSection[] {
  return getPillOptions("callout", view, 0, view.state.doc.length);
}

function section(view: EditorView, index: number): PillMenuItem[] {
  return calloutMenu(view)[index].items;
}

const KIND = 0, TITLE = 1, COLOUR = 2;

describe("callout pill menu", () => {
  it("changes the kind without disturbing the other arguments", () => {
    const view = mount('#callout("note", title: "Heads up")[Body]');
    section(view, KIND).find((i) => i.label === "Warning")!.onSelect!();
    expect(view.state.doc.toString()).toBe('#callout("warning", title: "Heads up")[Body]');
    view.destroy();
  });

  it("writes the heading words, and clears them when emptied", () => {
    const view = mount('#callout("note")[Body]');
    section(view, TITLE)[0].input!.onCommit("Read this first");
    expect(view.state.doc.toString()).toBe('#callout("note", title: "Read this first")[Body]');

    section(view, TITLE)[0].input!.onCommit("   ");
    expect(view.state.doc.toString()).toBe('#callout("note")[Body]');
    view.destroy();
  });

  it("escapes quotes in the heading words", () => {
    const view = mount('#callout("note")[Body]');
    section(view, TITLE)[0].input!.onCommit('The "good" parts');
    expect(view.state.doc.toString()).toBe('#callout("note", title: "The \\"good\\" parts")[Body]');
    // …and reads them back unescaped for the field.
    expect(section(view, TITLE)[0].input!.value).toBe('The "good" parts');
    view.destroy();
  });

  it("shows the kind's own word as the field's placeholder", () => {
    const view = mount('#callout("warning")[Body]');
    expect(section(view, TITLE)[0].input!.placeholder).toBe("Warning");
    view.destroy();
  });

  it("writes a colour override and takes it back off", () => {
    const view = mount('#callout("note")[Body]');
    expect(section(view, COLOUR)[0].isActive).toBe(true); // "Match the kind"

    section(view, COLOUR)[1].input!.onCommit("#ff9100");
    expect(view.state.doc.toString()).toBe('#callout("note", color: rgb("#ff9100"))[Body]');
    expect(section(view, COLOUR)[0].isActive).toBe(false);
    expect(section(view, COLOUR)[1].input!.value).toBe("#ff9100");

    section(view, COLOUR)[0].onSelect!();
    expect(view.state.doc.toString()).toBe('#callout("note")[Body]');
    view.destroy();
  });

  it("clears a hand-written colour whole, commas and all", () => {
    // `rgb(255, 145, 0)` is a perfectly good thing to type by hand, and
    // "Match the kind" has to take all of it, not up to its first comma.
    const view = mount('#callout("note", color: rgb(255, 145, 0), title: "Hi")[Body]');
    section(view, COLOUR)[0].onSelect!();
    expect(view.state.doc.toString()).toBe('#callout("note", title: "Hi")[Body]');
    view.destroy();
  });

  it("opens the colour field on the kind's colour while there is no override", () => {
    const view = mount('#callout("danger")[Body]');
    expect(section(view, COLOUR)[1].input!.value).toBe("#d50000");
    view.destroy();
  });
});
