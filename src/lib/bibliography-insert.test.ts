import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { appendBibliography, declaresBibliography } from "./bibliography-insert";

vi.mock("../stores/settings", () => ({
  noteboxSettings: { citations: { source: "zotero", bibliography_path: null } },
}));

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

describe("declaresBibliography", () => {
  it("finds a call, but not one in a comment", () => {
    expect(declaresBibliography('Text.\n#bibliography("/r.bib")\n')).toBe(true);
    expect(declaresBibliography('Text.\n// #bibliography("/r.bib")\n')).toBe(false);
    expect(declaresBibliography("No references.\n")).toBe(false);
  });
});

describe("appendBibliography", () => {
  it("adds the call after a blank line at the end, with the caret after it", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "Body @otlet1934.\n\n\n" }),
      parent: document.body,
    });
    views.push(view);
    appendBibliography(view);
    const text = view.state.doc.toString();
    expect(text).toBe('Body @otlet1934.\n\n#bibliography("/.inkycap/zotero-export.bib")\n');
    expect(view.state.selection.main.head).toBe(text.length);
  });
});
