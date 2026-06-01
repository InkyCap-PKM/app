// Curated reference content for the Help panel.
//
// Two kinds of content live here because neither has a home in the command
// registry (which the panel's "UI shortcuts" view and the inline-typing half
// of its "Visual editor" view are generated from):
//
//   - VISUAL_EDITOR_KEYS — the CodeMirror keymap bindings that act on note
//     content. They are authored in `typst-decorations/keymaps.ts` as raw CM
//     `KeyBinding`s with no human-readable label, so the panel needs this
//     parallel descriptive table. Keep it in sync with `typstKeymap` there.
//   - MARKUP_REFERENCE — a cheat-sheet of Typst markup, the equivalent a writer
//     would reach for in Markdown, the InkyCap authoring shortcuts, and the
//     notebox-native primitives bundled in the `inkycap-notebox` package.
//
// `labelKey` / `titleKey` / `noteKey` fields are i18n keys, resolved in
// HelpPanel via the static `t`. The `keys` / `markup` / `markdown` fields are
// literal syntax (code samples, not prose) and are intentionally not
// translated.

export interface VisualEditorKey {
  /** i18n key for the description of what this binding does. */
  labelKey: string;
  /** Canonical key combo in display form (e.g. "Ctrl+B"). */
  keys: string;
}

/** Formatting / editing keys that operate inside the visual editor. Mirrors
 *  `typstKeymap` in `src/editor/typst-decorations/keymaps.ts`. */
export const VISUAL_EDITOR_KEYS: VisualEditorKey[] = [
  { labelKey: "help.visual.bold", keys: "Ctrl+B" },
  { labelKey: "help.visual.italic", keys: "Ctrl+I" },
  { labelKey: "help.visual.strikethrough", keys: "Ctrl+Shift+X" },
  { labelKey: "help.visual.highlight", keys: "Ctrl+Shift+H" },
  { labelKey: "help.visual.inlineCode", keys: "Ctrl+E" },
  { labelKey: "help.visual.inlineMath", keys: "Ctrl+Shift+M" },
  { labelKey: "help.visual.headingDecrease", keys: "Ctrl+Shift+Up" },
  { labelKey: "help.visual.headingIncrease", keys: "Ctrl+Shift+Down" },
  { labelKey: "help.visual.indent", keys: "Tab" },
  { labelKey: "help.visual.outdent", keys: "Shift+Tab" },
  { labelKey: "help.visual.moveItemUp", keys: "Shift+Alt+Up" },
  { labelKey: "help.visual.moveItemDown", keys: "Shift+Alt+Down" },
  { labelKey: "help.visual.enter", keys: "Enter" },
];

export interface MarkupRow {
  /** i18n key describing the intent ("Bold text", "Heading"). */
  labelKey: string;
  /** Typst markup form. */
  markup: string;
  /** i18n key for an optional clarifying note. */
  noteKey?: string;
}

export interface MarkupSection {
  /** i18n key for the section heading. */
  titleKey: string;
  rows: MarkupRow[];
}

/** Cheat-sheet of common authoring situations: Typst markup, InkyCap
 *  shortcuts, notebox primitives, and collaboration markup. */
export const MARKUP_REFERENCE: MarkupSection[] = [
  {
    titleKey: "help.markup.section.text",
    rows: [
      { labelKey: "help.markup.bold", markup: "*bold*" },
      { labelKey: "help.markup.italic", markup: "_italic_" },
      { labelKey: "help.markup.strikethrough", markup: "#strike[text]" },
      { labelKey: "help.markup.highlight", markup: "#highlight[text]" },
      { labelKey: "help.markup.inlineCode", markup: "`code`" },
      { labelKey: "help.markup.superscript", markup: "x^2" },
      { labelKey: "help.markup.subscript", markup: "x_1" },
    ],
  },
  {
    titleKey: "help.markup.section.structure",
    rows: [
      { labelKey: "help.markup.heading1", markup: "= Heading" },
      { labelKey: "help.markup.heading2", markup: "== Heading" },
      { labelKey: "help.markup.heading3", markup: "=== Heading" },
      { labelKey: "help.markup.bulletList", markup: "- item" },
      { labelKey: "help.markup.orderedList", markup: "+ item" },
      { labelKey: "help.markup.termList", markup: "/ Term: definition" },
      { labelKey: "help.markup.blockquote", markup: "#quote[…]" },
      { labelKey: "help.markup.rule", markup: "#line(length: 100%)" },
      { labelKey: "help.markup.codeBlock", markup: "```lang … ```" },
    ],
  },
  {
    titleKey: "help.markup.section.math",
    rows: [
      { labelKey: "help.markup.inlineMathRef", markup: "$x^2$" },
      { labelKey: "help.markup.blockMath", markup: "$ x^2 $" },
      { labelKey: "help.markup.fraction", markup: "$frac(a, b)$" },
      { labelKey: "help.markup.greek", markup: "$alpha, beta, pi$" },
    ],
  },
  {
    titleKey: "help.markup.section.links",
    rows: [
      { labelKey: "help.markup.url", markup: "https://example.com", noteKey: "help.markup.url.note" },
      { labelKey: "help.markup.link", markup: '#link("https://…")[text]' },
      { labelKey: "help.markup.image", markup: '#image("/path.png")' },
      { labelKey: "help.markup.video", markup: '#video("/clip.mp4")' },
      { labelKey: "help.markup.audio", markup: '#audio("/track.mp3")' },
    ],
  },
  {
    titleKey: "help.markup.section.inkycap",
    rows: [
      { labelKey: "help.markup.wikilink", markup: "[[Note name]]", noteKey: "help.markup.wikilink.note" },
      { labelKey: "help.markup.tag", markup: '#tag("name")', noteKey: "help.markup.tag.note" },
      { labelKey: "help.markup.slash", markup: "/", noteKey: "help.markup.slash.note" },
      { labelKey: "help.markup.cite", markup: "@citekey", noteKey: "help.markup.cite.note" },
    ],
  },
  {
    titleKey: "help.markup.section.notebox",
    rows: [
      { labelKey: "help.markup.note", markup: '#note(title: "…")', noteKey: "help.markup.note.note" },
      { labelKey: "help.markup.callout", markup: '#callout("note")[…]' },
      { labelKey: "help.markup.verse", markup: "#verse[…]", noteKey: "help.markup.verse.note" },
      { labelKey: "help.markup.task", markup: "#task[…]", noteKey: "help.markup.task.note" },
      { labelKey: "help.markup.due", markup: '#due("2026-06-01")' },
      { labelKey: "help.markup.linkRef", markup: '#link-ref("Note name")' },
      { labelKey: "help.markup.setNotebox", markup: "#set-notebox(…)", noteKey: "help.markup.setNotebox.note" },
    ],
  },
  {
    titleKey: "help.markup.section.review",
    rows: [
      { labelKey: "help.markup.annotation", markup: "#annotation[…]", noteKey: "help.markup.annotation.note" },
      { labelKey: "help.markup.suggestInsert", markup: '#suggestion(kind: "insert")[…]' },
      { labelKey: "help.markup.suggestDelete", markup: '#suggestion(kind: "delete")[…]' },
      { labelKey: "help.markup.suggestReplace", markup: '#suggestion(kind: "replace", old: [old])[new]' },
    ],
  },
];
