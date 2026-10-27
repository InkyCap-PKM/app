// Folding for the Typst editor: collapse a heading's section or a list item's
// nested items.
//
// Uses CodeMirror's fold engine (`codeFolding()`, `foldService`, `foldEffect` /
// `unfoldEffect`), so fold state survives mode switches (this is in the base
// config, not the visual compartment) and maps through edits, including subtree
// moves; one service handles headings and lists; and the standard fold
// shortcuts (foldKeymap) work.
//
// The control is a hover chevron left of the line, like the Outline panel's
// carets, rather than the fold gutter, whose column of arrows looks like a code
// editor.
//
// What folds:
//   • Heading: from the end of its line to the end of its section (before the next heading of the same or higher level). Headings come from the parser-backed scan, so a `= …` inside a code block counts for nothing (issue #21).
//   • List item with nested content: from the end of its line to the end of its subtree (see `listSubtreeEndLine`).

import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  codeFolding,
  foldService,
  foldEffect,
  unfoldEffect,
  foldedRanges,
  syntaxTree,
} from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { scanHeadings } from "./heading-scan";
import { scanListItems, listSubtreeEndLine } from "./list-scan";

// Lucide ChevronRight / ChevronDown SVG (matches OutlinePanel's caret icons).
const CHEVRON_SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" '
  + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const CHEVRON_RIGHT_SVG =
  `<svg ${CHEVRON_SVG_ATTRS}><polyline points="9 18 15 12 9 6"/></svg>`;
const CHEVRON_DOWN_SVG =
  `<svg ${CHEVRON_SVG_ATTRS}><polyline points="6 9 12 15 18 9"/></svg>`;

/** A place the reader can fold: the line the chevron sits on, and the document
 *  range that collapses when it's folded. */
interface FoldTarget {
  /** Start of the foldable line — the chevron anchor. */
  lineFrom: number;
  /** Start of the fold: end of the foldable line (its text stays visible). */
  foldFrom: number;
  /** End of the fold: end of the last line the fold hides. */
  foldTo: number;
  /** What opens here — a list item's chevron is offset further left to clear
   *  the hanging bullet. */
  kind: "heading" | "list";
}

/** Every foldable region in the document — headings and nested list items. */
function foldTargets(state: EditorState): FoldTarget[] {
  const doc = state.doc;
  const targets: FoldTarget[] = [];

  // Headings: fold to the line before the next heading of equal/higher level.
  const headings = scanHeadings(state).map((h) => {
    const line = doc.lineAt(h.from);
    return { level: h.level, lineNumber: line.number, lineFrom: line.from };
  });
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const nextSibling = headings.findIndex((o, j) => j > i && o.level <= h.level);
    const endLine = nextSibling >= 0 ? headings[nextSibling].lineNumber - 1 : doc.lines;
    if (endLine <= h.lineNumber) continue; // nothing below the heading to fold
    targets.push({
      lineFrom: h.lineFrom,
      foldFrom: doc.line(h.lineNumber).to,
      foldTo: doc.line(endLine).to,
      kind: "heading",
    });
  }

  // List items: fold the item's indented subtree. Leaf items (no children) are
  // skipped — there is nothing to collapse.
  for (const item of scanListItems(state)) {
    const endLine = listSubtreeEndLine(doc, item.lineNumber, item.indent);
    if (endLine <= item.lineNumber) continue;
    targets.push({
      lineFrom: item.lineFrom,
      foldFrom: item.lineTo,
      foldTo: doc.line(endLine).to,
      kind: "list",
    });
  }

  return targets;
}

/** The fold range for the region opening on the line at `lineStart`, or null.
 *  Drives both the `foldService` (keyboard shortcuts) and the chevron. */
export function typstFoldRange(state: EditorState, lineStart: number): { from: number; to: number } | null {
  for (const t of foldTargets(state)) {
    if (t.lineFrom === lineStart) return { from: t.foldFrom, to: t.foldTo };
  }
  return null;
}

const typstFoldService = foldService.of((state, lineStart) => typstFoldRange(state, lineStart));

// -- Fold caret widget --

/** Whether a fold currently starts at `foldFrom`, and the exact range if so
 *  (needed to unfold — `unfoldEffect` wants the range that was folded). */
function foldAt(state: EditorState, foldFrom: number): { from: number; to: number } | null {
  let hit: { from: number; to: number } | null = null;
  foldedRanges(state).between(foldFrom, foldFrom, (from, to) => {
    if (from === foldFrom) {
      hit = { from, to };
      return false;
    }
  });
  return hit;
}

function toggleFold(view: EditorView, foldFrom: number, foldTo: number): void {
  const existing = foldAt(view.state, foldFrom);
  view.dispatch({
    effects: existing ? unfoldEffect.of(existing) : foldEffect.of({ from: foldFrom, to: foldTo }),
  });
}

class FoldCaretWidget extends WidgetType {
  constructor(
    readonly collapsed: boolean,
    readonly foldFrom: number,
    readonly foldTo: number,
    readonly kind: "heading" | "list",
  ) {
    super();
  }

  eq(other: FoldCaretWidget) {
    return this.collapsed === other.collapsed
      && this.foldFrom === other.foldFrom
      && this.foldTo === other.foldTo
      && this.kind === other.kind;
  }

