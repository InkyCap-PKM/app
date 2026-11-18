import { describe, it, expect, afterEach } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typstLanguage } from "../typst-language";
import {
  TYPST_SOURCE_TYPE,
  displayText,
  pastedText,
  typstSourcePaste,
  visualCopy,
} from "./clipboard-source";
import { pasteUrlHandler } from "./paste-url";

// Copying from the visual editor puts the text on the clipboard as it reads
// (no escape backslashes) and the Typst source under a private type; pasting
// that copy back into InkyCap inserts the source.

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

function mk(doc: string, anchor: number, head = anchor, extensions: Extension[] = []) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [typstLanguage(), visualCopy, typstSourcePaste, ...extensions],
    }),
    parent: document.body,
  });
  view.focus();
  views.push(view);
  return view;
}

/** A clipboard holding what was written to it, by type. */
function clipboard(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get types() { return [...store.keys()]; },
    getData: (type: string) => store.get(type) ?? "",
    setData: (type: string, value: string) => void store.set(type, value),
    clearData: () => store.clear(),
  };
}

function fire(view: EditorView, type: "copy" | "cut" | "paste", data: ReturnType<typeof clipboard>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  view.contentDOM.dispatchEvent(event);
  return event as ClipboardEvent;
}

describe("displayText", () => {
  it("drops escape backslashes in markup", () => {
    const state = EditorState.create({
      doc: "mail athena\\@inkycap.org, issue \\#5, caf\\u{e9}",
      extensions: [typstLanguage()],
    });
    expect(displayText(state, 0, state.doc.length)).toBe("mail athena@inkycap.org, issue #5, café");
  });

  it("leaves escapes inside strings alone", () => {
    const doc = '#link("a\\"b")[x \\@y]';
    const state = EditorState.create({ doc, extensions: [typstLanguage()] });
    expect(displayText(state, 0, doc.length)).toBe('#link("a\\"b")[x @y]');
  });
});

describe("visual copy", () => {
  const DOC = "Write to athena\\@inkycap.org today";

  it("puts plain text and the source on the clipboard", () => {
    const view = mk(DOC, 9, 28);
    const data = clipboard();
    fire(view, "copy", data);
    expect(data.getData("text/plain")).toBe("athena@inkycap.org");
    expect(data.getData(TYPST_SOURCE_TYPE)).toBe("athena\\@inkycap.org");
  });

  it("does the same for a cut, and still removes the text", () => {
    const view = mk(DOC, 9, 28);
    const data = clipboard();
    fire(view, "cut", data);
    expect(data.getData("text/plain")).toBe("athena@inkycap.org");
    expect(data.getData(TYPST_SOURCE_TYPE)).toBe("athena\\@inkycap.org");
    expect(view.state.doc.toString()).toBe("Write to  today");
  });

  it("copies the whole line when nothing is selected", () => {
    const view = mk(`${DOC}\nnext`, 3);
    const data = clipboard();
    fire(view, "copy", data);
    expect(data.getData("text/plain")).toBe("Write to athena@inkycap.org today");
    expect(data.getData(TYPST_SOURCE_TYPE)).toBe(DOC);
  });

  it("adds no private type when the text has no escapes", () => {
    const view = mk("plain words", 0, 5);
    const data = clipboard();
    fire(view, "copy", data);
    expect(data.getData("text/plain")).toBe("plain");
    expect(data.types).not.toContain(TYPST_SOURCE_TYPE);
  });
});

describe("pasting a copy made in InkyCap", () => {
  const copied = () =>
    clipboard({ "text/plain": "athena@inkycap.org", [TYPST_SOURCE_TYPE]: "athena\\@inkycap.org" });

  it("reads the source through pastedText", () => {
    expect(pastedText(fire(mk("", 0), "paste", copied()))).toBe("athena\\@inkycap.org");
  });

  it("inserts the source with CodeMirror's own paste", () => {
    const view = mk("see ", 4);
    fire(view, "paste", copied());
    expect(view.state.doc.toString()).toBe("see athena\\@inkycap.org");
  });

  it("isn't turned into a link or escaped twice by the address paste", () => {
    const view = mk("see ", 4, 4, [
      EditorView.domEventHandlers({ paste: (event, v) => pasteUrlHandler(event, v) }),
    ]);
    fire(view, "paste", copied());
    expect(view.state.doc.toString()).toBe("see athena\\@inkycap.org");
  });

  it("uses the plain text when the copy came from elsewhere", () => {
    const view = mk("see ", 4);
    fire(view, "paste", clipboard({ "text/plain": "words" }));
    expect(view.state.doc.toString()).toBe("see words");
  });
});
