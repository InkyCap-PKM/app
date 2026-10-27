// Editing one table cell, and drawing the cells not being edited.
//
// An idle cell is painted from the note's own state: the inline-only visual
// decorations for its source range, as plain DOM. The cell being edited hosts a
// small CodeMirror view over a copy of the note, with everything outside the
// cell hidden and locked (cell-scope.ts), so wikilinks, emphasis, the `/`
// palette, suggestions and spell-check work as in the note.
//
// Changes go both ways: the cell editor's are sent to the note, and the note's
// (undo, edits elsewhere) are copied into the cell editor. Both carry
// `cellSync` so nothing echoes back. The note remains the only source of truth.

import {
  Annotation,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  RangeSet,
  Transaction,
  type ChangeSet,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet, type WidgetType } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { scopeRangeConfig, scopeRangeField, setScopeRange, type ScopeRange } from "./cell-scope";
import { type CellMatch } from "./cell-search";
import { parseClipboardAsGrid } from "./table-parser";

/** Marks a transaction that mirrors a change already made in the other editor. */
export const cellSync = Annotation.define<boolean>();

/**
 * What a cell editor needs from the note editor, provided as a facet so this
 * module doesn't depend on the editor's setup.
 */
export interface CellEditorConfig {
  /** Extensions for a cell editor: language, theme, the inline-only visual
   *  decorations, and the input helpers. `main` is the note's editor. */
  extensions(main: EditorView): Extension[];
  /** Inline-only visual decorations for `[from, to)` of `state`. */
  inlineDecorations(state: EditorState, from: number, to: number): DecorationSet;
}

/** Without a config, cells show their plain source text and cannot be
 *  edited in place. */
export const cellEditorConfig = Facet.define<CellEditorConfig, CellEditorConfig | null>({
  combine: (values) => (values.length ? values[0] : null),
});

/** What the cell editor asks of its table when a key leaves the cell. */
export interface CellNavigation {
  tab(shift: boolean): void;
  enter(): void;
  escape(): void;
  /** A grid of two or more cells was pasted. */
  pasteGrid(grid: string[][]): void;
}

const hidden = Decoration.replace({});

function outsideScopeRanges(state: EditorState): DecorationSet {
  const scope = state.field(scopeRangeField);
  if (!scope) return Decoration.none;
  const ranges = [];
  if (scope.from > 0) ranges.push(hidden.range(0, scope.from));
  if (scope.to < state.doc.length) ranges.push(hidden.range(scope.to, state.doc.length));
  return Decoration.set(ranges);
}

/** Everything outside the editable range is hidden and skipped by the caret. */
const outsideScope = [
  EditorView.decorations.compute([scopeRangeField], outsideScopeRanges),
  EditorView.atomicRanges.of((view) => outsideScopeRanges(view.state)),
];

/**
 * Keep edits and the selection inside the editable range: changes reaching
 * outside are dropped, selections outside are clamped. Changes mirrored from
 * the note are exempt.
 */
const scopeGuard = EditorState.transactionFilter.of((tr) => {
  const before = tr.startState.field(scopeRangeField);
  if (!before) return tr;
  if (tr.docChanged && !tr.annotation(cellSync)) {
    let outside = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA < before.from || toA > before.to) outside = true;
    });
    if (outside) return [];
  }
  let after: ScopeRange | null = null;
  for (const e of tr.effects) {
    if (e.is(setScopeRange)) after = e.value;
  }
  if (!after) {
    after = tr.docChanged
      ? { from: tr.changes.mapPos(before.from, -1), to: tr.changes.mapPos(before.to, 1) }
      : before;
  }
  const { from, to } = after;
  const sel = tr.newSelection;
  if (sel.ranges.every((r) => r.from >= from && r.to <= to)) return tr;
  const clamp = (pos: number) => Math.min(Math.max(pos, from), to);
  const clamped = EditorSelection.create(
    sel.ranges.map((r) => EditorSelection.range(clamp(r.anchor), clamp(r.head))),
    sel.mainIndex,
  );
  return [tr, { selection: clamped, sequential: true }];
});

/**
 * Whether the caret is on the cell's top (`up`) or bottom (`down`) visual line.
 * While editing, the arrow keys stay in the cell, moving through its text
 * (wrapped rows included) and stopping at its edges; moving between cells is
 * for navigation mode (Escape, then arrows), and Tab and Enter move on
 * directly.
 *
 * Measured with the editor's own vertical motion and goal column, so wrapped
 * lines count. Everything outside the cell is collapsed onto its lines, so a
 * target outside its range means there was nowhere left to go.
 */
