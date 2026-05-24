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
 * Renders one node of the pane tree. A given `PaneView` instance has a fixed
 * kind for its lifetime: a leaf that becomes a split is replaced wholesale in
 * its parent's child slot (or at the root), so the enclosing `For` / keyed
 * `Show` mounts a fresh `PaneView`. That bounds remounts to structural
 * changes (split / collapse / move), which the editor state cache absorbs;
 * resizing only mutates `sizes` and never remounts.
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
