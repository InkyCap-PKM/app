import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../typst-language";
import { buildDecorations } from "./visual-plugin";

// An escape's backslash (`athena\@inkycap.org`, `\#5`) is hidden in the visual
// editor and shown again on the caret's line, like the other markup there.

const LINE_1 = "Mail athena\\@inkycap.org about issue \\#5 and \\*stars\\*";
const DOC = `${LINE_1}\nAnother line`;
const BACKSLASHES = [...LINE_1.matchAll(/\\/g)].map((m) => m.index!);

/** Positions of the backslashes the decorations hide. */
function hiddenBackslashes(caret: number): number[] {
  const state = EditorState.create({ doc: DOC, selection: { anchor: caret }, extensions: [typstLanguage()] });
  const hidden: number[] = [];
  const iter = buildDecorations(state).iter();
  for (; iter.value; iter.next()) {
    const spec = iter.value.spec ?? {};
    if (iter.to - iter.from === 1 && !spec.widget && !spec.class && DOC[iter.from] === "\\") {
      hidden.push(iter.from);
    }
  }
  return hidden.sort((a, b) => a - b);
}

describe("escape backslashes in the visual editor", () => {
  it("are hidden when the caret is on another line", () => {
    expect(hiddenBackslashes(DOC.length)).toEqual(BACKSLASHES);
  });

  it("all show when the caret is anywhere on their line", () => {
    expect(hiddenBackslashes(0)).toEqual([]);
    expect(hiddenBackslashes(LINE_1.length)).toEqual([]);
  });
});
