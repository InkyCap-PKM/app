import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * An arrow leaving a box toward the upper right, for the "links to the anchor"
 * badge in Journal Scroll.
 *
 * Master: design-assets/square-arrow-out-up-right.svg, kept in step by hand.
 */
export const SquareArrowOutUpRight: Component<{
  size?: number;
  class?: string;
}> = (props) => (
  <svg {...lucideFrame(props.size ?? 24)} class={props.class}>
    <path d="m 21,13 v 6 a 2,2 0 0 1 -2,2 H 5 A 2,2 0 0 1 3,19 V 5 A 2,2 0 0 1 5,3 h 6" />
    <g transform="rotate(90,8.953924,11.970112)">
      <path d="m 3,3 9,9" />
      <path d="M 3,9 V 3 h 6" />
    </g>
  </svg>
);
