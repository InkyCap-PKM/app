import { Prec, StateField, type Extension } from "@codemirror/state";
import { defineLanguageFacet, language, Language, LanguageSupport } from "@codemirror/language";
import { TypstParser, typstHighlight } from "codemirror-lang-typst";

const typstLanguageFacet = defineLanguageFacet({ commentTokens: { block: { open: "/*", close: "*/" } } });

// Replacement for codemirror-lang-typst's built-in updateListener. The stock
// implementation calls `parser.parser.edit(...)` per change and then either
// nulls `last_tree` (full_update) or mutates it in-place via `applyTreeEdit`.
// On undo/redo of a slash-command insertion (e.g. `/strikethrough` ⇄
// `#strike[]`), the WASM parser returns incremental edits whose result mutates
// `last_tree` into a shape that doesn't match the post-history document — so
// `syntaxTree(state)` returns nodes with stale offsets, and the visual
// decorator falls back to raw source until a mode toggle forces a fresh parse.
//
// The same staleness shows up for any transaction that bundles multiple
// disjoint changes — alt-up/down line move (delete one line, insert another),
// find-replace-all, multi-cursor edits, and the inverse undo of any of those.
// In the visual editor, the symptom is bullets / list markers / pills appearing
// at wrong source positions after the operation.
//
// This version keeps WASM in sync (still calls `parser.parser.edit(...)` for
// every change, in order — that contract is non-negotiable) but discards the
// incremental tree edits and clears the cached tree whenever the transaction
// is an undo/redo OR contains more than one disjoint change region. The next
// `parser.tree()` call then re-fetches from the WASM parser, which has tracked
// the doc correctly via the edit() calls.
//
// Pairs with the `Prec.high` wrapper below: this state field must run before
// `@codemirror/language`'s `Language.state` so that, when LanguageState.apply
// asks for `parser.tree()`, the cache is already cleared.
// Characters whose insertion/deletion can open or close a parse region much
// larger than the edit itself: raw/inline-code fences (`` ` ``), math (`$`),
// and the bracket/brace/paren delimiters of content blocks, code, and function
// calls. A single-character edit to one of these forces a full reparse (see
// the call site) because the incremental parser doesn't reliably restructure
// the affected region — most visibly when re-closing an unterminated fence.
const STRUCTURAL_DELIMITER = /[`$()[\]{}]/;

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

      // First pass — decide whether we must full-clear, WITHOUT touching the
      // WASM parser. A multi-region transaction (alt-up/down move,
      // find-replace-all, multi-cursor) or any line-spanning change leaves the
      // incremental tree mismatched against the post-doc; for those we drop the
      // parser's state and reparse from scratch (clearParser). Critically, when
      // we're going to clearParser() anyway we must NOT call edit() first: a
      // full-document / multi-region replace (e.g. inserting a scaffold, which
      // replaces 0..len) makes the incremental edit() panic inside the WASM
      // parser ("unreachable" / "recursive use of an object … unsafe
      // aliasing"), poisoning it for every subsequent edit. clearParser()
      // reparses from the live doc, so those edit() calls are pointless as well
      // as dangerous.
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
        // Editing a structural delimiter — a raw-block / inline-code backtick,
        // a math `$`, or a bracket/brace/paren — can open or close a region
        // that spans far beyond the edit. Closing a previously-unterminated
        // code fence, for instance, must turn a Raw node that swallowed the
        // rest of the document back into normal markup. The WASM parser's
        // *incremental* tree edit doesn't restructure that reliably: the fence
        // stays "open", everything below stays raw red source, and wikilinks
        // there die — and don't come back when the user re-adds the backtick.
        // A from-scratch reparse (clearParser, below) always recovers, so we
        // treat any delimiter edit like a multi-region change.
        if (STRUCTURAL_DELIMITER.test(removed) || STRUCTURAL_DELIMITER.test(ins)) {
          structural = true;
        }
      });

      if (isHistory || changeCount > 1 || crossesLine || structural) {
        wasm.clearParser();
        return null;
      }

      // Incremental path: a single, in-line (no-newline) change — the normal
      // typing case the WASM parser handles reliably. Keep it in sync via
      // edit() and apply the returned tree edits.
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
