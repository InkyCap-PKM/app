import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type ChangeSpec } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

interface ToolbarAction {
  label: string;
  icon: string;
  title: string;
  wrap: [string, string];
}

const ACTIONS: ToolbarAction[] = [
  { label: "B", icon: "B", title: "Bold (Ctrl+B)", wrap: ["*", "*"] },
  { label: "I", icon: "I", title: "Italic (Ctrl+I)", wrap: ["_", "_"] },
  { label: "S", icon: "S", title: "Strikethrough (Ctrl+Shift+X)", wrap: ["#strike[", "]"] },
  { label: "H", icon: "H", title: "Highlight (Ctrl+Shift+H)", wrap: ["#highlight[", "]"] },
  { label: "`", icon: "<>", title: "Inline code (Ctrl+E)", wrap: ["`", "`"] },
  { label: "$", icon: "∑", title: "Inline math (Ctrl+Shift+M)", wrap: ["$", "$"] },
];

let toolbar: HTMLElement | null = null;
let activeView: EditorView | null = null;

function getToolbar(): HTMLElement {
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.className = "selection-toolbar";
    toolbar.style.display = "none";

    for (const action of ACTIONS) {
      const btn = document.createElement("button");
      btn.className = "selection-toolbar__btn";
      btn.textContent = action.icon;
      btn.title = action.title;
      if (action.label === "B") btn.style.fontWeight = "bold";
      if (action.label === "I") btn.style.fontStyle = "italic";
      if (action.label === "S") btn.style.textDecoration = "line-through";

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!activeView) return;
        applyWrap(activeView, action.wrap[0], action.wrap[1]);
      });

      toolbar.appendChild(btn);
    }

    document.body.appendChild(toolbar);
  }
  return toolbar;
}

function hideToolbar() {
  const el = getToolbar();
  el.style.display = "none";
}

function isInsideRaw(view: EditorView, from: number, to: number): boolean {
  const tree = syntaxTree(view.state);
  let inside = false;
  tree.iterate({
    from, to,
    enter(node) {
      if (node.name === "Raw" || node.name === "RawBlock") {
        if (node.from <= from && node.to >= to) inside = true;
      }
    },
  });
  return inside;
}

function showToolbar(view: EditorView) {
  activeView = view;
  const { from, to } = view.state.selection.main;
  if (from === to) {
    hideToolbar();
    return;
  }

  if (isInsideRaw(view, from, to)) {
    hideToolbar();
    return;
  }

  const el = getToolbar();
  const startCoords = view.coordsAtPos(from);
  const endCoords = view.coordsAtPos(to);
  if (!startCoords || !endCoords) {
    hideToolbar();
    return;
  }

  const midX = (startCoords.left + endCoords.right) / 2;
  const top = startCoords.top;

  el.style.left = `${midX}px`;
  el.style.top = `${top - 40}px`;
  el.style.transform = "translateX(-50%)";
  el.style.display = "flex";
}

function applyWrap(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);

  if (
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    selected.length >= before.length + after.length
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from, to, insert: inner } as ChangeSpec,
      selection: { anchor: from, head: from + inner.length },
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: before + selected + after } as ChangeSpec,
      selection: { anchor: from + before.length, head: to + before.length },
    });
  }

  view.focus();
}

export const selectionToolbar = ViewPlugin.fromClass(
  class {
    private hideTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      this.checkSelection(view);
    }

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        this.checkSelection(update.view);
      }
    }

    checkSelection(view: EditorView) {
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }

      const { from, to } = view.state.selection.main;
      if (from === to) {
        this.hideTimeout = setTimeout(() => hideToolbar(), 100);
      } else {
        requestAnimationFrame(() => showToolbar(view));
      }
    }

    destroy() {
      hideToolbar();
      if (this.hideTimeout) clearTimeout(this.hideTimeout);
    }
  },
);
