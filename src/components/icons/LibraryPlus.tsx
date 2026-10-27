import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * "Library +" icon for the New Collection button: Lucide's `library-big` with a
 * plus in place of the second volume.
 *
 * Master: design-assets/library-plus.svg, kept in step by hand.
 */
export const LibraryPlusIcon: Component<{ size?: number; class?: string }> = (
  props,
) => (
  <svg {...lucideFrame(props.size ?? 18)} class={props.class}>
    <rect width="8" height="18" x="3" y="3" rx="1" />
    <path d="M7 3v18" />
    <g transform="translate(5.9452055,5.9937734)">
      <path d="m12 7v6" />
      <path d="m9 10h6" />
    </g>
  </svg>
);
