// Spell-check underlines for the Typst editor, in source and visual mode.
// Checking is done by a Hunspell-backed `SpellChecker` from
// `spellCheckerFacet`; this module decides what to check and draws the
// underlines.
//
// The underlines are a CodeMirror layer (positioned elements over the text),
// not mark decorations: wrapping a word in a `<span>` splits the line into
// boxes whose widths the browser rounds, so the word would shift when
// underlined.
//
// Only prose is checked, found by walking the lezer-typst tree:
//   • `Text` leaves: ordinary prose, headings, and prose in content brackets (`#callout(..)[prose]`, `#quote[prose]`, …);
//   • `Str` literals inside `#verse("…")` only, since verse text is a string argument. Other strings (paths, link targets, URLs) aren't checked.
// Subtrees without prose (raw and code, math, comments, labels, refs, links,
// imports) are skipped.

import { syntaxTree } from "@codemirror/language";
import { t } from "../../lib/i18n";
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
  Direction,
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

// Words ignored this session, without changing any dictionary. Cleared on
// restart.
const ignoredWords = new Set<string>();

// Forces a re-check without a doc/viewport/checker change — dispatched after
// "Ignore" so the just-ignored word's underline clears immediately.
const rebuildSpell = StateEffect.define<null>();

// Repaint the underlines because the flagged words changed, without checking
// again. Sent by the debounced re-check after it has run.
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
 * A flagged word. Only a position store (mapped through edits, used by the
 * context menu); the layer below draws it.
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
    // Trim trailing apostrophes and hyphens, and use the straight apostrophe
    // the dictionaries store ("don't", "l'eau").
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
    /**
     * The part of the scroller, in scroll coordinates, the layer last covered.
     * Null before the first draw and after a redraw is requested.
     */
    drawnBand: { top: number; bottom: number } | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly onScroll: () => void;

    constructor(readonly view: EditorView) {
      this.misspellings = findMisspellings(view);
      // CodeMirror counts a long wrapped line as visible even when only part of
      // it is, so scrolling within it never redraws by itself. Request a redraw
      // when scrolling past the drawn part.
      this.onScroll = () => {
        const band = this.drawnBand;
        if (!band) return;
        const { scrollTop, clientHeight } = view.scrollDOM;
        if (scrollTop < band.top || scrollTop + clientHeight > band.bottom) {
          this.drawnBand = null;
          view.dispatch({ effects: spellRedraw.of(null) });
        }
      };
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
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
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    }
  },
);

// ── Underline layer ─────────────────────────────────────────────────────────
// One positioned element per flagged word (per visual line if it wraps), drawn
// over the text, outside inline layout.

/** Squiggle thickness and its gap below the glyphs, in CSS pixels. */
const WAVE_HEIGHT = 3;
const WAVE_GAP = 1;
/** Rough height of a line of text, as a multiple of its font size. */
const TEXT_HEIGHT_RATIO = 1.2;
/**
 * How far beyond the screen to draw, as a share of its height. Kept small
 * because each squiggle is costly; scrolling past it redraws.
 */
const UNDERLINE_MARGIN_SCREENS = 0.25;

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
 * The point layer coordinates are measured from, computed as
 * `RectangleMarker.forRange` does internally (not exported).
 */
function layerOrigin(view: EditorView): { left: number; top: number } {
  const scroller = view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  const left =
    view.textDirection === Direction.LTR
      ? rect.left
      : rect.right - scroller.clientWidth * view.scaleX;
  return {
    left: left - scroller.scrollLeft * view.scaleX,
    top: rect.top - scroller.scrollTop * view.scaleY,
  };
}

/** A squiggle bar sitting just under the glyphs of a box of text. */
function squiggleUnder(
  box: { left: number; top: number; width: number | null; height: number },
  fontSize: number,
): RectangleMarker {
  // With generous line spacing the text sits centred in its box, so the
  // glyph bottom is the box centre plus half the text's own height.
  const textHeight = Math.min(box.height, fontSize * TEXT_HEIGHT_RATIO);
  const top = box.top + box.height / 2 + textHeight / 2 + WAVE_GAP;
  return new RectangleMarker("cm-spell-underline", box.left, top, box.width, WAVE_HEIGHT);
}

