import { describe, it, expect } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { cursorCharLeft } from "@codemirror/commands";
import { typst } from "codemirror-lang-typst";
import { buildDecorations, typstVisualMode } from "./visual-plugin";
import { typstKeymap } from "./keymaps";

// The visual editor's bullet widget has a zero-width margin box (it is pulled
// into the hanging-indent margin), so the caret in front of a list marker and
// the caret after it are drawn at the same place. These cover the two bugs
// that came out of that: characters typed in front of the bullet, and a
// deletion that leaves the marker behind as `- - item`.

const visual = (doc: string, selection?: { anchor: number; head?: number }) =>
  EditorState.create({
    doc,
    selection: selection && EditorSelection.single(selection.anchor, selection.head ?? selection.anchor),
    extensions: [typst(), typstVisualMode()],
  });

/** Apply a selection-only transaction, as a click or an arrow key would. */
const select = (state: EditorState, anchor: number, head = anchor) =>
  state.update({ selection: EditorSelection.single(anchor, head) }).state.selection.main;

describe("caret in front of a list marker", () => {
  const DOC = "- alpha\n- beta\n- gamma";
  const BETA = DOC.indexOf("- beta");

  it("moves a caret placed at the line start to after the marker", () => {
    const sel = select(visual(DOC), BETA);
    expect(sel.empty).toBe(true);
    expect(sel.head).toBe(BETA + 2);
  });

  it("leaves a caret that is already after the marker alone", () => {
    expect(select(visual(DOC), BETA + 2).head).toBe(BETA + 2);
  });

  it("moves past the whole marker on an indented item", () => {
    const doc = "- alpha\n  - beta";
    const nested = doc.indexOf("  - beta");
    expect(select(visual(doc), nested).head).toBe(nested + 4);
  });

  it("moves past a numbered marker too", () => {
    const doc = "1. one\n2. two";
    const two = doc.indexOf("2. two");
    expect(select(visual(doc), two).head).toBe(two + 3);
  });

  it("leaves an empty list item's own caret position reachable", () => {
    // `- ` with nothing after it: the marker runs to the end of the line, so
    // the position after it is where a fresh item's typing has to land.
    const doc = "- alpha\n- ";
    const empty = doc.indexOf("\n- ") + 1;
    expect(select(visual(doc), empty).head).toBe(doc.length);
  });

  it("leaves a plain paragraph's line start alone", () => {
    const doc = "- alpha\nprose";
    const prose = doc.indexOf("prose");
    expect(select(visual(doc), prose).head).toBe(prose);
  });

  it("lands after the marker when the caret arrives from another line", () => {
    // Up from the gamma line with the goal column at zero: a vertical move,
    // not a step back along beta's own line.
    const gamma = DOC.indexOf("- gamma");
    expect(select(visual(DOC, { anchor: gamma + 3 }), BETA).head).toBe(BETA + 2);
  });
});

