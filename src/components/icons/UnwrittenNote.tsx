import type { Component } from "solid-js";

/**
 * A page drawn with a dashed outline: marks a linked note that hasn't been
 * written yet. Used wherever a list mixes written and unwritten notes (the
 * Links tab, the Journal Scroll's Connections pane). Drawn to match the
 * solid page icon beside it in the Links tab.
 */
export const UnwrittenNoteIcon: Component<{
  size?: number;
  class?: string;
  "aria-label"?: string;
}> = (props) => (
  <svg
    class={props.class}
    aria-label={props["aria-label"]}
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-dasharray="2.5 2"
  >
    <path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z" />
    <polyline points="9.5 2 9.5 5.5 13 5.5" />
  </svg>
);
