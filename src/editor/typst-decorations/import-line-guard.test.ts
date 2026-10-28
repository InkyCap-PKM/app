import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { importLineGuard, importLineRange } from "./import-line-guard";

const NOTEBOX = '#import "/.inkycap/notebox.typ": *';

describe("importLineRange", () => {
  it("finds the notebox import below package imports", () => {
    const doc = [
      '#import "@preview/a:1.0.0": *',
      '#import "@preview/b:1.0.0": *',
      '#import "@preview/c:1.0.0": *',
      '#import "@preview/d:1.0.0": *',
      '#import "@preview/e:1.0.0": *',
      NOTEBOX,
      "#note()",
      "Body",
    ].join("\n");
    const state = EditorState.create({ doc });
    const range = importLineRange(state);
    expect(range).not.toBeNull();
    expect(doc.slice(range!.from, range!.to)).toBe(NOTEBOX + "\n");
  });

  it("doesn't look past the #note(...) call", () => {
    const state = EditorState.create({ doc: `#note()\n${NOTEBOX}\n` });
    expect(importLineRange(state)).toBeNull();
  });
});

describe("importLineGuard", () => {
  it("lets package imports above the notebox import be removed but keeps the import", () => {
    const pkg = '#import "@preview/a:1.0.0": *\n';
    const state = EditorState.create({
      doc: `${pkg}${NOTEBOX}\n#note()\n`,
      extensions: [importLineGuard()],
    });
    const removed = state.update({ changes: { from: 0, to: pkg.length } }).state;
    expect(removed.doc.toString()).toBe(`${NOTEBOX}\n#note()\n`);
    const blocked = removed.update({ changes: { from: 0, to: NOTEBOX.length } }).state;
    expect(blocked.doc.toString()).toBe(`${NOTEBOX}\n#note()\n`);
  });
});
