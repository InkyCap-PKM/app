import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type EditorState, Facet, type Range } from "@codemirror/state";

export type FocusMode = "none" | "line" | "section";

export const focusModeFacet = Facet.define<FocusMode, FocusMode>({
  combine: (values) => values[values.length - 1] ?? "none",
});

export const focusDimFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[values.length - 1] ?? false,
});

const focusHighlight = Decoration.line({ class: "cm-focus-highlight" });
const focusDimLine = Decoration.line({ class: "cm-focus-dim" });

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

function buildFocusDecorations(view: EditorView): DecorationSet {
  const mode = view.state.facet(focusModeFacet);
  const dim = view.state.facet(focusDimFacet);

  if (mode === "none" && !dim) return Decoration.none;

  const focusedLines = new Set<number>();

  if (mode !== "none") {
    for (const r of view.state.selection.ranges) {
      const startLine = view.state.doc.lineAt(r.from).number;
      const endLine = view.state.doc.lineAt(r.to).number;

      if (mode === "line") {
        for (let n = startLine; n <= endLine; n++) {
          focusedLines.add(n);
        }
      } else {
        for (let n = startLine; n <= endLine; n++) {
          const [secStart, secEnd] = findSectionRange(view.state, n);
          for (let s = secStart; s <= secEnd; s++) {
            focusedLines.add(s);
          }
        }
      }
    }
  }

  const decos: Range<Decoration>[] = [];

  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const isFocused = focusedLines.has(i);

    if (mode !== "none" && isFocused) {
      decos.push(focusHighlight.range(line.from));
    }

    if (dim && !isFocused && mode !== "none") {
      decos.push(focusDimLine.range(line.from));
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

export function focusModeExtension(mode: FocusMode, dim: boolean) {
  return [
    focusModeFacet.of(mode),
    focusDimFacet.of(dim),
    focusModePlugin,
    focusModeTheme,
  ];
}
