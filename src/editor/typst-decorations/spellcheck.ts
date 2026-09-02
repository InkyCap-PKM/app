// Spell-check underlining for the Typst editor.
//
// Runs in both source and visual mode. The actual checking is delegated to a
// `SpellChecker` (Hunspell-backed) supplied through `spellCheckerFacet`; this
// module's job is to decide *what* to check and to draw the wavy underlines.
//
// The underlines are painted by a CodeMirror *layer* (absolutely positioned
// elements floating over the text) rather than by a mark decoration. A mark
// decoration would wrap each misspelled word in a <span>, which splits the
// line into separate inline boxes; the browser rounds each box's width, so the
// flagged word visibly nudges sideways the moment it is underlined. A layer
// never touches inline layout, so the text stays exactly where it was.
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
  EditorSelection,
  Facet,
  RangeSet,
  RangeValue,
  StateEffect,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  EditorView,
  type LayerMarker,
  layer,
  RectangleMarker,
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

// Forces a re-check without a doc/viewport/checker change — dispatched after
// "Ignore" so the just-ignored word's underline clears immediately.
const rebuildSpell = StateEffect.define<null>();

// Says "the flagged words changed, repaint the underlines" without asking for
// another check. Dispatched by the debounced re-check, which has already done
// the work by the time it fires.
const spellRedraw = StateEffect.define<null>();

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

/**
 * A flagged word. Carries no styling of its own: the set of these ranges is
 * only a position store (mapped through edits, queried by the context menu),
 * and the layer below turns it into squiggles.
 */
class Misspelling extends RangeValue {}
const misspelling = new Misspelling();

/** Sorted, non-overlapping ranges of the misspelled words in view. */
export type MisspellingSet = RangeSet<Misspelling>;

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

/** Push a range for every misspelled word in [from, to). */
function checkRange(
  state: EditorState,
  checker: SpellChecker,
  from: number,
  to: number,
  out: Range<Misspelling>[],
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
    out.push(misspelling.range(start, start + raw.length));
  }
}

function findMisspellings(view: EditorView): MisspellingSet {
  const checker = view.state.facet(spellCheckerFacet);
  if (!checker) return RangeSet.empty;

  const out: Range<Misspelling>[] = [];
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
  return RangeSet.of(out, true);
}

const spellcheckPlugin = ViewPlugin.fromClass(
  class {
    misspellings: MisspellingSet;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      this.misspellings = findMisspellings(view);
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
        this.misspellings = findMisspellings(update.view);
      } else if (update.docChanged) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.misspellings = findMisspellings(update.view);
          // We're outside the update loop here, so ask for a redraw cycle that
          // re-reads the freshly rebuilt ranges.
          update.view.dispatch({ effects: spellRedraw.of(null) });
        }, 300);
        // Map existing ranges through the edit so they track until the rebuild.
        this.misspellings = this.misspellings.map(update.changes);
      }
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

// ── Underline layer ─────────────────────────────────────────────────────────
// One absolutely-positioned element per flagged word (per visual line, when a
// word wraps), drawn on top of the text. Nothing here takes part in inline
// layout, so underlining a word never moves it.

/** Squiggle thickness and its gap below the glyphs, in CSS pixels. */
const WAVE_HEIGHT = 3;
const WAVE_GAP = 1;
/** Rough height of a line of text, as a multiple of its font size. */
const TEXT_HEIGHT_RATIO = 1.2;

/** Wavy squiggle, used as a mask so the colour stays a theme token. */
const WAVE_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' " +
  "width='6' height='3'%3E%3Cpath d='M0 2.5q1.5-2 3 0t3 0' fill='none' " +
  "stroke='%23000' stroke-width='1'/%3E%3C/svg%3E\")";

/** The rendered font size at `pos`, so the squiggle follows headings too. */
function fontSizeAt(view: EditorView, pos: number): number {
  const { node } = view.domAtPos(pos);
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  const size = parseFloat(window.getComputedStyle(el ?? view.contentDOM).fontSize);
  return size > 0 ? size : parseFloat(window.getComputedStyle(view.contentDOM).fontSize);
}

/**
 * Thin squiggle bars covering one flagged word, one per visual line, since a
 * word can wrap. `RectangleMarker.forRange` does the hard part (horizontal
 * extent, wrapping, right-to-left text); we keep its horizontal geometry and
 * replace the vertical box with a bar sitting just under the glyphs. Its boxes
 * are as tall as the line, which with generous line spacing leaves the text
 * centred inside them, so the glyph bottom is the box centre plus half the
 * text's own height.
 */
function underlineMarkers(view: EditorView, from: number, to: number): LayerMarker[] {
  const fontSize = fontSizeAt(view, from);
  const boxes = RectangleMarker.forRange(
    view,
    "cm-spell-underline",
    EditorSelection.range(from, to),
  );
  return boxes.map((box) => {
    const textHeight = Math.min(box.height, fontSize * TEXT_HEIGHT_RATIO);
    const top = box.top + box.height / 2 + textHeight / 2 + WAVE_GAP;
    return new RectangleMarker("cm-spell-underline", box.left, top, box.width, WAVE_HEIGHT);
  });
}

const spellUnderlineLayer = layer({
  above: true,
  class: "cm-spell-layer",
  // Text-layout changes (typing, scrolling, decorations appearing) already
  // re-measure the layer on their own; this only catches the flagged words
  // changing on their own.
  update: (update) =>
    update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(rebuildSpell) || e.is(spellRedraw)),
    ),
  markers: (view) => {
    const flagged = view.plugin(spellcheckPlugin)?.misspellings;
    if (!flagged) return [];
    const markers: LayerMarker[] = [];
    for (const { from, to } of view.visibleRanges) {
      flagged.between(from, to, (wordFrom, wordTo) => {
        markers.push(...underlineMarkers(view, wordFrom, wordTo));
      });
    }
    return markers;
  },
});

const spellcheckTheme = EditorView.baseTheme({
  // The layer sits above the text, so it must not eat clicks meant for it.
  ".cm-spell-layer": {
    pointerEvents: "none",
  },
  ".cm-spell-underline": {
    backgroundColor: "var(--accent-danger, #e06c75)",
    maskImage: WAVE_MASK,
    WebkitMaskImage: WAVE_MASK,
    maskRepeat: "repeat-x",
    WebkitMaskRepeat: "repeat-x",
    maskPosition: "left bottom",
    WebkitMaskPosition: "left bottom",
    maskSize: `6px ${WAVE_HEIGHT}px`,
    WebkitMaskSize: `6px ${WAVE_HEIGHT}px`,
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
    const flagged = view.plugin(spellcheckPlugin)?.misspellings;
    if (!flagged) return false;
    let hit: { from: number; to: number } | null = null;
    flagged.between(pos, pos, (from, to) => {
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
  spellUnderlineLayer,
  spellcheckTheme,
  spellContextMenu,
];
