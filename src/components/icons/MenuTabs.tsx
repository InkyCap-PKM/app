import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * Tab-options glyph: a tab-bar outline with two tab "tops" sitting on it —
 * the menu at the right edge of a pane's tab strip. Editable master:
 * `design-assets/menu-tabs.svg` — keep the two in sync by hand. The outline
 * uses a 1px stroke (overriding the shared 2px lucide frame, matching the
 * master SVG); the two tab caps are filled with `currentColor` so the glyph
 * reads at small sizes.
 */
export const MenuTabsIcon: Component<{ size?: number; class?: string }> = (
  props,
) => (
  <svg {...lucideFrame(props.size ?? 24)} class={props.class}>
    <rect width="20" height="12" x="2" y="6" rx="2" stroke-width="1" />
    <g
      transform="matrix(1.125518,0,0,1.3012895,-1.548428,-3.6154779)"
      fill="currentColor"
      stroke="none"
    >
      <path d="m 10.974005,13.488003 h -1.152 v -1.648 h -3.776 v 1.648 h -1.152 v -2.976 h 6.08 z" />
      <path d="m 19.181004,13.488003 h -1.152 v -1.648 h -3.776 v 1.648 h -1.152 v -2.976 h 6.08 z" />
    </g>
  </svg>
);