  toDOM(view: EditorView) {
    // A zero-width anchor on the item's first row at its content start; the
    // chevron is positioned to its left, so it follows the indent without
    // moving the text or clashing with the bullet's negative margin.
    const anchor = document.createElement("span");
    anchor.className = "cm-fold-caret-anchor";
    const icon = document.createElement("span");
    icon.className = "cm-fold-caret"
      + (this.collapsed ? " cm-fold-caret--collapsed" : "")
      + (this.kind === "list" ? " cm-fold-caret--list" : "");
    icon.innerHTML = this.collapsed ? CHEVRON_RIGHT_SVG : CHEVRON_DOWN_SVG;
    icon.setAttribute("role", "button");
    icon.setAttribute("aria-label", this.collapsed ? "Expand" : "Collapse");
    icon.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFold(view, this.foldFrom, this.foldTo);
    });
    anchor.appendChild(icon);
    return anchor;
  }

  ignoreEvent() {
    return false;
  }
}

// -- Decoration builder --

const foldLineDeco = Decoration.line({ class: "cm-fold-line" });

/** Whether `pos` sits inside a currently-folded (hidden) range, so a foldable
 *  line there should not draw a chevron of its own — the parent fold owns it. */
function insideFold(state: EditorState, pos: number): boolean {
  let inside = false;
  foldedRanges(state).between(pos, pos, (from, to) => {
    if (from < pos && pos <= to) {
      inside = true;
      return false;
    }
  });
  return inside;
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const t of foldTargets(view.state)) {
    // No chevron for an item inside a folded ancestor; it isn't on screen.
    if (insideFold(view.state, t.lineFrom)) continue;
    ranges.push(foldLineDeco.range(t.lineFrom));
    ranges.push(
      Decoration.widget({
        widget: new FoldCaretWidget(foldAt(view.state, t.foldFrom) !== null, t.foldFrom, t.foldTo, t.kind),
        side: -1,
      }).range(t.lineFrom),
    );
  }
  return Decoration.set(ranges, true);
}

/** Whether a transaction changed what is folded (a chevron may need to flip). */
function foldStateChanged(update: ViewUpdate): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
  );
}

const foldChevronPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged
        // A reparse can change the foldable set on its own — closing a code
        // fence turns everything below it back into headings/list items.
        || syntaxTree(update.state) !== syntaxTree(update.startState)
        || foldStateChanged(update)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// -- Theme --

// Positioning, all relative to the line's font so headings and list items get
// proportionate chevrons:
//   CARET_GAP       space between the chevron and the content.
//   CARET_RISE      how far above the x-height centre a heading chevron sits, to look centred on tall capitals.
//   CARET_RISE_LIST the same for list items, smaller since body text is nearly centred at the x-height.
//   CARET_SIZE      diameter of the round hover highlight, wider than the 1em chevron so it reads as a target.
//   CARET_INSET     half the difference; subtracted from the right offset so a bigger circle grows outward without moving the glyph. Keep it at (CARET_SIZE - 1em) / 2.
// List chevrons sit a further `--list-bullet-width` left to clear the bullet
// (see .cm-typst-list-bullet in visual-theme.ts).
const CARET_GAP = "0.4em";
const CARET_RISE = "0.18em";
const CARET_RISE_LIST = "0.05em";
const CARET_SIZE = "1.3em";
const CARET_INSET = "0.15em";

const foldTheme = EditorView.theme({
  // Zero-width anchor at the content start. `vertical-align: middle` centres it
  // on the x-height; the chevron is centred in it and raised by CARET_RISE.
  ".cm-fold-caret-anchor": {
    display: "inline-block",
    width: "0",
    height: "1em",
    position: "relative",
    verticalAlign: "middle",
  },
  ".cm-fold-caret": {
    position: "absolute",
    // A direct `right` offset rather than `right: 100%` plus a margin, which
    // shifted by a subpixel on hover.
    right: `calc(${CARET_GAP} - ${CARET_INSET})`,
    top: "50%",
    transform: `translateY(calc(-50% - ${CARET_RISE}))`,
    width: CARET_SIZE,
    height: CARET_SIZE,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--fg-muted)",
    background: "transparent",
    cursor: "pointer",
    userSelect: "none",
    opacity: "0",
    transition: "opacity 0.12s ease-in-out, background 0.12s ease-in-out, color 0.12s ease-in-out",
    borderRadius: "50%",
  },
  // List items: clear the hanging bullet, which occupies one bullet-width to
  // the left of the item text, and use the smaller body-text rise.
  ".cm-fold-caret--list": {
    right: `calc(var(--list-bullet-width, 1.5em) + ${CARET_GAP} - ${CARET_INSET})`,
    transform: `translateY(calc(-50% - ${CARET_RISE_LIST}))`,
  },
  ".cm-fold-line:hover .cm-fold-caret, .cm-fold-caret:focus-visible": {
    opacity: "1",
  },
  // A folded region keeps its chevron visible so the reader can see (and undo)
  // the fold without hovering.
  ".cm-fold-caret--collapsed": {
    opacity: "1",
  },
  ".cm-fold-caret:hover": {
    opacity: "1",
    color: "var(--fg-primary)",
    background: "var(--bg-hover)",
  },
  ".cm-fold-caret svg": {
    display: "block",
    width: "1em",
    height: "1em",
    pointerEvents: "none",
  },
  // The "…" chip left in place of a folded region. CodeMirror's base theme
  // gives it a pale grey that glares in dark mode; use app tokens.
  ".cm-foldPlaceholder": {
    background: "var(--bg-highlight)",
    border: "1px solid var(--border-input)",
    borderRadius: "var(--radius-sm)",
    color: "var(--fg-muted)",
    padding: "0 var(--space-3)",
    margin: "0 var(--space-2)",
  },
  ".cm-foldPlaceholder:hover": {
    background: "var(--bg-hover)",
    color: "var(--fg-primary)",
  },
});

/**
 * Folding of heading sections and nested lists, with a hover chevron. In the
 * base config, so folds survive mode switches.
 */
export function typstFolding(): Extension {
  return [codeFolding(), typstFoldService, foldChevronPlugin, foldTheme];
}