function atCellEdge(view: EditorView, direction: "up" | "down"): boolean {
  const scope = view.state.field(scopeRangeField);
  if (!scope) return true;
  const start = view.state.selection.main;
  const target = view.moveVertically(start, direction === "down");
  if (target.head === start.head) return true;
  return target.head < scope.from || target.head > scope.to;
}

function cellKeymap(main: EditorView, nav: CellNavigation): Extension {
  return Prec.highest(keymap.of([
    { key: "Tab", run: () => (nav.tab(false), true), shift: () => (nav.tab(true), true) },
    { key: "Enter", run: () => (nav.enter(), true) },
    { key: "Escape", run: () => (nav.escape(), true) },
    // Swallowed at the cell's edges: the caret stays in the cell being edited.
    { key: "ArrowUp", run: (view) => atCellEdge(view, "up") },
    { key: "ArrowDown", run: (view) => atCellEdge(view, "down") },
    // The note's editor owns the undo history; the result is mirrored back.
    { key: "Mod-z", run: () => undo(main) },
    { key: "Mod-y", run: () => redo(main) },
    { key: "Mod-Shift-z", run: () => redo(main) },
  ]));
}

/** A pasted grid fills cells from this one; anything else pastes as text. */
function cellPaste(nav: CellNavigation): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    paste(event) {
      const grid = parseClipboardAsGrid(event);
      if (!grid || (grid.length === 1 && grid[0].length <= 1)) return false;
      event.preventDefault();
      nav.pasteGrid(grid);
      return true;
    },
  }));
}

/**
 * The cell editor has no chrome, padding or centred column, and uses the cell's
 * font and line height. The note's theme also matches this nested editor, so
 * these rules use their own class and the highest precedence.
 */
const CELL_EDITOR_CLASS = "cm-typst-cell-editor";
const cellTheme = [
  EditorView.editorAttributes.of({ class: CELL_EDITOR_CLASS }),
  Prec.highest(EditorView.theme({
    [`&.${CELL_EDITOR_CLASS}`]: { backgroundColor: "transparent", height: "auto" },
    [`&.${CELL_EDITOR_CLASS}.cm-focused`]: { outline: "none" },
    [`&.${CELL_EDITOR_CLASS} .cm-scroller`]: {
      overflow: "visible",
      fontFamily: "inherit",
      fontSize: "inherit",
      lineHeight: "inherit",
    },
    [`&.${CELL_EDITOR_CLASS} .cm-content`]: {
      padding: "0",
      margin: "0",
      maxWidth: "none",
      minHeight: "0",
      lineHeight: "inherit",
    },
    [`&.${CELL_EDITOR_CLASS} .cm-line`]: { padding: "0" },
  })),
];

/**
 * The CodeMirror view editing one cell: created when a cell becomes active,
 * mounted in it, destroyed when it is left.
 */
export class CellEditor {
  readonly view: EditorView;

  constructor(
    readonly main: EditorView,
    container: HTMLElement,
    range: ScopeRange,
    nav: CellNavigation,
    config: CellEditorConfig,
  ) {
    const state = EditorState.create({
      doc: main.state.doc,
      selection: { anchor: range.to },
      extensions: [
        cellTheme,
        scopeRangeConfig.of(range),
        scopeRangeField,
        outsideScope,
        scopeGuard,
        EditorView.lineWrapping,
        ...config.extensions(main),
        // After the note's extensions: the suggestion popups bind the arrow
        // keys at the same precedence and must get them first while open.
        cellKeymap(main, nav),
        cellPaste(nav),
      ],
    });
    this.view = new EditorView({
      state,
      parent: container,
      dispatchTransactions: (trs, view) => this.forward(trs, view),
    });
  }

  /** Apply a transaction here, then re-dispatch its changes to the note. */
  private forward(trs: readonly Transaction[], view: EditorView) {
    view.update(trs);
    const hadFocus = this.hasFocus;
    for (const tr of trs) {
      if (!tr.docChanged || tr.annotation(cellSync)) continue;
      this.main.dispatch({
        changes: tr.changes,
        annotations: cellSync.of(true),
        userEvent: tr.annotation(Transaction.userEvent),
        scrollIntoView: false,
      });
    }
    // Redrawing the note's line takes this editor's DOM out and puts it
    // back, which drops focus; take it back before the next keystroke.
    if (hadFocus && !this.hasFocus) this.restoreFocus();
  }

