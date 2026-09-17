import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { typst } from "codemirror-lang-typst";
import { typstVisualMode } from "./visual-plugin";
import { typstKeymap } from "./keymaps";

// A rendered block quote or callout is one unit to cursor motion, so arriving
// from outside puts the caret on the call's outer edge — and moving up from the
// line below lands it at the very start, ahead of the hidden opener. None of
// that markup is drawn, so the caret looks like it is in the block's text while
// typing actually writes outside the frame: the letter appears at the top of the
// block, or after it. These pin that the caret comes to rest in the body.

const QUOTE = '#quote(block: true)[Hello there]\n\ntail';
const CALLOUT = '#callout("note")[Hello there]\n\ntail';

function mk(doc: string, anchor: number) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [typst(), typstVisualMode(), keymap.of(defaultKeymap)],
    }),
    parent: document.body,
  });
}

/** Move the caret to `to` the way a motion command would, and report where it
 *  ends up and where a typed character lands. */
function moveTo(doc: string, from: number, to: number) {
  const v = mk(doc, from);
  v.dispatch({ selection: { anchor: to }, userEvent: "select" });
  const head = v.state.selection.main.head;
  v.dispatch(v.state.replaceSelection("x"), { userEvent: "input.type" });
  const line = v.state.doc.toString().split("\n")[0];
  v.destroy();
  return { head, line };
}

describe("caret entering a block element from outside", () => {
  it("lands at the end of the body when arriving from below", () => {
    // Moving up from the line below skips the whole call as one unit, so the
    // caret is placed before `#quote(block: true)[` — the far end from where
    // the writer is coming. It belongs at the end of the text they are
    // arriving at, which is also where they left it going out.
    const below = QUOTE.indexOf("\n") + 1;
    expect(moveTo(QUOTE, below, 0)).toEqual({
      head: QUOTE.indexOf("]"),
      line: "#quote(block: true)[Hello therex]",
    });
  });

  it("lands at the end of the body when motion puts it at the call's end", () => {
    const callTo = QUOTE.indexOf("]") + 1;
    const below = QUOTE.indexOf("\n") + 1;
    expect(moveTo(QUOTE, below, callTo)).toEqual({
      head: callTo - 1,
      line: "#quote(block: true)[Hello therex]",
    });
  });

  it("lands at the start of the body when arriving from above", () => {
    const doc = `above\n${QUOTE}`;
    const quoteFrom = doc.indexOf("#quote");
    expect(moveTo(doc, 0, quoteFrom)).toEqual({
      head: doc.indexOf("Hello"),
      line: "above",
    });
  });

  it("does the same for a callout", () => {
    const below = CALLOUT.indexOf("\n") + 1;
    expect(moveTo(CALLOUT, below, 0)).toEqual({
      head: CALLOUT.indexOf("]"),
      line: '#callout("note")[Hello therex]',
    });
  });

  it("still lets the caret step out onto the call's edges from inside", () => {
    // Leaving is the arrow handling's job (content edge → outer edge → out);
    // the landing rule must not drag the caret back in.
    const callTo = QUOTE.indexOf("]") + 1;
    const bodyTo = callTo - 1;
    const v = mk(QUOTE, bodyTo);
    v.dispatch({ selection: { anchor: callTo }, userEvent: "select" });
    expect(v.state.selection.main.head).toBe(callTo);
    v.destroy();
  });

  it("leaves an inline #quote in a sentence alone", () => {
    // Its edges are ordinary mid-line positions, not a hidden frame.
    const doc = 'A #quote[short] remark\n\ntail';
    const callFrom = doc.indexOf("#quote");
    const v = mk(doc, 0);
    v.dispatch({ selection: { anchor: callFrom }, userEvent: "select" });
    expect(v.state.selection.main.head).toBe(callFrom);
    v.destroy();
  });
});

// A block whose body runs over several lines is the same shape, just taller.
describe("caret entering a multi-line block", () => {
  const MULTI = '#callout("note")[First line\nsecond line]\n\ntail';

  it("lands at the end of its body when arriving from below", () => {
    const below = MULTI.lastIndexOf("]") + 2;
    const v = mk(MULTI, below);
    v.dispatch({ selection: { anchor: 0 }, userEvent: "select" });
    const head = v.state.selection.main.head;
    v.destroy();
    expect(head).toBe(MULTI.lastIndexOf("]"));
  });
});