describe("stepping back onto a list marker", () => {
  // Left from the start of an item's text: CodeMirror's atomic handling has
  // already pushed the caret from after the marker to the line start. Sending
  // it forward again would pin it there for good, so it continues to where
  // the writer was heading.
  const DOC = "- alpha\n- beta\n- gamma";
  const BETA = DOC.indexOf("- beta");
  const ALPHA_END = DOC.indexOf("\n");

  const view = (anchor: number) =>
    new EditorView({
      state: EditorState.create({
        doc: DOC,
        selection: { anchor },
        extensions: [typst(), typstVisualMode(), keymap.of(typstKeymap)],
      }),
      parent: document.body,
    });

  it("goes to the end of the previous line", () => {
    // Cursor-motion commands annotate their transactions as "select".
    const tr = visual(DOC, { anchor: BETA + 2 }).update({
      selection: EditorSelection.single(BETA),
      userEvent: "select",
    });
    expect(tr.state.selection.main.head).toBe(ALPHA_END);
  });

  it("treats an unannotated jump to the line start as a placement", () => {
    expect(select(visual(DOC, { anchor: BETA + 2 }), BETA).head).toBe(BETA + 2);
  });

  it("Left arrow crosses to the previous line", () => {
    const v = view(BETA + 2);
    cursorCharLeft(v);
    expect(v.state.selection.main.head).toBe(ALPHA_END);
    v.destroy();
  });

  it("does not step back off the first line", () => {
    const v = view(2);
    cursorCharLeft(v);
    expect(v.state.selection.main.head).toBe(2);
    v.destroy();
  });

  it("a click on the line start still lands after the marker", () => {
    const v = view(BETA + 4);
    v.dispatch({ selection: EditorSelection.single(BETA), userEvent: "select.pointer" });
    expect(v.state.selection.main.head).toBe(BETA + 2);
    v.destroy();
  });

  it("Home stays on the start of the item's text", () => {
    // In source mode a second Home jumps before the marker; here the marker
    // is hidden, so there is nowhere visible to go.
    const v = view(BETA + 4);
    const home = typstKeymap.find((b) => b.key === "Home")!;
    home.run!(v);
    expect(v.state.selection.main.head).toBe(BETA + 2);
    home.run!(v);
    expect(v.state.selection.main.head).toBe(BETA + 2);
    v.destroy();
  });
});

describe("selection that ends in front of a list marker", () => {
  const DOC = "- alpha\n- beta\n- gamma";
  const BETA = DOC.indexOf("- beta");
  const GAMMA = DOC.indexOf("- gamma");

  /** The document left behind by deleting `selection`. */
  const afterDelete = (state: EditorState, anchor: number, head: number) => {
    const sel = select(state, anchor, head);
    return state.update({ changes: { from: sel.from, to: sel.to } }).state.doc.toString();
  };

  it("does not leave the marker behind when a run of items is deleted", () => {
    // Dragging from just after alpha's bullet to the start of gamma's line
    // used to delete `alpha\n- beta\n`, leaving `- ` + `- gamma`.
    expect(afterDelete(visual(DOC), 2, GAMMA)).toBe("- gamma");
  });

  it("merges into the previous item rather than stacking two markers", () => {
    expect(afterDelete(visual(DOC), 2, BETA)).toBe("- beta\n- gamma");
  });

  it("still deletes the marker of a whole line selected from its start", () => {
    // Selecting all of beta's line including the break: the start end stays
    // put, so the marker goes with the line.
    expect(afterDelete(visual(DOC), BETA, GAMMA)).toBe("- alpha\n- gamma");
  });

  it("keeps a reversed selection reversed", () => {
    const sel = select(visual(DOC), GAMMA, 2);
    expect(sel.from).toBe(2);
    expect(sel.to).toBe(GAMMA + 2);
    expect(sel.head).toBe(2);
  });
});

describe("a marker that does not open its line", () => {
  /** `from-to kind` for every decoration the visual layer builds over `doc`. */
  const decorate = (doc: string) => {
    const set = buildDecorations(
      EditorState.create({ doc, selection: { anchor: 0 }, extensions: [typst()] }),
    );
    const out: string[] = [];
    const iter = set.iter();
    while (iter.value) {
      const spec = iter.value.spec as { widget?: object; attributes?: { style?: string } };
      out.push(spec.widget ? `${iter.from}-${iter.to} bullet` : `${iter.from}-${iter.to} indent`);
      iter.next();
    }
    return out;
  };

  it("draws one bullet and leaves the stray marker as text", () => {
    // `- - beta` is a nested list to Typst. Rendering the inner marker put two
    // overlapping widgets and two indent decorations on one line, so the item
    // looked indented with no leading whitespace for Shift+Tab to remove.
    expect(decorate("- - beta")).toEqual(["0-0 indent", "0-2 bullet"]);
  });

  it("still decorates an ordinary indented item", () => {
    expect(decorate("- alpha\n  - beta")).toEqual([
      "0-0 indent", "0-2 bullet", "8-8 indent", "8-12 bullet",
    ]);
  });
});
