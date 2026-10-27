import { Prec, StateField, type Extension } from "@codemirror/state";
import { defineLanguageFacet, language, Language, LanguageSupport } from "@codemirror/language";
import { TypstParser, typstHighlight } from "codemirror-lang-typst";

const typstLanguageFacet = defineLanguageFacet({ commentTokens: { block: { open: "/*", close: "*/" } } });

// Characters whose insertion or deletion can open or close a region much
// larger than the edit: backticks, `$`, and the bracket, brace and paren
// delimiters. Editing one forces a full reparse (see below), since the
// incremental parser doesn't reliably restructure such regions.
const STRUCTURAL_DELIMITER = /[`$()[\]{}]/;

// Replaces codemirror-lang-typst's updateListener. The stock one applies the
// WASM parser's incremental tree edits, which after an undo or redo, or a
// transaction with several separate changes (line moves, replace all, multiple
// cursors), can leave the cached tree out of step with the document:
// `syntaxTree(state)` then has stale offsets, and the visual editor shows raw
// source or places bullets and pills wrongly.
//
// This version still calls `parser.parser.edit(...)` for every change, in order
// (required to keep WASM in step), but drops the incremental edits and clears
// the cached tree for undo/redo and multi-region changes, so the next
// `parser.tree()` comes fresh from the parser. It runs at `Prec.high` (below),
// before `@codemirror/language`'s `Language.state` asks for `parser.tree()`.
function typstUpdateListenerForcingFreshParseOnHistory(parser: TypstParser): Extension {
  const wasm = parser as unknown as {
    parser: { edit(from: number, to: number, text: string): { full_update?: boolean; edits?: unknown[] } } | null;
    clearTree(): void;
    clearParser(): void;
    applyTreeEdit(edit: unknown): void;
  };
  return StateField.define<null>({
    create() { return null; },
    update(_, tr) {
      if (tr.startState.facet(language) !== tr.state.facet(language)) {
        wasm.clearParser();
        return null;
      }
      if (!tr.docChanged) return null;

      const isHistory = tr.isUserEvent("undo") || tr.isUserEvent("redo");

      // First, decide whether to clear everything, without touching the WASM
      // parser. Multi-region and line-spanning changes leave the incremental
      // tree mismatched, so they reparse from scratch (`clearParser`). In that
      // case `edit()` must not be called first: for a whole-document or
      // multi-region replace (e.g. inserting a scaffold) it panics inside the
      // WASM parser and breaks every later edit.
      let changeCount = 0;
      let crossesLine = false;
      let structural = false;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changeCount++;
        const removed = tr.startState.doc.sliceString(fromA, toA);
        const ins = inserted.toString();
        if (removed.includes("\n") || ins.includes("\n")) {
          crossesLine = true;
        }
        // Editing a backtick, `$` or bracket can open or close a region far
        // beyond the edit: closing an unterminated code fence must turn the Raw
        // node that swallowed the rest of the document back into markup. The
        // incremental edit doesn't do this reliably (the fence stays open and
        // wikilinks below stay dead), so treat it like a multi-region change.
        if (STRUCTURAL_DELIMITER.test(removed) || STRUCTURAL_DELIMITER.test(ins)) {
          structural = true;
        }
      });

      if (isHistory || changeCount > 1 || crossesLine || structural) {
        wasm.clearParser();
        return null;
      }

      // Incremental path: one change within a line, the normal typing case,
      // which the parser handles well.
      const collected: unknown[] = [];
      let needsFullClear = false;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const result = wasm.parser?.edit(fromA, toA, inserted.toString());
        if (!result) return;
        if (result.full_update) {
          needsFullClear = true;
        } else if (!needsFullClear && result.edits) {
          for (const e of result.edits) collected.push(e);
        }
      });

      if (needsFullClear) {
        wasm.clearParser();
      } else {
        for (const e of collected) wasm.applyTreeEdit(e);
      }
      return null;
    },
  });
}

/** The Typst language for CodeMirror: the WASM parser plus the update
 *  listener above that keeps it in step with the document. */
export function typstLanguage(): Extension {
  // The TypstParser constructor accepts a NodePropSource at runtime but
  // the package's type declarations omit the parameter.
  const parser = new (TypstParser as unknown as new (h: typeof typstHighlight) => TypstParser)(typstHighlight);
  const support = new LanguageSupport(
    new Language(typstLanguageFacet, parser, [], "typst"),
  );
  return [Prec.high(typstUpdateListenerForcingFreshParseOnHistory(parser)), support];
}
