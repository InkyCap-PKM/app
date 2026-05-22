import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * Custom "square-arrow-in-down-left" — an arrow entering the box from the
 * lower left. Used for the "linked from the anchor" badge in Journal Scroll.
 *
 * ⚠ Master lives at design-assets/square-arrow-in-down-left.svg. That file
 * and this component are kept in sync BY HAND — if you redraw the glyph,
 * edit both, or the editable master and the shipped icon will diverge.
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
