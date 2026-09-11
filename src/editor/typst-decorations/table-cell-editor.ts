// Editing one table cell, and drawing the cells that are not being edited.
//
// An idle cell is painted from the note's own state: the inline-only visual
// decorations for the cell's source range, turned into plain DOM. The cell
// being edited hosts a small CodeMirror view over a mirrored copy of the
// note, with everything outside the cell hidden and locked (cell-scope.ts),
// so wikilinks, emphasis, the `/` palette, suggestions and spell-check all
// work inside a cell exactly as they do in the note body.
//
// Edits flow both ways. A change made in the cell editor is re-dispatched to
// the note; a change made in the note (undo, an edit elsewhere) is mirrored
// into the cell editor. Both directions carry the `cellSync` annotation so a
// change is never echoed back. The note stays the single source of truth —
// the cell editor never holds text the note does not.

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
import { parseClipboardAsGrid } from "./table-parser";

/** Marks a transaction that mirrors a change already made in the other editor. */
export const cellSync = Annotation.define<boolean>();

/**
 * What a cell editor needs from the note editor. Provided as a facet by the
 * editor setup so this module stays free of the editor's own dependencies.
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
  arrow(direction: "up" | "down"): void;
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
 * Keeps edits and the selection inside the editable range. A change that
 * reaches outside it is dropped; a selection that lands outside it is
 * clamped. Mirrored changes from the note are exempt — they are the truth.
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

/** True when the caret sits on the cell's first (`up`) or last (`down`) line,
 *  so a vertical arrow should leave the cell rather than move within it. */
function onEdgeLine(view: EditorView, direction: "up" | "down"): boolean {
  const scope = view.state.field(scopeRangeField);
  if (!scope) return true;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const edge = view.state.doc.lineAt(direction === "up" ? scope.from : scope.to);
  return line.number === edge.number;
}

function cellKeymap(main: EditorView, nav: CellNavigation): Extension {
  return Prec.highest(keymap.of([
    { key: "Tab", run: () => (nav.tab(false), true), shift: () => (nav.tab(true), true) },
    { key: "Enter", run: () => (nav.enter(), true) },
    { key: "Escape", run: () => (nav.escape(), true) },
    { key: "ArrowUp", run: (view) => (onEdgeLine(view, "up") ? (nav.arrow("up"), true) : false) },
    { key: "ArrowDown", run: (view) => (onEdgeLine(view, "down") ? (nav.arrow("down"), true) : false) },
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
 * The cell editor sits inside a table cell: no chrome, no padding, no
 * centred column, and the cell's own font and line height. The note's theme
 * rules also match this nested editor (it is a descendant of the note's
 * editor), so these carry a class of their own for specificity and the
 * highest precedence for order.
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
 * The CodeMirror view editing one cell. Create it when a cell becomes
 * active, mount it in that cell, and destroy it when the cell is left.
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

  /** Whether this editor's content is the document's active element. Keyed
   *  on the active element rather than `hasFocus`, which also asks whether
   *  the window itself is focused. */
  get hasFocus(): boolean {
    return this.view.dom.ownerDocument.activeElement === this.view.contentDOM;
  }

  /**
   * Give the editor focus and put the browser's selection where the state
   * says. Focusing alone is not enough: WebKit puts the caret at the start
   * of a freshly focused editable, and CodeMirror's cached DOM selection
   * (the same nodes, back in place) still matches the state, so it would
   * not rewrite it — and the next character would land at the start.
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
 * Paint a cell's source range as it looks in the visual editor: inline marks
 * become spans, inline widgets (wikilinks, links, pills) their own DOM, and
 * hidden markup is left out. Every text run carries `data-from`, the source
 * offset of its first character, so a click can be mapped back to a caret
 * position (see `sourcePosAt`).
 */
export function renderIdleCell(
  main: EditorView,
  container: HTMLElement,
  from: number,
  to: number,
  config: CellEditorConfig | null,
): RenderedCell {
  container.replaceChildren();
  const rendered: RenderedCell = { widgets: [] };
  const doc = main.state.doc;
  if (!config) {
    appendRun(container, doc.sliceString(from, to), from, []);
    return rendered;
  }
  const decos = config.inlineDecorations(main.state, from, to);
  RangeSet.spans([decos], from, to, {
    span(spanFrom, spanTo, active) {
      if (spanFrom === spanTo) return;
      appendRun(container, doc.sliceString(spanFrom, spanTo), spanFrom, active);
    },
    point(pointFrom, pointTo, deco) {
      const widget = deco.spec?.widget as WidgetType | undefined;
      if (!widget) return;
      const dom = widget.toDOM(main);
      dom.dataset.from = String(pointFrom);
      dom.dataset.to = String(pointTo);
      container.appendChild(dom);
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

function appendRun(container: HTMLElement, text: string, from: number, marks: readonly Decoration[]) {
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
  container.appendChild(span);
}

/**
 * The source offset under a point in an idle cell, or null when the point
 * is not over the cell's text. A point over a widget maps to its start.
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
