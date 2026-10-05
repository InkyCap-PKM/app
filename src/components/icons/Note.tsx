import type { Component } from "solid-js";

/**
 * A page with a folded corner: marks a written note in lists of notes (the
 * Links tab, an attachment's "Used in" list). Its dashed counterpart,
 * UnwrittenNoteIcon, marks a linked note that hasn't been written yet.
 */
export const NoteIcon: Component<{ size?: number; class?: string }> = (props) => (
  <svg
    class={props.class}
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z" />
    <polyline points="9.5 2 9.5 5.5 13 5.5" />
  </svg>
);
