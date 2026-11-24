import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bibliographyOptions } from "./bibliography-pill";

vi.mock("../../stores/settings", () => ({
  settings: { citations: { citation_style: "chicago-author-date" } },
  noteboxSettings: { citations: { custom_csl_path: null } },
}));
const picked = vi.hoisted(() => ({ style: "nature" as string | null }));
vi.mock("../../stores/citationStylePicker", () => ({
  pickCitationStyle: () => Promise.resolve(picked.style),
}));

// The bibliography pill sets the list's title and this call's citation style,
// one argument at a time, leaving the rest of the call as written.

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

function mount(doc: string): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc }), parent: document.body });
  views.push(view);
  return view;
}

function options(view: EditorView) {
  return bibliographyOptions(view, 0, view.state.doc.length);
}

const CALL = '#bibliography("/.inkycap/zotero-export.bib")';

describe("the bibliography title", () => {
  it("is set, changed and cleared through the title field", () => {
    const view = mount(CALL);
    options(view)[0].items[0].input!.onCommit("Works cited");
    expect(view.state.doc.toString())
      .toBe('#bibliography("/.inkycap/zotero-export.bib", title: [Works cited])');
    expect(options(view)[0].items[0].input!.value).toBe("Works cited");
    options(view)[0].items[0].input!.onCommit("");
    expect(view.state.doc.toString()).toBe(CALL);
  });

  it("can be turned off and back on", () => {
    const view = mount(CALL);
    options(view)[0].items[1].onSelect!();
    expect(view.state.doc.toString()).toBe('#bibliography("/.inkycap/zotero-export.bib", title: none)');
    expect(options(view)[0].items[1].isActive).toBe(true);
    options(view)[0].items[1].onSelect!();
    expect(view.state.doc.toString()).toBe(CALL);
  });
});

describe("the bibliography style", () => {
  it("names the default style and marks it while the call has none", () => {
    const [def] = options(mount(CALL))[1].items;
    expect(def.label).toBe("Default: Chicago (Author-Date)");
    expect(def.isActive).toBe(true);
  });

  it("writes the picked style into the call, and the default removes it", async () => {
    const view = mount(CALL);
    const choose = options(view)[1].items.at(-1)!;
    choose.onSelect!();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe('#bibliography("/.inkycap/zotero-export.bib", style: "nature")');
    const [def, current] = options(view)[1].items;
    expect(current).toMatchObject({ label: "nature", isActive: true });
    def.onSelect!();
    expect(view.state.doc.toString()).toBe(CALL);
  });
});
