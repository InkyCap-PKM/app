// Visual-mode heading fold — adds a caret to the left of each heading
// that lets the user collapse/expand the section beneath it. This is
// purely visual: the Typst source is never modified. Folded lines get
// `display: none` via a line decoration.
//
// Headings come from the shared, parser-backed scan in heading-scan.ts. That
// matters here beyond a stray caret: a false heading — `= Not a headliner`
// written inside a ``` fence — also *ends* the section above it, so folding
// the real heading stopped at the fence and left the rest of the section on
// screen (issue #21).

import {
  StateField,
  StateEffect,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { scanHeadings } from "./heading-scan";

// Lucide ChevronRight / ChevronDown SVG (matches OutlinePanel's caret icons).
const CHEVRON_SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" '
  + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const CHEVRON_RIGHT_SVG =
  `<svg ${CHEVRON_SVG_ATTRS}><polyline points="9 18 15 12 9 6"/></svg>`;
const CHEVRON_DOWN_SVG =
  `<svg ${CHEVRON_SVG_ATTRS}><polyline points="6 9 12 15 18 9"/></svg>`;

interface HeadingInfo {
  level: number;
  /** Start of the heading's line — the fold's identity and caret anchor. */
  lineFrom: number;
  /** 1-based line number, for walking the lines a fold hides. */
  lineNumber: number;
}

// Every heading the scan reports opens its own line, which is what lets a fold
// work in whole lines.
function findHeadings(view: EditorView): HeadingInfo[] {
  const doc = view.state.doc;
  return scanHeadings(view.state).map((h) => {
    const line = doc.lineAt(h.from);
    return { level: h.level, lineFrom: line.from, lineNumber: line.number };
  });
}

// -- Effects & State --

export const toggleHeadingFold = StateEffect.define<{ pos: number }>();

const foldedHeadings = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    let changed = false;
    let next = value;
    for (const e of tr.effects) {
      if (e.is(toggleHeadingFold)) {
        if (!changed) {
          next = new Set(value);
          changed = true;
        }
        if (next.has(e.value.pos)) next.delete(e.value.pos);
        else next.add(e.value.pos);
      }
    }
    if (!tr.docChanged) return next;
    const remapped = new Set<number>();
    for (const pos of next) {
      const mapped = tr.changes.mapPos(pos, 1);
      remapped.add(mapped);
    }
    return remapped;
  },
});

// -- Fold caret widget --

class FoldCaretWidget extends WidgetType {
  constructor(
    readonly collapsed: boolean,
    readonly pos: number
  ) {
    super();
  }

  eq(other: FoldCaretWidget) {
    return this.collapsed === other.collapsed && this.pos === other.pos;
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = "cm-heading-fold-caret"
      + (this.collapsed ? " cm-heading-fold-caret--collapsed" : "");
    // Match the lucide ChevronRight / ChevronDown used in the Outline panel so
    // the two surfaces feel like the same control.
    span.innerHTML = this.collapsed ? CHEVRON_RIGHT_SVG : CHEVRON_DOWN_SVG;
    span.setAttribute("role", "button");
    span.setAttribute(
      "aria-label",
      this.collapsed ? "Expand section" : "Collapse section"
    );
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ effects: toggleHeadingFold.of({ pos: this.pos }) });
    });
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

// -- Decoration builder --

const headingLineDeco = Decoration.line({ class: "cm-heading-fold-line" });
const hiddenLineDeco = Decoration.line({ class: "cm-heading-folded-line" });

function buildDecorations(view: EditorView): DecorationSet {
  const headings = findHeadings(view);
  const folded = view.state.field(foldedHeadings);
  const doc = view.state.doc;

  // We collect ranges into an array and let Decoration.set sort them. Using
  // RangeSetBuilder here breaks once a folded heading contains nested
  // headings: the inner loop adds hidden-line decorations at positions PAST
  // the nested heading's line, then the outer loop tries to add the nested
  // heading's caret at an earlier position — which violates the builder's
  // strictly non-decreasing `from` requirement and throws, wiping out every
  // caret on the page until the next rebuild.
  const ranges: Range<Decoration>[] = [];
  // Use a Set so overlapping fold ranges (parent + nested folded heading)
  // don't add duplicate hidden-line decorations at the same position.
  const hiddenLineStarts = new Set<number>();

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];

    ranges.push(headingLineDeco.range(h.lineFrom));
    ranges.push(
      Decoration.widget({
        widget: new FoldCaretWidget(folded.has(h.lineFrom), h.lineFrom),
        side: -1,
      }).range(h.lineFrom)
    );

    if (!folded.has(h.lineFrom)) continue;

    // Hide lines from after heading to the next heading of equal/higher level
    const nextSibling = headings.findIndex(
      (other, j) => j > i && other.level <= h.level
    );
    const hideFrom = h.lineNumber + 1;
    const hideTo =
      nextSibling >= 0 ? headings[nextSibling].lineNumber - 1 : doc.lines;

    for (let ln = hideFrom; ln <= hideTo; ln++) {
      const lineFrom = doc.line(ln).from;
      if (hiddenLineStarts.has(lineFrom)) continue;
      hiddenLineStarts.add(lineFrom);
      ranges.push(hiddenLineDeco.range(lineFrom));
    }
  }

  return Decoration.set(ranges, true);
}

// -- Plugin --

const foldDecoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        // A reparse can change the heading list on its own — closing a code
        // fence turns everything below it back into markup.
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.state.field(foldedHeadings) !==
          update.startState.field(foldedHeadings)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// -- Theme --

const foldTheme = EditorView.theme({
  ".cm-heading-fold-line": {
    position: "relative",
  },
  ".cm-heading-fold-caret": {
    position: "absolute",
    // Sit in the gutter to the left of the heading text. The element is
    // intentionally oversized vs. the 12×12 SVG so the click target is easy
    // to hit — the icon is centered inside via flex.
    left: "-28px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "24px",
    height: "24px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--fg-muted)",
    cursor: "pointer",
    userSelect: "none",
    opacity: "0",
    transition: "opacity 0.12s ease-in-out, background 0.12s ease-in-out, color 0.12s ease-in-out",
    borderRadius: "50%",
    zIndex: "1",
  },
  ".cm-heading-fold-line:hover .cm-heading-fold-caret, .cm-heading-fold-caret:focus-visible": {
    opacity: "1",
  },
  ".cm-heading-fold-caret--collapsed": {
    opacity: "1",
  },
  ".cm-heading-fold-caret:hover": {
    opacity: "1",
    color: "var(--fg-primary)",
    background: "var(--bg-hover)",
  },
  ".cm-heading-fold-caret svg": {
    display: "block",
    pointerEvents: "none",
  },
  ".cm-heading-folded-line": {
    display: "none !important",
  },
});

export function headingFold(): Extension {
  return [foldedHeadings, foldDecoPlugin, foldTheme];
}
