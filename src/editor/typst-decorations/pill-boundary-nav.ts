// Arrow-key navigation across inline pill content boundaries.
//
// Inline content-bracket pills (`#highlight[…]`, `#strike[…]`, `#emph[…]`,
// `#strong[…]`, `#underline[…]`, `#overline[…]`, `#sub[…]`, `#super[…]`, and
// the inline `#quote[…]`) hide their wrapping markup (`#highlight[` … `]`) in
// the visual editor. Plain CodeMirror cursor motion steps through those hidden
// characters one position at a time, so crossing into a pill's content takes
// several presses with no visible movement — it feels like the arrow key is
// stuck. And once the cursor is inside a highlighted run, there's no obvious
// signal for how to step back out without overshooting.
//
// This module makes the boundary deliberate and legible:
//   • ENTERING — at the call's outer edge, one press jumps the whole hidden
//     opener/closer straight to the content edge (no more per-character
//     stepping), with a brief pulse on the content so the move registers.
//   • EXITING — at a content edge, the first press is absorbed and pulses the
//     region ("you're at the edge — press again to leave"); a second press in
//     the same direction crosses out. This keeps the writer from accidentally
//     typing outside a highlight they meant to stay in.
//
//   • LANDING — motion that arrives from outside a block element (callout,
//     block quote) puts the caret in its body rather than on the hidden
//     markup that draws its frame, which paints in the same place.
//
// Scope: inline content-bracket pills, plus the one block-element rule above.
// Block elements otherwise manage their own editing affordances.

import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate, keymap } from "@codemirror/view";
import { EditorState, Prec, StateField, StateEffect, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { BlockBodyElementWidget } from "./widgets";

/** Pills whose `[…]` body is live-editable text behind hidden markup — inline
 *  content-bracket pills plus the block forms (callout, block quote) which, in
 *  editing mode, present the same from/content/closing-bracket boundary shape. */
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

/** Inner range of the body content bracket — the `[…]` after the call's
 *  argument list `(…)`. Skipping the args (quote- and depth-aware) means a
 *  bracket-form named argument like `attribution: [Smith]` isn't mistaken for
 *  the body; for inline pills with no args it simply finds the first `[`. */
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
 * If `pos` sits on a boundary of an inline content-bracket pill — its outer
 * edge (`from`/`to`) or a content edge (`contentFrom`/`contentTo`) — return
 * that pill's region. Resolves from both sides so a cursor exactly at a
 * boundary (which belongs to two nodes) is recognised either way.
 */
function inlinePillRegionAt(state: EditorState, pos: number): PillRegion | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side);
    while (node) {
      if (node.name === "FuncCall") {
        const text = state.doc.sliceString(node.from, node.to);
        const fn = callFuncName(text);
        // Block callout/quote present the same boundary shape in editing mode
        // (pill · body · hidden `]`); when the cursor sits on a boundary the
        // element is necessarily in editing mode (the cursor is on its line),
        // so the body is editable text and the same crossing logic applies.
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
 * The block element covering `pos`, read from what is actually drawn.
 *
 * While the caret is elsewhere a block element is one replaced range holding a
 * `BlockBodyElementWidget`, so any element built that way is recognised here —
 * no list of function names, and no dependence on the syntax tree, whose
 * FuncCall nodes stop short on a call that spans lines or contains another
 * call. The body is located by matching the element's own content brackets in
 * the source it covers, so it is right for a one-line quote and for a callout
 * with several paragraphs and links inside it alike.
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
 * Cursor motion treats a rendered block as one unit, so arriving from outside
 * puts the caret at the call's outer edge — and skipping the block backwards
 * lands it at the very start, ahead of the whole `#callout("note")[` opener.
 * Nothing of that markup is drawn, so the caret looks like it is in the
 * block's text while typing writes outside the frame, which reads as the text
 * jumping to the beginning of the block. Landing in the body puts the caret
 * where it appears to be, and the body edge follows the direction of travel,
 * not whichever outer edge the motion picked: arriving from below or after the
 * block lands at the end of its text, from above or before it at the start.
 *
 * Leaving is left alone: a caret that was already inside the call may step onto
 * an outer edge, which is how the arrow handling above walks out of a block. A
 * click is not a step, so it lands in the body wherever the caret was before.
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

/** Clears a pulse once it has been seen, whoever set it — the arrow handling
 *  below or the caret-landing rule above. Keeping the timer here means setting
 *  a pulse is a plain effect anywhere, including from a transaction filter,
 *  which has no view to schedule on. */
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

  // A single press jumps the whole hidden markup, so crossing a pill boundary
  // is one deterministic step instead of several invisible ones — and the
  // pulse makes the region change obvious. (An earlier draft required a second
  // press to exit; the pulse turned out to make that ceremony unnecessary.)
  if (dir < 0) {
    if (head === region.to) { pulse(view, region, region.contentTo); return true; }   // enter from right
    if (head === region.contentFrom) { pulse(view, region, region.from); return true; } // exit left
  } else {
    if (head === region.from) { pulse(view, region, region.contentFrom); return true; } // enter from left
    if (head === region.contentTo) { pulse(view, region, region.to); return true; }   // exit right
  }
  return false; // not on a crossing boundary — let default motion run
}

/** Extension: pill-boundary arrow navigation + region pulse. Add to the
 *  visual-mode extension set. High precedence so it intercepts ArrowLeft/Right
 *  before the default cursor-motion commands, but it returns false (yielding to
 *  the default) whenever the cursor isn't on a pill boundary. */
export const pillBoundaryNav = [
  pulseField,
  pulseTimeout,
  Prec.high(keymap.of([
    { key: "ArrowLeft", run: (view) => handleArrow(view, -1) },
    { key: "ArrowRight", run: (view) => handleArrow(view, 1) },
  ])),
];
