import { EditorView } from "@codemirror/view";
import { type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { openLink } from "../../lib/open-link";
import { modifierKey } from "../../lib/platform";

/** Extract the first quoted string argument from a Typst function call text. */
function extractFirstStringArg(text: string): string | null {
  const m = text.match(/\(\s*"([^"]*)"/) ?? text.match(/\(\s*'([^']*)'/);
  return m ? m[1] : null;
}

/**
 * Resolve a link at the given cursor position by walking the syntax tree.
 * Returns `{ url }` for bare `https://…` links and `#link("…")` calls.
 */
export function findLinkAtPos(state: EditorState, pos: number): { url: string } | null {
  let cur = syntaxTree(state).resolveInner(pos, 0);
  while (cur) {
    if (cur.name === "Link") {
      const text = state.doc.sliceString(cur.from, cur.to);
      if (/^https?:\/\//.test(text)) return { url: text };
    }
    if (cur.name === "FuncCall") {
      const funcFrom = (cur.from > 0 && state.doc.sliceString(cur.from - 1, cur.from) === "#")
        ? cur.from - 1 : cur.from;
      const text = state.doc.sliceString(funcFrom, cur.to);
      const hashOffset = text.startsWith("#") ? 1 : 0;
      const nameEnd = text.indexOf("(", hashOffset);
      if (nameEnd >= 0) {
        const funcName = text.substring(hashOffset, nameEnd).trim();
        if (funcName === "link") {
          const url = extractFirstStringArg(text);
          if (url) return { url };
        }
      }
    }
    if (!cur.parent) break;
    cur = cur.parent;
  }
  return null;
}

/** Ctrl/Cmd+Click to open links, with hover cursor feedback. */
export const linkClickHandler = EditorView.domEventHandlers({
  click(event: MouseEvent, view: EditorView) {
    if (!event.ctrlKey && !event.metaKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const link = findLinkAtPos(view.state, pos);
    if (!link) return false;
    void openLink(link.url);
    event.preventDefault();
    return true;
  },
  mousemove(event: MouseEvent, view: EditorView) {
    const hasModifier = event.ctrlKey || event.metaKey;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) {
      view.contentDOM.classList.remove("cm-link-hover");
      return false;
    }
    const link = hasModifier ? findLinkAtPos(view.state, pos) : null;
    if (link) {
      view.contentDOM.classList.add("cm-link-hover");
      const el = event.target as HTMLElement;
      el.title = `${modifierKey()}+Click to follow link`;
    } else {
      view.contentDOM.classList.remove("cm-link-hover");
    }
    return false;
  },
  keyup(event: KeyboardEvent, view: EditorView) {
    if (event.key === "Control" || event.key === "Meta") {
      view.contentDOM.classList.remove("cm-link-hover");
    }
    return false;
  },
});
