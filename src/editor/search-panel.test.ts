import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { inkycapSearch } from "./search-panel";

// The find panel puts the editor's selection on the current match as the user
// types. Typing must refine that match in place, and typing a replacement must
// leave it alone, or Replace changes an occurrence the user never saw.

const DOC = "alpha one alpha two alpha three";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function openPanel(): HTMLElement {
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [inkycapSearch, keymap.of(searchKeymap)],
    }),
    parent: document.body,
  });
  openSearchPanel(view);
  return view.dom.querySelector<HTMLElement>(".cm-search")!;
}

/** Type `text` into `field` one character at a time, as a keyboard would. */
function typeInto(field: HTMLInputElement, text: string) {
  for (const ch of text) {
    field.value += ch;
    field.dispatchEvent(new Event("input"));
  }
}

function selected(): string {
  const { from, to } = view!.state.selection.main;
  return `${from}-${to}`;
}

describe("find panel current match", () => {
  it("stays on the first match while the search is typed", () => {
    const panel = openPanel();
    typeInto(panel.querySelector<HTMLInputElement>('input[name="search"]')!, "alpha");
    expect(selected()).toBe("0-5");
  });

  it("does not move while the replacement is typed", () => {
    const panel = openPanel();
    typeInto(panel.querySelector<HTMLInputElement>('input[name="search"]')!, "alpha");
    typeInto(panel.querySelector<HTMLInputElement>('input[name="replace"]')!, "beta");
    expect(selected()).toBe("0-5");
  });

  it("replaces the match it shows", () => {
    const panel = openPanel();
    typeInto(panel.querySelector<HTMLInputElement>('input[name="search"]')!, "alpha");
    typeInto(panel.querySelector<HTMLInputElement>('input[name="replace"]')!, "beta");
    panel.querySelector<HTMLButtonElement>('button[name="replace"]')!.click();
    expect(view!.state.doc.toString()).toBe("beta one alpha two alpha three");
    // Moves on to the next remaining match.
    expect(selected()).toBe("9-14");
  });
});
