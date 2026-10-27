import { Component, For, Show } from "solid-js";
import { type PaneNode, type SplitNode, type LeafPane } from "../../stores/panes";
import PaneLeaf from "./PaneLeaf";
import PaneResizer from "./PaneResizer";

/** A split node: lays its children in a row or column, with a resizer
 *  between each pair. Children recurse back through `PaneView`. */
const SplitView: Component<{ node: SplitNode }> = (props) => (
  <div class={`pane-split pane-split--${props.node.direction}`}>
    <For each={props.node.children}>
      {(child, i) => (
        <>
          <Show when={i() > 0}>
            <PaneResizer split={props.node} dividerIndex={i() - 1} />
          </Show>
          <div
            class="pane-split__slot"
            style={{ "flex-grow": String(props.node.sizes[i()] ?? 1) }}
          >
            <PaneView node={child} />
          </div>
        </>
      )}
    </For>
  </div>
);

/**
 * Renders one node of the pane tree. A `PaneView` keeps its kind for its
 * lifetime: a leaf that becomes a split is replaced in its parent's slot (or at
 * the root), so a new `PaneView` mounts. Remounts happen only on structural
 * changes (split, collapse, move), which the editor state cache absorbs;
 * resizing only changes `sizes`.
 */
const PaneView: Component<{ node: PaneNode }> = (props) => (
  <Show
    when={props.node.kind === "split"}
    fallback={<PaneLeaf leaf={props.node as LeafPane} />}
  >
    <SplitView node={props.node as SplitNode} />
  </Show>
);

export default PaneView;
