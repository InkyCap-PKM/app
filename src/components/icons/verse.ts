/**
 * Custom "verse" glyph for the editor's text-selection toolbar — a ruled
 * tablet with punched grid holes. Lives here, the shared home for InkyCap's
 * hand-authored icons, rather than inline in the toolbar.
 *
 * Exported as a raw SVG string (not a Solid component) because its sole
 * consumer — the text-selection toolbar in
 * `editor/typst-decorations/selection-toolbar.ts` — builds its DOM
 * imperatively and injects this via innerHTML. The punched holes use
 * `var(--toolbar-float-bg)` so they read as cut-outs against the floating
 * toolbar's background; the glyph is therefore tuned for that context.
 */
export const VERSE_ICON_SVG = `<svg viewBox="0 0 32 32" width="14" height="14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="22" height="3.5" rx="1" fill="currentColor" stroke="none"/><path d="M7.5 5.5H24.5L29 20V24.5C29 26.5 27.5 28 25.5 28H6.5C4.5 28 3 26.5 3 24.5V20Z" fill="currentColor" stroke="none"/><rect x="11" y="10" width="3" height="3" rx="0.5" fill="var(--toolbar-float-bg)" stroke="none"/><rect x="18" y="10" width="3" height="3" rx="0.5" fill="var(--toolbar-float-bg)" stroke="none"/><rect x="7" y="16" width="3" height="3" rx="0.5" fill="var(--toolbar-float-bg)" stroke="none"/><rect x="12" y="16" width="3" height="3" rx="0.5" fill="var(--toolbar-float-bg)" stroke="none"/><rect x="17" y="16" width="3" height="3" rx="0.5" fill="var(--toolbar-float-bg)" stroke="none"/><rect x="22" y="16" width="3" height="3" rx="0.5" fill="var(--toolbar-float-bg)" stroke="none"/><line x1="10" y1="23.5" x2="22" y2="23.5" stroke="var(--toolbar-float-bg)" stroke-width="2.5"/></svg>`;
