import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * An arrow entering a box from the lower left, for the "linked from the anchor"
 * badge in Journal Scroll.
 *
 * Master: design-assets/square-arrow-in-down-left.svg, kept in step by hand.
 */
export const SquareArrowInDownLeft: Component<{
  size?: number;
  class?: string;
}> = (props) => (
  <svg {...lucideFrame(props.size ?? 24)} class={props.class}>
    <path d="M13 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6" />
    <g transform="rotate(180,9.0080946,9.0379826)">
      <path d="m 3,3 9,9" />
      <path d="M 3,9 V 3 h 6" />
    </g>
  </svg>
);
