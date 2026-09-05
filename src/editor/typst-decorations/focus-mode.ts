import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type EditorState, Facet, type Range } from "@codemirror/state";

export type FocusMode = "none" | "line" | "section";

/** How much of the document counts as "focused" around the caret. */
export type FocusScope = "line" | "section";

/** Scope used when dimming is on but focus mode is off. Dimming stands on its
 *  own, so it still needs to know what to leave clear. A paragraph is the
 *  forgiving choice: with `line`, a hard-wrapped note would dim the rest of
 *  the sentence the writer is in the middle of. */
const DIM_ONLY_SCOPE: FocusScope = "section";

export const focusModeFacet = Facet.define<FocusMode, FocusMode>({
  combine: (values) => values[values.length - 1] ?? "none",
});

export const focusDimFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[values.length - 1] ?? false,
});

const focusHighlight = Decoration.line({ class: "cm-focus-highlight" });
const focusDimLine = Decoration.line({ class: "cm-focus-dim" });

/** The scope the two settings resolve to, or null when neither asks for
 *  anything. Focus mode picks the scope when it is on; otherwise dimming
 *  falls back to its own. */
export function resolveFocusScope(mode: FocusMode, dim: boolean): FocusScope | null {
  if (mode !== "none") return mode;
  return dim ? DIM_ONLY_SCOPE : null;
}

/** The run of non-empty lines around `lineNum`, i.e. its paragraph. */
function findSectionRange(state: EditorState, lineNum: number): [number, number] {
  let start = lineNum;
  let end = lineNum;
  while (start > 1) {
    const prev = state.doc.line(start - 1);
    if (prev.text.trim() === "") break;
    start--;
  }
  while (end < state.doc.lines) {
    const next = state.doc.line(end + 1);
    if (next.text.trim() === "") break;
    end++;
  }
  return [start, end];
}

/** Line numbers that count as focused: the lines each selection range touches,
 *  grown to whole paragraphs under the `section` scope. */
export function focusedLineNumbers(state: EditorState, scope: FocusScope): Set<number> {
  const focused = new Set<number>();
  for (const r of state.selection.ranges) {
    const startLine = state.doc.lineAt(r.from).number;
    const endLine = state.doc.lineAt(r.to).number;
    for (let n = startLine; n <= endLine; n++) {
      if (scope === "line") {
        focused.add(n);
        continue;
      }
      const [secStart, secEnd] = findSectionRange(state, n);
      for (let s = secStart; s <= secEnd; s++) focused.add(s);
    }
  }
  return focused;
}

function buildFocusDecorations(view: EditorView): DecorationSet {
  const mode = view.state.facet(focusModeFacet);
  const dim = view.state.facet(focusDimFacet);
  const scope = resolveFocusScope(mode, dim);
  if (!scope) return Decoration.none;

  const focused = focusedLineNumbers(view.state, scope);
  const decos: Range<Decoration>[] = [];

  // Only the lines on screen need decorating, and they are rebuilt whenever the
  // viewport moves. A note of several thousand lines would otherwise be walked
  // in full on every caret move, which is the hot path these settings sit in.
  let lastLine = 0;
  for (const range of view.visibleRanges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let n = Math.max(first, lastLine + 1); n <= last; n++) {
      const line = view.state.doc.line(n);
      if (focused.has(n)) {
        // The highlight belongs to focus mode; dimming alone leaves the
        // focused area looking ordinary rather than tinting it.
        if (mode !== "none") decos.push(focusHighlight.range(line.from));
      } else if (dim) {
        decos.push(focusDimLine.range(line.from));
      }
      lastLine = n;
    }
  }

  return Decoration.set(decos, true);
}

const focusModePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFocusDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.selectionSet ||
        update.docChanged ||
        update.viewportChanged ||
        update.startState.facet(focusModeFacet) !== update.state.facet(focusModeFacet) ||
        update.startState.facet(focusDimFacet) !== update.state.facet(focusDimFacet)
      ) {
        this.decorations = buildFocusDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const focusModeTheme = EditorView.baseTheme({
  ".cm-focus-highlight": {
    backgroundColor: "color-mix(in srgb, var(--bg-hover) 60%, transparent)",
  },
  ".cm-focus-dim": {
    opacity: "0.4",
  },
});

/** Focus mode highlights the area around the caret; dimming fades everything
 *  else. Either can be used without the other — with focus mode off, dimming
 *  keeps the caret's paragraph clear. */
export function focusModeExtension(mode: FocusMode, dim: boolean) {
  return [
    focusModeFacet.of(mode),
    focusDimFacet.of(dim),
    focusModePlugin,
    focusModeTheme,
  ];
}
