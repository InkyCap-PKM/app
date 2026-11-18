import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  extractFirstStringArg,
  typstMarkupEscape,
  typstStringEscape,
  typstStringUnescape,
} from "./typst";
import { typstLanguage } from "../editor/typst-language";
import { buildDecorations } from "../editor/typst-decorations/visual-plugin";
import { TaskWidget } from "../editor/typst-decorations/widgets";

// A task body written by the Markdown importer, holding escaped quotes.
const TASK =
  '#task("Look into the books on the Journal of Sonic Studies#link(\\"https://www.researchcatalogue.net/view/558982/2219112\\"), ' +
  'some may be good for #wikilink(\\"Communication Studies\\")  #tag(\\"rwlgd\\")")';
const TASK_BODY =
  'Look into the books on the Journal of Sonic Studies#link("https://www.researchcatalogue.net/view/558982/2219112"), ' +
  'some may be good for #wikilink("Communication Studies")  #tag("rwlgd")';

describe("typstStringUnescape", () => {
  it("reverses typstStringEscape", () => {
    const s = 'a "quoted" back\\slash\nline\ttab\r';
    expect(typstStringUnescape(typstStringEscape(s))).toBe(s);
  });

  it("reads unicode escapes", () => {
    expect(typstStringUnescape("caf\\u{e9} \\u{1F600}")).toBe("café 😀");
  });

  it("keeps an escape Typst doesn't know as written", () => {
    expect(typstStringUnescape("a\\qb")).toBe("a\\qb");
  });
});

describe("extractFirstStringArg", () => {
  it("reads past escaped quotes to the closing quote", () => {
    expect(extractFirstStringArg(TASK)).toBe(TASK_BODY);
  });

  it("returns null when the first argument isn't a string", () => {
    expect(extractFirstStringArg("#link(<label>)[x]")).toBeNull();
  });
});

describe("visual task widget", () => {
  it("shows a task's whole body when it holds escaped quotes", () => {
    const doc = `${TASK}\n\nafter`;
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [typstLanguage()],
    });
    const bodies: string[] = [];
    const iter = buildDecorations(state).iter();
    for (; iter.value; iter.next()) {
      const widget = iter.value.spec?.widget;
      if (widget instanceof TaskWidget) bodies.push(widget.body);
    }
    expect(bodies).toEqual([TASK_BODY]);
  });
});

describe("typstMarkupEscape", () => {
  it("leaves ordinary text alone", () => {
    expect(typstMarkupEscape("files.example.test/x_y?a=1&b=2")).toBe("files.example.test/x_y?a=1&b=2");
  });

  it("escapes comment marks, references and code", () => {
    expect(typstMarkupEscape("zotero://a#b")).toBe("zotero:\\//a\\#b");
    expect(typstMarkupEscape("athena@inkycap.org")).toBe("athena\\@inkycap.org");
  });
});
