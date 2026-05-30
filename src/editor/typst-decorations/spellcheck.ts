// Spell-check underlining for the Typst editor.
//
// Runs in both source and visual mode. The actual checking is delegated to a
// `SpellChecker` (Hunspell-backed) supplied through `spellCheckerFacet`; this
// module's job is to decide *what* to check and to draw the wavy underlines.
//
// Typst-awareness is the point: we only check prose, never markup or code. We
// walk the lezer-typst syntax tree and collect text from:
//   • `Text` leaves — ordinary markup prose, including headings and the prose
//     inside content brackets (`#callout(..)[prose]`, `#quote[prose]`, …).
//   • `Str` literals *only when inside a `#verse("…")` call* — verse content is
//     a string argument, not a Text leaf, so it would otherwise be skipped; the
//     user explicitly wants verse checked. (Other string args — image paths,
//     wikilink targets, link URLs — are deliberately left unchecked.)
// Whole subtrees that never contain prose (raw/code blocks, math, comments,
// labels, refs, links, imports) are skipped outright.

import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  Facet,
  StateEffect,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SpellChecker } from "../../lib/spellchecker";
import * as ipc from "../../lib/ipc";

/** The active checker, or null to disable. Last value wins. */
export const spellCheckerFacet = Facet.define<SpellChecker | null, SpellChecker | null>({
  combine: (values) => (values.length ? values[values.length - 1] : null),
});

// Words the user chose to "Ignore" this session — skipped by the checker
// without touching any dictionary. Session-scoped and global (cleared on app
// restart); a deliberate, lightweight middle ground between a one-off fix and a
// permanent dictionary add.
const ignoredWords = new Set<string>();

// Forces a decoration rebuild without a doc/viewport/checker change — dispatched
// after "Ignore" so the just-ignored word's underline clears immediately.
const rebuildSpell = StateEffect.define<null>();

// Subtrees that never hold prose — skip them (and their descendants) entirely.
const SKIP_SUBTREE = new Set([
  "Raw",
  "RawDelim",
  "RawTrimmed",
  "RawLang",
  "Math",
  "Equation",
  "LineComment",
  "BlockComment",
  "Label",
  "Ref",
  "Link",
  "Import",
  "ImportItems",
  "ImportItemPath",
]);

const spellMark = Decoration.mark({ class: "cm-spell-error" });

// A word: a letter followed by letters / combining marks / intra-word
// apostrophes and hyphens. Unicode-aware so accented Latin, CJK, etc. tokenize.
const WORD_RE = /\p{L}[\p{L}\p{M}’'-]*/gu;

/** True when `node`'s nearest enclosing function call is `#verse(...)`. */
function isInVerseCall(state: EditorState, node: SyntaxNode): boolean {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.name === "FuncCall") {
      const callee = cur.firstChild;
      return (
        !!callee && state.doc.sliceString(callee.from, callee.to) === "verse"
      );
    }
    cur = cur.parent;
  }
  return false;
}

/** Push spell-error marks for every misspelled word in [from, to). */
function checkRange(
  state: EditorState,
  checker: SpellChecker,
  from: number,
  to: number,
  out: Range<Decoration>[],
) {
  const text = state.doc.sliceString(from, to);
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    // Trim trailing apostrophes/hyphens (e.g. a possessive's quote) and
    // normalize the typographic apostrophe to the straight one the
    // dictionaries store ("don't", "l'eau").
    const raw = m[0].replace(/[’'-]+$/, "");
    if (raw.length < 2) continue;
    const word = raw.replace(/’/g, "'");
    if (ignoredWords.has(word.toLowerCase())) continue;
    if (checker.correct(word)) continue;
    const start = from + m.index;
    out.push(spellMark.range(start, start + raw.length));
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const checker = view.state.facet(spellCheckerFacet);
  if (!checker) return Decoration.none;

  const out: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  // Only the visible ranges — checking the whole document on every keystroke
  // doesn't scale, and off-screen underlines aren't visible anyway.
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (SKIP_SUBTREE.has(node.name)) return false;
        if (node.name === "Text") {
          checkRange(view.state, checker, node.from, node.to, out);
          return false;
        }
        if (node.name === "Str") {
          if (isInVerseCall(view.state, node.node)) {
            // Strip the surrounding quotes.
            checkRange(view.state, checker, node.from + 1, node.to - 1, out);
          }
          return false;
        }
        return undefined;
      },
    });
  }
  out.sort((a, b) => a.from - b.from);
  return Decoration.set(out, true);
}

const spellcheckPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      const checkerChanged =
        update.startState.facet(spellCheckerFacet) !==
        update.state.facet(spellCheckerFacet);
      const forced = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(rebuildSpell)),
      );
      // Viewport / checker / forced changes rebuild immediately; typing debounces
      // so we aren't re-checking a half-typed word on every keystroke.
      if (update.viewportChanged || checkerChanged || forced) {
        this.decorations = buildDecorations(update.view);
      } else if (update.docChanged) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.decorations = buildDecorations(update.view);
          // Empty dispatch to trigger a redraw cycle that re-reads the freshly
          // rebuilt decorations (we're outside the update loop here).
          update.view.dispatch({});
        }, 300);
        // Map existing marks through the edit so they track until the rebuild.
        this.decorations = this.decorations.map(update.changes);
      }
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

const spellcheckTheme = EditorView.baseTheme({
  ".cm-spell-error": {
    textDecoration: "underline wavy var(--accent-danger, #e06c75)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "2px",
  },
});

// ── Right-click menu ────────────────────────────────────────────────────────
// Selecting a word triggers InkyCap's format toolbar, so the spellcheck menu
// must NOT select the misspelling — it finds the underlined word under the
// pointer, replaces it directly on a pick (no selection created), and never
// summons the toolbar. Built as a plain DOM menu (styled with the shared
// `.context-menu` tokens) because it's driven by a DOM event, not Solid state.

let spellMenuEl: HTMLElement | null = null;
let dismissSpellMenu: (() => void) | null = null;

function closeSpellMenu() {
  if (dismissSpellMenu) {
    dismissSpellMenu();
    dismissSpellMenu = null;
  }
  spellMenuEl?.remove();
  spellMenuEl = null;
}

function menuButton(label: string, onClick: () => void, opts?: { muted?: boolean }): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "context-menu__item";
  if (opts?.muted) btn.style.color = "var(--fg-dim)";
  btn.textContent = label;
  // mousedown (not click) so the action runs before the document mousedown
  // dismiss handler tears the menu down.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeSpellMenu();
    onClick();
  });
  return btn;
}

function showSpellMenu(
  view: EditorView,
  range: { from: number; to: number },
  word: string,
  checker: SpellChecker,
  x: number,
  y: number,
) {
  closeSpellMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.position = "fixed";

  const suggestions = checker.suggest(word);
  if (suggestions.length === 0) {
    const none = document.createElement("span");
    none.className = "context-menu__hint";
    none.textContent = "No suggestions";
    menu.appendChild(none);
  } else {
    for (const s of suggestions) {
      menu.appendChild(
        menuButton(s, () => {
          // Replace the word in place — no selection, so the format toolbar
          // never fires. Cursor lands after the replacement.
          view.dispatch({ changes: { from: range.from, to: range.to, insert: s } });
          view.focus();
        }),
      );
    }
  }

  const sep = document.createElement("div");
  sep.className = "context-menu__separator";
  menu.appendChild(sep);

  menu.appendChild(
    menuButton("Add to dictionary", () => {
      void ipc
        .addUserDictionaryWord(word)
        .then(() => {
          // Shared dictionary — rebuild the checker (and Mycelial picks it up).
          document.dispatchEvent(new CustomEvent("inkycap:dictionary-changed"));
        })
        .catch(() => {
          /* swallow — adding to the dictionary is best-effort */
        });
    }),
  );
  menu.appendChild(
    menuButton(
      "Ignore",
      () => {
        ignoredWords.add(word.toLowerCase());
        view.dispatch({ effects: rebuildSpell.of(null) });
      },
      { muted: true },
    ),
  );

  document.body.appendChild(menu);
  spellMenuEl = menu;

  // Clamp into the viewport once measured.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  const onDocDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeSpellMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeSpellMenu();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", closeSpellMenu, true);
  }, 0);
  dismissSpellMenu = () => {
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", closeSpellMenu, true);
  };
}

const spellContextMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const checker = view.state.facet(spellCheckerFacet);
    if (!checker) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    // Only intercept when the click is actually on an underlined misspelling —
    // otherwise let the native menu (cut/copy/paste) through.
    const deco = view.plugin(spellcheckPlugin)?.decorations;
    if (!deco) return false;
    let hit: { from: number; to: number } | null = null;
    deco.between(pos, pos, (from, to) => {
      hit = { from, to };
      return false;
    });
    if (!hit) return false;
    event.preventDefault();
    const found: { from: number; to: number } = hit;
    const word = view.state.doc
      .sliceString(found.from, found.to)
      .replace(/’/g, "'");
    showSpellMenu(view, found, word, checker, event.clientX, event.clientY);
    return true;
  },
});

/** The spell-check extension. Pair with `spellCheckerFacet.of(checker)`. */
export const spellcheck: Extension = [
  spellcheckPlugin,
  spellcheckTheme,
  spellContextMenu,
];
