import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * Tab options icon: a tab bar outline with one tab on it, for the menu at the
 * right of a pane's tab strip. Master: `design-assets/menu-tabs.svg`, kept in
 * step by hand. The outline has a 1px stroke (instead of the frame's 2px, as in
 * the master); the tab is filled with `currentColor` so it reads at small
 * sizes.
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
      <path d="m 19.152887,13.488003 h -2.701683 v -1.648 H 7.595688 v 1.648 H 4.894005 v -2.976 h 14.258882 z" />
    </g>
  </svg>
);