  /**
   * Whether this editor's content is the active element (`hasFocus` also checks
   * window focus).
   */
  get hasFocus(): boolean {
    return this.view.dom.ownerDocument.activeElement === this.view.contentDOM;
  }

  /**
   * Focus the editor and put the browser selection where the state says. WebKit
   * puts the caret at the start of a freshly focused editable, and CodeMirror's
   * cached DOM selection still matches its state, so it wouldn't fix it.
   */
  restoreFocus() {
    if (!this.view.dom.isConnected) return;
    this.view.focus();
    const { anchor, head } = this.view.state.selection.main;
    const a = this.view.domAtPos(anchor);
    const h = this.view.domAtPos(head);
    this.view.dom.ownerDocument.getSelection()?.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  }

  /** Mirror a change made in the note. */
  applyMainChanges(changes: ChangeSet) {
    this.view.dispatch({ changes, annotations: cellSync.of(true) });
  }

  /** The cell's current source range. */
  get range(): ScopeRange | null {
    return this.view.state.field(scopeRangeField);
  }

  /** Re-anchor on the cell after the table's source was rewritten around it. */
  setRange(range: ScopeRange) {
    const cur = this.range;
    if (cur && cur.from === range.from && cur.to === range.to) return;
    this.view.dispatch({ effects: setScopeRange.of(range) });
  }

  /** Put the caret at a source offset, at the end, or select the whole cell. */
  focus(caret: "end" | "all" | number) {
    const r = this.range;
    if (!r) return;
    const selection = caret === "all"
      ? EditorSelection.single(r.from, r.to)
      : EditorSelection.cursor(caret === "end" ? r.to : Math.min(Math.max(caret, r.from), r.to));
    this.view.dispatch({ selection });
    this.view.focus();
  }

  /** Replace the whole cell with `text`, as typing over a selected cell does. */
  replaceContent(text: string) {
    const r = this.range;
    if (!r) return;
    this.view.dispatch({
      changes: { from: r.from, to: r.to, insert: text },
      selection: { anchor: r.from + text.length },
      userEvent: "input.type",
    });
  }

  destroy() {
    this.view.destroy();
  }
}

// ---------------------------------------------------------------------------
// Idle cells
// ---------------------------------------------------------------------------

/** The widgets an idle cell rendered, so they can be destroyed before the
 *  cell is painted again. */
export interface RenderedCell {
  widgets: { widget: WidgetType; dom: HTMLElement }[];
}

/**
 * Paint a cell's source as the visual editor shows it: marks become spans,
 * inline widgets (wikilinks, links, pills) their own DOM, and hidden markup is
 * left out. Each text run has `data-from`, its source offset, so a click maps
 * back to a position (see `sourcePosAt`).
 *
 * Each source line becomes its own element with its line decoration (notably
 * the list indent the bullet hangs from). `matches` are the find panel's hits
 * (see cell-search.ts), drawn as marks.
 */
export function renderIdleCell(
  main: EditorView,
  container: HTMLElement,
  from: number,
  to: number,
  config: CellEditorConfig | null,
  matches: readonly CellMatch[] = [],
): RenderedCell {
  container.replaceChildren();
  const rendered: RenderedCell = { widgets: [] };
  const doc = main.state.doc;
  const lines = new CellLines(container, from);
  if (!config) {
    lines.appendText(doc.sliceString(from, to), from, []);
    return rendered;
  }
  const sets = [config.inlineDecorations(main.state, from, to)];
  if (matches.length) sets.push(searchMarks(matches));
  RangeSet.spans(sets, from, to, {
    span(spanFrom, spanTo, active) {
      if (spanFrom === spanTo) return;
      lines.appendText(doc.sliceString(spanFrom, spanTo), spanFrom, active);
    },
    point(pointFrom, pointTo, deco) {
      if (isLineDecoration(deco)) {
        lines.decorateLine(deco);
        return;
      }
      const widget = deco.spec?.widget as WidgetType | undefined;
      if (!widget) return;
      const dom = widget.toDOM(main);
      dom.dataset.from = String(pointFrom);
      dom.dataset.to = String(pointTo);
      lines.appendElement(dom);
      rendered.widgets.push({ widget, dom });
    },
  });
  return rendered;
}

