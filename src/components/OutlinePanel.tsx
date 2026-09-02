// Outline panel: heading list for the active editor.
//
// Reads the heading signal published by the CM6 heading tracker
// and renders a clickable, collapsible tree. Clicking a heading scrolls
// the editor to that position. Each heading with sub-headings gets a
// caret to expand/collapse its children. An expand/collapse-all button
// lives in the panel header.

import { Component, For, Show, createSignal, createMemo } from "solid-js";
import {
  headings,
  type Heading,
} from "../editor/typst-decorations/heading-tracker";
import { activeEditorView } from "../stores/editor";
import { useI18n } from "../lib/i18n";
import { EditorView } from "@codemirror/view";
import {
  ChevronRight,
  ChevronDown,
  ListChevronsUpDown,
  ListChevronsDownUp,
} from "lucide-solid";

interface HeadingNode {
  heading: Heading;
  children: HeadingNode[];
}

function buildTree(flat: Heading[]): HeadingNode[] {
  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (const h of flat) {
    const node: HeadingNode = { heading: h, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= h.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return root;
}

function collectKeys(nodes: HeadingNode[], acc: Set<number>): Set<number> {
  for (const n of nodes) {
    if (n.children.length > 0) {
      acc.add(n.heading.pos);
      collectKeys(n.children, acc);
    }
  }
  return acc;
}

// Top-level parents stay expanded when the user clicks "collapse all" so the
// minimum-visibility state still surfaces all second-level headings — anything
// deeper than the top level is what actually collapses.
function collectTopLevelKeys(nodes: HeadingNode[]): Set<number> {
  const out = new Set<number>();
  for (const n of nodes) {
    if (n.children.length > 0) out.add(n.heading.pos);
  }
  return out;
}

const OutlinePanel: Component = () => {
  const t = useI18n();
  const [expandedKeys, setExpandedKeys] = createSignal<Set<number>>(
    new Set<number>()
  );

  const tree = createMemo(() => {
    const built = buildTree(headings());
    // Auto-expand all on first build / heading changes
    setExpandedKeys(collectKeys(built, new Set()));
    return built;
  });

  const allParentKeys = createMemo(() => collectKeys(tree(), new Set()));

  const allExpanded = createMemo(() => {
    const all = allParentKeys();
    if (all.size === 0) return false;
    const cur = expandedKeys();
    for (const k of all) if (!cur.has(k)) return false;
    return true;
  });

  function expandAll() {
    setExpandedKeys(collectKeys(tree(), new Set()));
  }

  // "Collapse all" preserves the top-level parents' expanded state so every
  // direct child of the root (typically the h2 layer) stays visible — the
  // minimum useful outline state.
  function collapseAll() {
    setExpandedKeys(collectTopLevelKeys(tree()));
  }

  function toggleKey(pos: number) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(pos)) next.delete(pos);
      else next.add(pos);
      return next;
    });
  }

  function scrollToHeading(h: Heading) {
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const pos = Math.min(h.pos, view.state.doc.length);
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
  }

  return (
    <div class="outline-panel">
      <div class="right-panel__section-header">
        <span>{t("outlinePanel.title")}</span>
        <Show when={headings().length > 0}>
          <div class="right-panel__header-actions">
            <button
              class="ui-icon-btn"
              onClick={() => (allExpanded() ? collapseAll() : expandAll())}
              title={allExpanded() ? t("outlinePanel.collapseAll") : t("outlinePanel.expandAll")}
              aria-label={allExpanded() ? t("outlinePanel.collapseAll") : t("outlinePanel.expandAll")}
            >
              <Show
                when={allExpanded()}
                fallback={<ListChevronsUpDown size={14} />}
              >
                <ListChevronsDownUp size={14} />
              </Show>
            </button>
          </div>
        </Show>
      </div>
      <Show
        when={headings().length > 0}
        fallback={<p class="sidebar-hint">{t("outlinePanel.noHeadings")}</p>}
      >
        <OutlineTree
          nodes={tree()}
          expandedKeys={expandedKeys}
          onToggle={toggleKey}
          onScroll={scrollToHeading}
        />
      </Show>
    </div>
  );
};

const OutlineTree: Component<{
  nodes: HeadingNode[];
  expandedKeys: () => Set<number>;
  onToggle: (pos: number) => void;
  onScroll: (h: Heading) => void;
}> = (props) => {
  return (
    <For each={props.nodes}>
      {(node) => {
        const hasChildren = () => node.children.length > 0;
        const expanded = () => props.expandedKeys().has(node.heading.pos);

        return (
          <>
            <div
              class="outline-panel__item"
              style={{
                "padding-left": `${(node.heading.level - 1) * 16 + 12}px`,
              }}
            >
              <span
                class={`outline-panel__caret${hasChildren() ? "" : " outline-panel__caret--leaf"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren()) props.onToggle(node.heading.pos);
                }}
              >
                <Show when={hasChildren()}>
                  <Show
                    when={expanded()}
                    fallback={<ChevronRight size={12} />}
                  >
                    <ChevronDown size={12} />
                  </Show>
                </Show>
              </span>
              <span
                class="outline-panel__label"
                onClick={() => props.onScroll(node.heading)}
              >
                {node.heading.text}
              </span>
            </div>
            <Show when={hasChildren() && expanded()}>
              <OutlineTree
                nodes={node.children}
                expandedKeys={props.expandedKeys}
                onToggle={props.onToggle}
                onScroll={props.onScroll}
              />
            </Show>
          </>
        );
      }}
    </For>
  );
};

export default OutlinePanel;
