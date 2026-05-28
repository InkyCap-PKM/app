import {
  Decoration,
  type DecorationSet,
  EditorView,
} from "@codemirror/view";
import { type Extension, type Range, RangeSet, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// ── Block types ────────────────────────────────────────

type BlockKind = "section" | "element";

interface Block {
  kind: BlockKind;
  from: number;
  to: number;
  tag: string;
}

// ── Block boundary detection ───────────────────────────

const BLOCK_FUNC_NAMES = new Set([
  "callout", "quote", "verse", "table", "image", "annotation",
]);

function detectBlocks(state: EditorState): Block[] {
  const blocks: Block[] = [];
  const doc = state.doc;
  const docLen = doc.length;
  if (docLen === 0) return blocks;

  const headings: { pos: number; level: number }[] = [];
  const elements: Block[] = [];

  syntaxTree(state).iterate({
    from: 0,
    to: docLen,
    enter(node) {
      switch (node.name) {
        case "Heading": {
          const text = doc.sliceString(node.from, Math.min(node.from + 10, node.to));
          const m = text.match(/^(=+)/);
          if (m) {
            headings.push({ pos: node.from, level: Math.min(m[1].length, 6) });
          }
          return false;
        }
        case "FuncCall": {
          const callFrom = node.from;
          const hashFrom = callFrom > 0 && doc.sliceString(callFrom - 1, callFrom) === "#"
            ? callFrom - 1
            : callFrom;
          const snippet = doc.sliceString(hashFrom, Math.min(hashFrom + 30, node.to));
          const offset = snippet.startsWith("#") ? 1 : 0;
          const parenIdx = snippet.indexOf("(", offset);
          const bracketIdx = snippet.indexOf("[", offset);
          const delimIdx = (parenIdx >= 0 && bracketIdx >= 0)
            ? Math.min(parenIdx, bracketIdx)
            : (parenIdx >= 0 ? parenIdx : bracketIdx);
          if (delimIdx < 0) return false;
          const funcName = snippet.substring(offset, delimIdx).trim();
          if (BLOCK_FUNC_NAMES.has(funcName)) {
            elements.push({ kind: "element", from: hashFrom, to: node.to, tag: funcName });
          }
          return false;
        }
        case "Raw":
        case "RawBlock": {
          const text = doc.sliceString(node.from, Math.min(node.from + 5, node.to));
          if (text.startsWith("```")) {
            elements.push({ kind: "element", from: node.from, to: node.to, tag: "codeblock" });
          }
          return false;
        }
        case "Equation": {
          const text = doc.sliceString(node.from, Math.min(node.from + 2, node.to));
          if (text === "$ " || text === "$\n") {
            elements.push({ kind: "element", from: node.from, to: node.to, tag: "math" });
          }
          return false;
        }
      }
    },
  });

  headings.sort((a, b) => a.pos - b.pos);

  if (headings.length === 0) {
    blocks.push({ kind: "section", from: 0, to: docLen, tag: "doc" });
  } else {
    if (headings[0].pos > 0) {
      blocks.push({ kind: "section", from: 0, to: headings[0].pos, tag: "doc" });
    }
    for (let i = 0; i < headings.length; i++) {
      const end = i + 1 < headings.length ? headings[i + 1].pos : docLen;
      blocks.push({
        kind: "section",
        from: headings[i].pos,
        to: end,
        tag: `h${headings[i].level}`,
      });
    }
  }

  for (const el of elements) {
    blocks.push(el);
  }

  blocks.sort((a, b) => a.from - b.from || a.to - b.to);
  return blocks;
}

// ── Height tracking ────────────────────────────────────

const blockHeights = new Map<string, number>();

function blockKey(block: Block): string {
  return `${block.kind}:${block.from}`;
}

function recordBlockHeight(block: Block, height: number) {
  if (height > 0) {
    blockHeights.set(blockKey(block), height);
  }
}

function getCachedHeight(block: Block): number | null {
  return blockHeights.get(blockKey(block)) ?? null;
}

// ── StateField: computed block list ────────────────────

const blockField = StateField.define<Block[]>({
  create(state) {
    return detectBlocks(state);
  },
  update(blocks, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return detectBlocks(tr.state);
    }
    return blocks;
  },
});

// ── Layout stability decorations ───────────────────────

const blockStabilityField = StateField.define<DecorationSet>({
  create(state) {
    return buildStabilityDecos(state);
  },
  update(decos, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildStabilityDecos(tr.state);
    }
    return decos;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

function buildStabilityDecos(state: EditorState): DecorationSet {
  const blocks = state.field(blockField, false);
  if (!blocks) return Decoration.none;

  const decos: Range<Decoration>[] = [];
  for (const block of blocks) {
    if (block.kind !== "element") continue;
    const cached = getCachedHeight(block);
    if (!cached || cached <= 40) continue;
    if (block.from > state.doc.length) continue;
    const line = state.doc.lineAt(block.from);
    decos.push(
      Decoration.line({
        attributes: { style: `min-height: ${cached}px; overflow: hidden` },
      }).range(line.from),
    );
  }

  decos.sort((a, b) => a.from - b.from);
  return RangeSet.of(decos);
}

// ── Height observer ────────────────────────────────────

const heightObserver = EditorView.updateListener.of((update) => {
  if (!update.geometryChanged && !update.docChanged) return;
  const blocks = update.state.field(blockField, false);
  if (!blocks) return;

  for (const block of blocks) {
    if (block.kind !== "element") continue;
    if (block.from > update.state.doc.length) continue;
    try {
      const top = update.view.coordsAtPos(block.from);
      const bottom = update.view.coordsAtPos(Math.min(block.to, update.state.doc.length));
      if (top && bottom) {
        const height = bottom.bottom - top.top;
        if (height > 40) {
          recordBlockHeight(block, height);
        }
      }
    } catch {
      // coordsAtPos can throw for off-screen positions
    }
  }
});

// ── Public extension ───────────────────────────────────

export function blockLayer(): Extension {
  return [
    blockField,
    blockStabilityField,
    heightObserver,
  ];
}
