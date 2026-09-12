import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { type EditorState, type Extension, Prec, RangeSet, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// Typst's parser is error-tolerant: a `$`, `(` or `[` that has no partner yet
// is reported as an error token, and the editor's highlight style paints
// error tokens red with a wavy underline. On the line the writer is typing
// on, that is noise rather than a signal, so this extension covers those
// tokens with a mark that cancels the error styling. Error tokens on other
// lines keep it, which is what tells a writer they left something unfinished.

const muted = Decoration.mark({ class: "cm-typst-caret-line-error" });

/** Error-token ranges on the lines that hold a selection end. */
export function caretLineErrorRanges(state: EditorState): { from: number; to: number }[] {
  const seen = new Set<number>();
  const out: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    for (const pos of [range.from, range.to]) {
      const line = state.doc.lineAt(pos);
      if (seen.has(line.number)) continue;
      seen.add(line.number);
      syntaxTree(state).iterate({
        from: line.from,
        to: line.to,
        enter(node) {
          // The Typst grammar names its error token `Error` rather than using
          // lezer's built-in error flag, so both are checked.
          if (!(node.type.isError || node.name === "Error") || node.from === node.to) return;
          if (node.from < line.from || node.to > line.to) return;
          out.push({ from: node.from, to: node.to });
        },
      });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

function build(state: EditorState): DecorationSet {
  return RangeSet.of(caretLineErrorRanges(state).map((r) => muted.range(r.from, r.to)));
}

const field = StateField.define<DecorationSet>({
  create: build,
  update(decos, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return build(tr.state);
    }
    return decos;
  },
});

/**
 * Mutes the highlighter's error styling on the caret's own lines. Lowest
 * precedence so the mark wraps the highlighter's span; see the matching rule
 * in visual-theme.ts.
 */
export function caretLineErrorMute(): Extension {
  return [field, Prec.lowest(EditorView.decorations.from(field))];
}