/** Destroy the widgets a previous `renderIdleCell` created. */
export function destroyRenderedCell(rendered: RenderedCell) {
  for (const { widget, dom } of rendered.widgets) widget.destroy(dom);
  rendered.widgets.length = 0;
}

/**
 * Mark decorations for find hits, with CodeMirror's own search classes so the
 * theme (and its "All" toggle) styles them as in the note.
 */
function searchMarks(matches: readonly CellMatch[]): DecorationSet {
  return Decoration.set(
    matches.map((m) =>
      Decoration.mark({
        class: m.current ? "cm-searchMatch cm-searchMatch-selected" : "cm-searchMatch",
      }).range(m.from, m.to),
    ),
    true,
  );
}

/** Line decorations carry this side value; it is how one is told apart from
 *  the widget and replace points that arrive through the same callback. */
const LINE_DECORATION_SIDE = Decoration.line({}).startSide;

function isLineDecoration(deco: Decoration): boolean {
  return deco.startSide === LINE_DECORATION_SIDE && deco.spec?.widget == null;
}

/** Class on each line element inside a painted cell (styled in
 *  visual-theme.ts). */
const CELL_LINE_CLASS = "cm-typst-cell-line";

/**
 * Builds a cell's content a line at a time, so each source line has its own box
 * for line styling (list indents) and breaks where the source does.
 */
class CellLines {
  private line: HTMLElement;

  constructor(private readonly container: HTMLElement, from: number) {
    this.line = this.startLine(from);
  }

  /** Append text, starting a new line element at every line break. */
  appendText(text: string, from: number, marks: readonly Decoration[]) {
    let start = 0;
    for (;;) {
      const br = text.indexOf("\n", start);
      const chunk = br < 0 ? text.slice(start) : text.slice(start, br);
      if (chunk) this.line.appendChild(runSpan(chunk, from + start, marks));
      if (br < 0) return;
      start = br + 1;
      this.line = this.startLine(from + start);
    }
  }

  /** Append a widget's DOM to the line being built. */
  appendElement(element: HTMLElement) {
    this.line.appendChild(element);
  }

  /** Apply a line decoration to the line being built. */
  decorateLine(deco: Decoration) {
    const classes = deco.spec?.class ? [deco.spec.class as string] : [];
    const attrs = deco.spec?.attributes as Record<string, string> | undefined;
    for (const [name, value] of Object.entries(attrs ?? {})) {
      if (name === "class") classes.push(value);
      else this.line.setAttribute(name, value);
    }
    for (const cls of classes) this.line.classList.add(cls);
  }

  private startLine(from: number): HTMLElement {
    const line = document.createElement("div");
    line.className = CELL_LINE_CLASS;
    // A click landing on the line but not on any of its text (past the end of
    // a short line, or on an empty one) resolves to the line's own start.
    line.dataset.from = String(from);
    this.container.appendChild(line);
    return line;
  }
}

function runSpan(text: string, from: number, marks: readonly Decoration[]): HTMLElement {
  const span = document.createElement("span");
  span.dataset.from = String(from);
  const classes: string[] = [];
  for (const mark of marks) {
    if (mark.spec.class) classes.push(mark.spec.class);
    const attrs = mark.spec.attributes as Record<string, string> | undefined;
    if (attrs) {
      for (const [name, value] of Object.entries(attrs)) {
        if (name === "class") classes.push(value);
        else span.setAttribute(name, value);
      }
    }
  }
  if (classes.length) span.className = classes.join(" ");
  span.textContent = text;
  return span;
}

/**
 * The source offset under a point in an idle cell, or null if not over its
 * text. A point over a widget maps to its start.
 */
export function sourcePosAt(container: HTMLElement, x: number, y: number): number | null {
  const doc = container.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) ({ offsetNode: node, offset } = p);
  } else if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || !container.contains(node)) return null;
  const element = node instanceof Element ? node : node.parentElement;
  const host = element?.closest<HTMLElement>("[data-from]");
  if (!host || !container.contains(host)) return null;
  const from = Number(host.dataset.from);
  if (host.dataset.to !== undefined) return from;
  return node.nodeType === Node.TEXT_NODE && node.parentNode === host ? from + offset : from;
}
