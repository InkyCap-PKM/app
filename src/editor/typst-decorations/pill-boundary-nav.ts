// Arrow keys across the edges of inline pills.
//
// Inline content-bracket pills (`#highlight[…]`, `#strike[…]`, `#emph[…]`,
// `#strong[…]`, `#underline[…]`, `#overline[…]`, `#sub[…]`, `#super[…]`, inline
// `#quote[…]`) hide their markup in the visual editor. Plain cursor motion
// would step through the hidden characters one at a time with nothing visibly
// moving. Here:
//   • entering: one press at the call's outer edge jumps to the content edge, with a brief pulse on the content;
//   • leaving: one press at a content edge jumps out the same way;
//   • landing: motion from outside a block element (callout, block quote) puts the caret in its body, not on its hidden markup.
// Block elements otherwise handle their own editing.

import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate, keymap } from "@codemirror/view";
import { EditorState, Prec, StateField, StateEffect, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { BlockBodyElementWidget } from "./widgets";

/**
 * Functions whose `[…]` body is editable text behind hidden markup: the inline
 * pills plus the block forms (callout, block quote), which have the same
 * boundaries while editing.
 */
const PILL_FUNCS = new Set([
  "strike", "highlight", "emph", "strong",
  "underline", "overline", "sub", "super", "quote", "callout",
]);

interface PillRegion {
  /** Start of the `#func` call. */ from: number;
  /** End of the call (after the closing `]`). */ to: number;
  /** First position inside the `[…]` body. */ contentFrom: number;
  /** Position of the closing `]` (end of body content). */ contentTo: number;
}

function callFuncName(text: string): string | null {
  const m = text.match(/^#?([A-Za-z][\w-]*)/);
  return m ? m[1] : null;
}

/**
 * Inner range of the `[…]` body after the argument list, so a bracket argument
 * like `attribution: [Smith]` isn't taken for the body.
 */
function contentBracketRange(text: string, base: number): { from: number; to: number } | null {
  let scanFrom = 0;
  const lp = text.indexOf("(");
  if (lp >= 0) {
    let depth = 0;
    let inStr = false;
    for (let i = lp; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
      else if (!inStr && ch === "(") depth++;
      else if (!inStr && ch === ")") { depth--; if (depth === 0) { scanFrom = i + 1; break; } }
    }
  }
  const open = text.indexOf("[", scanFrom);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return { from: base + open + 1, to: base + i };
    }
  }
  return null;
}

/**
 * If `pos` is on an inline pill's outer or content edge, that pill's region.
 * Checks both sides, since a boundary belongs to two nodes.
 */
function inlinePillRegionAt(state: EditorState, pos: number): PillRegion | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side);
    while (node) {
      if (node.name === "FuncCall") {
        const text = state.doc.sliceString(node.from, node.to);
        const fn = callFuncName(text);
        // A block callout or quote has the same boundaries while editing, and a
        // cursor on one means it is being edited.
        if (fn && PILL_FUNCS.has(fn)) {
          const content = contentBracketRange(text, node.from);
          if (content
              && (pos === node.from || pos === node.to
                  || pos === content.from || pos === content.to)) {
            return { from: node.from, to: node.to, contentFrom: content.from, contentTo: content.to };
          }
        }
      }
      if (!node.parent) break;
      node = node.parent;
    }
  }
  return null;
}

// ── Landing inside a block element ──────────────────────────────────

/**
 * The block element covering `pos`, from what is drawn: a replaced range
 * holding a `BlockBodyElementWidget`. No function list and no syntax tree
 * (whose nodes stop short on multi-line calls). The body is found by matching
 * the element's own content brackets in its source.
 */
function blockElementRegionAt(
  state: EditorState,
  decos: DecorationSet | undefined,
  pos: number,
): PillRegion | null {
  if (!decos) return null;
  let region: PillRegion | null = null;
  decos.between(pos, pos, (from, to, value) => {
    if (region) return false;
    if (!(value.spec?.widget instanceof BlockBodyElementWidget)) return;
    // Whole lines of their own: that is what makes the outer edges the only
    // places motion can put the caret, and the markup invisible on screen.
    if (from !== state.doc.lineAt(from).from || to !== state.doc.lineAt(to).to) return;
    const content = contentBracketRange(state.doc.sliceString(from, to), from);
    if (!content) return;
    region = { from, to, contentFrom: content.from, contentTo: content.to };
    return false;
  });
  return region;
}