// Home inside a block element, and Left out of a verse, both used to be
// answered by the line-start caret rule, which is written for a list bullet:
// it sends a caret at a line start past any hidden markup covering it. For a
// whole-line element that markup *is* the element, so Home landed in front of
// the block and leaving a verse leftwards threw the caret to its far end.
describe("keyboard motion at a block element's own line start", () => {
  it("Home puts the caret at the start of the body, not before the block", () => {
    const v = mk(QUOTE, QUOTE.indexOf("there"));
    for (const b of typstKeymap) {
      if (b.key === "Home" && b.run) { b.run(v); break; }
    }
    const head = v.state.selection.main.head;
    v.destroy();
    expect(head).toBe(QUOTE.indexOf("Hello"));
  });

  it("Home stays on the body start when pressed again", () => {
    const v = mk(QUOTE, QUOTE.indexOf("Hello"));
    for (const b of typstKeymap) {
      if (b.key === "Home" && b.run) { b.run(v); break; }
    }
    const head = v.state.selection.main.head;
    v.destroy();
    expect(head).toBe(QUOTE.indexOf("Hello"));
  });

  it("leaves a caret sent to a verse's own start where it was sent", () => {
    // How the verse canvas hands control back when Left is pressed at the
    // start of its text: it puts the caret in front of the call.
    const doc = 'before\n#verse("a line\\nanother")\n\ntail';
    const callFrom = doc.indexOf("#verse");
    const v = mk(doc, doc.length);
    v.dispatch({ selection: { anchor: callFrom } });
    const head = v.state.selection.main.head;
    v.destroy();
    expect(head).toBe(callFrom);
  });
});

describe("clicking on a block element's frame", () => {
  it("lands in the body even when the caret was already inside", () => {
    // A click places the caret afresh; it is not the deliberate step out of the
    // body that the arrow keys make.
    const v = mk(QUOTE, QUOTE.indexOf("there"));
    v.dispatch({ selection: { anchor: 0 }, userEvent: "select.pointer" });
    const head = v.state.selection.main.head;
    v.destroy();
    expect(head).toBe(QUOTE.indexOf("Hello"));
  });
});

// The rule reads what is drawn — a replaced range holding a
// `BlockBodyElementWidget` — so every element built that way behaves the same.
// An earlier version worked off the syntax tree instead and quietly missed a
// callout whose body ran over several lines or held another call, because the
// parser stops a FuncCall node short in both cases.
describe("every block element behaves the same way", () => {
  const CASES: { name: string; doc: string }[] = [
    { name: "a one-line block quote", doc: "#quote(block: true)[Hello there]\n\ntail" },
    {
      name: "a callout with a link and several lines",
      doc: '#callout("note")[\nSee #wikilink("Note") for more,\nand again.\n]\n\ntail',
    },
    { name: "a callout holding a quote", doc: '#callout("note")[He said #quote[hello] once]\n\ntail' },
  ];

  /** Body bounds the way the element's own brackets define them. */
  const body = (doc: string) => ({ from: doc.indexOf("[") + 1, to: doc.lastIndexOf("]") });

  for (const c of CASES) {
    it(`lands at the end of ${c.name} when arriving from below`, () => {
      const v = mk(c.doc, c.doc.lastIndexOf("tail"));
      v.dispatch({ selection: { anchor: 0 }, userEvent: "select" });
      const head = v.state.selection.main.head;
      v.destroy();
      expect(head).toBe(body(c.doc).to);
    });

    it(`lands at the start of ${c.name} when arriving from above`, () => {
      const doc = `above\n${c.doc}`;
      const blockFrom = doc.indexOf("\n") + 1;
      const v = mk(doc, 0);
      v.dispatch({ selection: { anchor: blockFrom }, userEvent: "select" });
      const head = v.state.selection.main.head;
      v.destroy();
      expect(head).toBe(body(doc).from);
    });

    it(`pulses the body of ${c.name} on the way in`, () => {
      const v = mk(c.doc, c.doc.lastIndexOf("tail"));
      v.dispatch({ selection: { anchor: 0 }, userEvent: "select" });
      const pulsed = v.dom.querySelector(".cm-typst-pill-pulse") !== null;
      v.destroy();
      expect(pulsed).toBe(true);
    });
  }
});
