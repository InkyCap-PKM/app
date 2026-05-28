import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * Word/character count glyph: three text lines plus a "#" (count) mark.
 * Editable master: `design-assets/text-count.svg` — keep the two in sync by
 * hand. Recoloured to `currentColor` here so it sits with the lucide icons in
 * the status bar; the master keeps its own palette for standalone preview.
 */
export const TextCountIcon: Component<{ size?: number; class?: string }> = (
  props,
) => (
  <svg {...lucideFrame(props.size ?? 24)} class={props.class}>
    <path d="M21 5H3" />
    <path d="M10 12H3" />
    <path d="M10 19H3" />
    <text
      transform="scale(1.1263292,0.8878399)"
      x="11.032371"
      y="22.368378"
      font-size="14.9169"
      font-family="monospace"
      fill="currentColor"
      stroke="none"
    >
      #
    </text>
  </svg>
);
