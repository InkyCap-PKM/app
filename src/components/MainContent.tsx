import { Component, Show } from "solid-js";
import { panes } from "../stores/panes";
import PaneView from "./panes/PaneView";

/**
 * The editor area, holding the pane tree: one leaf pane fills it, and splits
 * divide it. The keyed `Show` re-renders the tree only when the root node is
 * replaced (the first split, or collapsing back to one pane); otherwise the
 * panes handle tab and size changes themselves.
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
