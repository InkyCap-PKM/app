import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * "Library +" glyph for the New Collection button. lucide-solid has no
 * library-plus icon, so this is a local SVG: the lucide `library-big` book
 * spine with a plus mark in place of the second volume.
 *
 * ⚠ Master lives at design-assets/library-plus.svg. That file and this
 * component are kept in sync BY HAND — if you redraw the glyph, edit both,
 * or the editable master and the shipped icon will silently diverge.
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