/**
 * Squiggles for one flagged word. A word on one visual line is placed from its
 * first and last characters; `RectangleMarker.forRange` handles wrapping but
 * costs about 25 times as much, which adds up to seconds with hundreds of
 * flagged words, so it is only used for words that wrap.
 */
function underlineMarkers(
  view: EditorView,
  origin: { left: number; top: number },
  from: number,
  to: number,
): LayerMarker[] {
  const fontSize = fontSizeAt(view, from);
  const start = view.coordsAtPos(from, 1);
  const end = view.coordsAtPos(to, -1);
  if (start && end && end.top < start.bottom && start.top < end.bottom) {
    // Right-to-left text puts the start on the right, hence min and max.
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.left, end.left);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    return [
      squiggleUnder(
        { left: left - origin.left, top: top - origin.top, width: right - left, height: bottom - top },
        fontSize,
      ),
    ];
  }
  return RectangleMarker.forRange(view, "cm-spell-underline", EditorSelection.range(from, to)).map(
    (box) => squiggleUnder(box, fontSize),
  );
}

/**
 * The part of the document to underline: the screen plus a margin, so small
 * scrolls find the squiggles drawn. Also recorded on the plugin, so scrolling
 * past it requests a redraw.
 */
function underlineWindow(
  view: EditorView,
  plugin: { drawnBand: { top: number; bottom: number } | null },
): { from: number; to: number } {
  const scroller = view.scrollDOM;
  const { scrollTop, clientHeight } = scroller;
  const band = clientHeight * UNDERLINE_MARGIN_SCREENS;
  plugin.drawnBand = { top: scrollTop - band, bottom: scrollTop + clientHeight + band };

  const screen = scroller.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  const margin = screen.height * UNDERLINE_MARGIN_SCREENS;
  const top = Math.max(screen.top - margin, content.top);
  const bottom = Math.min(screen.bottom + margin, content.bottom);
  if (bottom <= top) return { from: 0, to: 0 };
  // Probing both edges of the text column covers right-to-left lines,
  // whose visual start is on the right.
  const xs = [content.left + 1, content.right - 1];
  const tops = xs.map((x) => view.posAtCoords({ x, y: top + 1 }, false));
  const bottoms = xs.map((x) => view.posAtCoords({ x, y: bottom - 1 }, false));
  return { from: Math.min(...tops), to: Math.max(...bottoms) };
}

const spellUnderlineLayer = layer({
  above: true,
  class: "cm-spell-layer",
  // Layout changes already re-measure the layer; this catches the flagged words
  // changing.
  update: (update) =>
    update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(rebuildSpell) || e.is(spellRedraw)),
    ),
  markers: (view) => {
    const plugin = view.plugin(spellcheckPlugin);
    if (!plugin) return [];
    const area = underlineWindow(view, plugin);
    const origin = layerOrigin(view);
    const markers: LayerMarker[] = [];
    for (const { from, to } of view.visibleRanges) {
      plugin.misspellings.between(
        Math.max(from, area.from),
        Math.min(to, area.to),
        (wordFrom, wordTo) => {
          markers.push(...underlineMarkers(view, origin, wordFrom, wordTo));
        },
      );
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
    backgroundColor: "var(--accent-danger)",
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
// Selecting a word would bring up the format toolbar, so the menu doesn't
// select the misspelling: it finds the underlined word under the pointer and
// replaces it directly. A plain DOM menu with the shared `.context-menu`
// styles, since it comes from a DOM event.

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
  // Keyboard activation arrives as a click with no mousedown (lib/menu-nav.ts).
  // `detail === 0` marks a synthesized click, so a real click doesn't run the
  // action twice.
  btn.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
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
    none.textContent = t("spellcheck.noSuggestions");
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
    menuButton(t("spellcheck.addToDictionary"), () => {
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
