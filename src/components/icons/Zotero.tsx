import type { Component } from "solid-js";

/**
 * Zotero "Z" mark. Custom — lucide-solid has no Zotero icon. Filled rather
 * than stroked, so it doesn't use the shared lucideFrame. Carries the
 * `zotero-icon` class for theming; any caller-supplied class is appended.
 */
export const ZoteroIcon: Component<{ size?: number; class?: string }> = (
  props,
) => (
  <svg
    class={`zotero-icon${props.class ? ` ${props.class}` : ""}`}
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="none"
  >
    <path d="M21 3H3v3.6h11.4L3 18.4V21h18v-3.6H9.6L21 5.6z" />
  </svg>
);
