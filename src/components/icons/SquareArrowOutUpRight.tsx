import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * Custom "square-arrow-out-up-right" — an arrow leaving the box toward the
 * upper right. Used for the "links to the anchor" badge in Journal Scroll.
 *
 * ⚠ Master lives at design-assets/square-arrow-out-up-right.svg. That file
 * and this component are kept in sync BY HAND — if you redraw the glyph,
 * edit both, or the editable master and the shipped icon will diverge.
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
