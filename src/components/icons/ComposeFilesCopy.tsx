import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * "Copy the whole note" glyph for Compose cards: a full page with a folded
 * corner in front of a second page, set beside the passage-copy buttons.
 *
 * ⚠ Master lives at design-assets/compose-files-copy.svg. That file and this
 * component are kept in sync BY HAND — if you redraw the glyph, edit both,
 * or the editable master and the shipped icon will silently diverge.
 */
export const ComposeFilesCopyIcon: Component<{ size?: number; class?: string }> = (props) => (
  <svg {...lucideFrame(props.size ?? 18)} class={props.class}>
    <g transform="translate(0,5)">
      <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
      <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
    </g>
    <path d="M4.674 17.046a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h8a2 2 0 0 1 1.732 1" />
  </svg>
);
