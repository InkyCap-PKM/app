import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * "Copy as quote" icon for Compose cards: Lucide's `copy` pages with filled
 * quotation marks on the front, distinct from the References tab's quote icon.
 *
 * Master: design-assets/copy-quote.svg, kept in step by hand.
 */
export const CopyQuoteIcon: Component<{ size?: number; class?: string }> = (props) => (
  <svg {...lucideFrame(props.size ?? 18)} class={props.class}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    <g transform="matrix(0.45,0,0,0.45,9.68,9.61)" fill="currentColor">
      <path d="m16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
      <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
    </g>
  </svg>
);
