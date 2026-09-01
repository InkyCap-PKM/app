// Outliner folding for the Typst editor: collapse a heading's section or a
// list item's nested subtree.
//
// This is built on CodeMirror's real fold engine (`codeFolding()` +
// `foldService` + `foldEffect`/`unfoldEffect`), not a bespoke line-hider. That
// buys three things the earlier heading-only line-hider could not:
//   • Fold state is a normal StateField, so it survives switching editor modes
//     (this extension lives in the always-on base config, not the visual-mode
//     compartment) and maps correctly through edits — including a subtree move,
//     which keeps its fold instead of half-unfolding.
//   • One fold service folds both headings and list items.
//   • The standard fold keyboard shortcuts (foldKeymap) work for free.
//
// The control the user clicks is a hover chevron to the left of the foldable
// line, matching the Outline panel's caret icons — deliberately not the
// standard left-hand fold gutter, whose permanent column of arrows reads as a
// code editor rather than a writing surface.
//
// What counts as foldable, and the range each fold covers:
//   • Heading: from the end of the heading line to the end of its section (the
//     line before the next heading of equal or higher level). Headings come
//     from the parser-backed scan, so a `= …` inside a ``` fence is neither a
//     fold point nor a section boundary (issue #21).
//   • List item with nested content: from the end of the item's line to the end
//     of its indented subtree (see `listSubtreeEndLine`).

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
    // A zero-width inline anchor rides the item's first text row at its content
    // origin; the visible chevron is positioned absolutely to the left of that
    // origin, so it follows the item's indentation and never pushes the text or
    // fights the hanging bullet's own negative margin.
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
    // A foldable item hidden inside an ancestor's fold gets no chevron — it
    // isn't on screen, and its would-be chevron would otherwise be rendered
    // stranded at the ancestor's fold boundary.
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

// Positioning knobs (all scale with the line's font, so a big heading and a
// body-size bullet each get a proportionate chevron and gap):
//   CARET_GAP   — space between the chevron and the item's content.
//   CARET_RISE      — how far above the font's x-height centre a heading
//                     chevron sits, to land on the optical middle of tall caps.
//   CARET_RISE_LIST — the same for list items. Body-size text is already close
//                     to centred at the x-height, so it needs only a small
//                     rise; the larger heading rise would read high on a bullet.
//                 Raise a value to move that chevron up, lower it to move down.
// Heading chevrons sit CARET_GAP left of the text; list chevrons sit a further
// `--list-bullet-width` left to clear the hanging bullet (see
// .cm-typst-list-bullet in visual-theme.ts).
const CARET_GAP = "0.4em";
const CARET_RISE = "0.18em";
const CARET_RISE_LIST = "0.05em";

const foldTheme = EditorView.theme({
  // Zero-width inline anchor at the item's content origin. `vertical-align:
  // middle` puts its centre on the font's x-height; the chevron is centred in
  // it and then raised by CARET_RISE onto the optical middle of the text.
  ".cm-fold-caret-anchor": {
    display: "inline-block",
    width: "0",
    height: "1em",
    position: "relative",
    verticalAlign: "middle",
  },
  ".cm-fold-caret": {
    position: "absolute",
    // Right edge sits CARET_GAP to the left of the content origin (the anchor
    // is zero-width, so its right edge is the origin). A direct `right` offset
    // — not `right: 100%` plus a margin — avoids a subpixel reposition on
    // hover.
    right: CARET_GAP,
    top: "50%",
    transform: `translateY(calc(-50% - ${CARET_RISE}))`,
    width: "1em",
    height: "1em",
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
    right: `calc(var(--list-bullet-width, 1.5em) + ${CARET_GAP})`,
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
});

/**
 * Typst outliner folding: heading sections and nested list subtrees, driven by
 * CodeMirror's fold engine with a hover-chevron control. Belongs in the base
 * editor config (both modes) so folds persist across mode switches.
 */
export function typstFolding(): Extension {
  return [codeFolding(), typstFoldService, foldChevronPlugin, foldTheme];
}
