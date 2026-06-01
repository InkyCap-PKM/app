import type { Component } from "solid-js";

/**
 * "Typst documentation" mark — a book glyph (Lucide's book-alert outline) with
 * a Typst "T" on the cover. Custom; lucide-solid has no Typst icon.
 *
 * ⚠ Master lives at design-assets/typst-documentation.svg. Kept in sync BY
 * HAND — redraw one, redraw the other. The book is stroked and the "T" is a
 * filled glyph path; both render in `currentColor` so the icon matches the
 * surrounding toolbar/header glyphs and themes correctly.
 */
export const TypstDocIcon: Component<{ size?: number; class?: string }> = (
  props,
) => (
  <svg
    class={props.class}
    width={props.size ?? 18}
    height={props.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
    <path
      d="M 11.002077,5.7892674 H 9.0667174 q -0.4536,0 -0.69552,-0.24192 -0.24192,-0.24192 -0.24192,-0.69552 0,-0.43848 0.2268,-0.66528 0.24192,-0.24192 0.69552,-0.24192 h 5.8967996 q 0.4536,0 0.6804,0.24192 0.24192,0.2268 0.24192,0.66528 0,0.4536 -0.24192,0.69552 -0.24192,0.24192 -0.69552,0.24192 h -1.93536 v 8.2403996 q 0,0.51408 -0.24192,0.756 -0.24192,0.24192 -0.756,0.24192 -0.51408,0 -0.756,-0.24192 -0.24192,-0.24192 -0.24192,-0.756 z"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);