function cameFromInside(head: number, region: PillRegion): boolean {
  return head >= region.from && head <= region.to;
}

/**
 * Coming from outside, the caret lands in the block's body rather than on its
 * hidden markup.
 *
 * Cursor motion treats a rendered block as one unit, so arriving puts the caret
 * at the call's outer edge, ahead of the hidden `#callout("note")[` when moving
 * backwards. It would look as if it were in the text while typing went outside
 * the frame. Landing in the body puts it where it appears, at the end of the
 * text when arriving from below or after, at the start from above or before.
 *
 * Leaving isn't changed: a caret inside may step to an outer edge, which is how
 * the arrow handling walks out. A click lands in the body too.
 */
export function createBlockBodyCaretEntry(decoField: StateField<DecorationSet>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.selection || tr.docChanged) return tr;
    const sel = tr.newSelection.main;
    if (!sel.empty) return tr;
    const region = blockElementRegionAt(tr.startState, tr.startState.field(decoField, false), sel.head);
    if (!region) return tr;
    const pointer = tr.isUserEvent("select.pointer");
    const cameFrom = tr.startState.selection.main.head;
    if (!pointer && cameFromInside(cameFrom, region)) return tr;
    if (sel.head > region.contentFrom && sel.head < region.contentTo) return tr;
    const target = (pointer ? sel.head > region.contentTo : cameFrom > region.to)
      ? region.contentTo
      : region.contentFrom;
    if (target === sel.head) return tr;
    // Same pulse the arrow handling gives a crossing, so entering a block reads
    // the same as entering a pill.
    return [tr, {
      selection: { anchor: target },
      effects: setPulse.of({ from: region.contentFrom, to: region.contentTo }),
    }];
  });
}

// ── Region pulse ────────────────────────────────────────────────────
const setPulse = StateEffect.define<{ from: number; to: number }>();
const clearPulse = StateEffect.define<null>();

const pulseField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPulse)) {
        value = e.value.from < e.value.to
          ? Decoration.set([Decoration.mark({ class: "cm-typst-pill-pulse" }).range(e.value.from, e.value.to)])
          : Decoration.none;
      } else if (e.is(clearPulse)) {
        value = Decoration.none;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const PULSE_MS = 500;

/**
 * Clears a pulse after it has shown, whoever set it, so setting one is a plain
 * effect, even from a transaction filter.
 */
const pulseTimeout = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    update(update: ViewUpdate) {
      // Only a fresh pulse starts the clock. Other updates while one shows —
      // the keystrokes that follow entering a pill — leave it to run out.
      const started = update.transactions.some((tr) => tr.effects.some((e) => e.is(setPulse)));
      if (!started) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (update.view.dom.isConnected && update.view.state.field(pulseField).size > 0) {
          update.view.dispatch({ effects: clearPulse.of(null) });
        }
      }, PULSE_MS);
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

/** Pulse a content range, pairing the move (if any) into one transaction. */
function pulse(view: EditorView, region: PillRegion, selection?: number): void {
  view.dispatch({
    ...(selection !== undefined ? { selection: { anchor: selection }, scrollIntoView: true } : {}),
    effects: setPulse.of({ from: region.contentFrom, to: region.contentTo }),
  });
}

function handleArrow(view: EditorView, dir: -1 | 1): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false; // selection extension uses default behaviour
  const head = sel.head;
  const region = inlinePillRegionAt(view.state, head);
  if (!region) return false;

  // One press jumps all the hidden markup, and the pulse shows the change.
  if (dir < 0) {
    if (head === region.to) { pulse(view, region, region.contentTo); return true; }   // enter from right
    if (head === region.contentFrom) { pulse(view, region, region.from); return true; } // exit left
  } else {
    if (head === region.from) { pulse(view, region, region.contentFrom); return true; } // enter from left
    if (head === region.contentTo) { pulse(view, region, region.to); return true; }   // exit right
  }
  return false; // not on a crossing boundary — let default motion run
}

/**
 * Pill-edge arrow navigation and pulse, for the visual mode extensions. High
 * precedence to run before the default motion; returns false when the cursor
 * isn't on a pill edge.
 */
export const pillBoundaryNav = [
  pulseField,
  pulseTimeout,
  Prec.high(keymap.of([
    { key: "ArrowLeft", run: (view) => handleArrow(view, -1) },
    { key: "ArrowRight", run: (view) => handleArrow(view, 1) },
  ])),
];
