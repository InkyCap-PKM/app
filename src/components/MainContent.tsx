import { Component, Show } from "solid-js";
import { panes } from "../stores/panes";
import PaneView from "./panes/PaneView";

/**
 * The editor area. Hosts the recursive pane tree: a single leaf pane fills
 * the whole area today, and splits subdivide it. The keyed `Show` re-renders
 * the tree only when the *root* node is replaced (the first split, or a
 * collapse back to one pane); within a stable root, the pane components
 * react to tab/size changes on their own.
 */
const MainContent: Component = () => {
  return (
    // `data-menu-bounds`: menus opened from a button in here stay inside the
    // column instead of running under the right panel (see anchorPanelMenu).
    <div class="main-content" data-menu-bounds>
      <Show when={panes.root} keyed>
        {(root) => <PaneView node={root} />}
      </Show>
    </div>
  );
};

export default MainContent;
