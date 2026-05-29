import { type EditorView, WidgetType, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { openLink } from "../../lib/open-link";
import { loadMediaObjectUrl, revokeMediaBlobs } from "../../lib/media-src";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as ipc from "../../lib/ipc";
import { highlightCodeInto } from "./code-highlight";
import { buildPillButton, findCallEnd, applyCallTransform, upsertNamedArg, type PillMenuSection } from "./pill";
import { getPillOptions } from "./pill-options";
import { showWikilinkContextMenu } from "../../lib/wikilink-nav";
import { anchorPanelMenu } from "../../lib/uiMenu";
import { buildSuggestionCall } from "./annotation-insert";

/** Convert a Typst length value (e.g. `40%`, `200pt`, `3cm`) to a CSS value.
 *  Typst percentages and common units map directly; unknown units pass through. */
function typstLengthToCss(value: string): string {
  const v = value.trim();
  if (v.endsWith("%") || v.endsWith("px") || v.endsWith("em") || v.endsWith("rem")) return v;
  if (v.endsWith("pt")) return v;
  if (v.endsWith("cm") || v.endsWith("mm") || v.endsWith("in")) return v;
  // Bare number → treat as pt
  if (/^\d+(\.\d+)?$/.test(v)) return `${v}pt`;
  return v;
}

// Build the small pill row that block elements (image, callout,
// blockquote) show at their top edge when the cursor is on the line.
// The pill is rendered INSIDE the element's widget DOM, not as a
// separate block widget above it: keeping it inside means
// (a) `coordsAtPos(from)` returns the same y whether the pill is
// present, replaced by raw markup, or absent — so the click-anchor
// plugin sees zero delta on pill clicks and doesn't drift, and
// (b) there's no extra block-widget container introducing line-spacing
// above the element.
// Block content-bracket pills (callout, quote) where the body is the
// real content — clicking the pill should always reveal the source for
// editing, even when the call is "complex" by the simple/complex
// classifier (multi-line / multi-paragraph callouts are the common
// case). Other block-row pills (image, figure) stick to the
// default simple→expand / complex→menu split.
const ALWAYS_EXPAND_PILLS = new Set(["callout", "quote", "annotation"]);

function makeBlockPillRow(funcName: string, pos: number, view: EditorView): HTMLElement {
  const row = document.createElement("div");
  row.className = "cm-typst-block-pill-row";
  row.appendChild(buildPillButton(funcName, view, () => {
    const callTo = findCallEnd(view, pos);
    return {
      funcName,
      callFrom: pos,
      callTo,
      optionSections: getPillOptions(funcName, view, pos, callTo),
      alwaysExpandOnClick: ALWAYS_EXPAND_PILLS.has(funcName),
    };
  }));
  return row;
}




const WIKILINK_FUNC_RE = /#wikilink\("([^"]*)"(?:,\s*display:\s*"([^"]*)")?\)/g;

function renderTypstBody(text: string, parent: HTMLElement) {
  WIKILINK_FUNC_RE.lastIndex = 0;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_FUNC_RE.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parent.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    const target = match[1];
    const display = match[2] || target;
    const link = document.createElement("span");
    link.className = "cm-typst-wikilink";
    link.textContent = display;
    link.title = target;
    link.addEventListener("mousedown", (e) => {
      if (e.button === 2) return;
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(
        new CustomEvent("inkycap:navigate-wikilink", { detail: { target } }),
      );
    });
    link.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWikilinkContextMenu(e.clientX, e.clientY, target);
    });
    parent.appendChild(link);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function stripMetadata(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];
  let inBlock = false;
  let parenDepth = 0;
  for (const line of lines) {
    if (inBlock) {
      for (const ch of line) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") { parenDepth--; if (parenDepth <= 0) { inBlock = false; break; } }
      }
      continue;
    }
    if (line.startsWith("#import") || line.startsWith("#bibliography(")) continue;
    if (line.startsWith("#note(")) {
      inBlock = true;
      parenDepth = 1;
      for (let i = 6; i < line.length; i++) {
        if (line[i] === "(") parenDepth++;
        else if (line[i] === ")") { parenDepth--; if (parenDepth <= 0) { inBlock = false; break; } }
      }
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

export const CALLOUT_COLORS: Record<string, string> = {
  note: "#448aff",
  tip: "#00bfa5",
  warning: "#ff9100",
  important: "#ff5252",
  caution: "#ff6d00",
  example: "#7c4dff",
  quote: "#9e9e9e",
  abstract: "#00b0ff",
  info: "#2196f3",
  todo: "#ff6d00",
  success: "#00c853",
  question: "#64dd17",
  failure: "#ff1744",
  danger: "#d50000",
  bug: "#f50057",
};

// Annotation accent. Mirrors `_annotation-color` in the notebox package's
// lib.typ so the visual-editor block and the compiled output read the same.
const ANNOTATION_COLOR = "#8b5cf6";

export class CalloutWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly title: string,
    readonly bodyText: string,
  ) {
    super();
  }

  eq(other: CalloutWidget) {
    return this.kind === other.kind && this.title === other.title && this.bodyText === other.bodyText;
  }

  toDOM() {
    const color = CALLOUT_COLORS[this.kind] ?? CALLOUT_COLORS.note;
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-callout";
    wrap.style.borderLeftColor = color;
    wrap.style.backgroundColor = `color-mix(in srgb, ${color} 8%, transparent)`;

    const heading = document.createElement("div");
    heading.className = "cm-typst-callout-heading";
    heading.style.color = color;
    heading.textContent = this.title || this.kind.charAt(0).toUpperCase() + this.kind.slice(1);
    wrap.appendChild(heading);

    if (this.bodyText) {
      const body = document.createElement("div");
      body.className = "cm-typst-callout-body";
      renderTypstBody(this.bodyText, body);
      wrap.appendChild(body);
    }

    return wrap;
  }

  ignoreEvent(e: Event) {
    if (e.type === "mousedown") {
      return !!(e.target as HTMLElement).closest(".cm-typst-wikilink");
    }
    return false;
  }
}

export class CodeBlockWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
  ) {
    super();
  }

  eq(other: CodeBlockWidget) {
    return this.lang === other.lang && this.code === other.code;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-codeblock";

    const header = document.createElement("div");
    header.className = "cm-typst-codeblock-header";
    if (this.lang) {
      const label = document.createElement("span");
      label.className = "cm-typst-codeblock-lang";
      label.textContent = this.lang;
      header.appendChild(label);
    } else {
      // Empty span keeps the header row tall and pushes the copy button to
      // the right whether or not a language label is present.
      const spacer = document.createElement("span");
      spacer.className = "cm-typst-codeblock-lang";
      header.appendChild(spacer);
    }

    const codeText = this.code;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "cm-typst-codeblock-copy";
    copyBtn.title = "Copy code";
    copyBtn.setAttribute("aria-label", "Copy code");
    copyBtn.innerHTML = // static-only
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener("mousedown", (e) => {
      // Stop CodeMirror from moving the selection into the widget on click.
      e.preventDefault();
      e.stopPropagation();
    });
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard
        .writeText(codeText)
        .then(() => {
          copyBtn.classList.add("is-copied");
          copyBtn.title = "Copied";
          setTimeout(() => {
            copyBtn.classList.remove("is-copied");
            copyBtn.title = "Copy code";
          }, 1200);
        })
        .catch((err) => {
          console.error("Failed to copy code block:", err);
        });
    });
    header.appendChild(copyBtn);
    wrap.appendChild(header);

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.appendChild(code);
    wrap.appendChild(pre);

    // Highlight asynchronously; the synchronous fallback inside
    // highlightCodeInto fills `code` with plain text first so the widget
    // is never visibly empty during the language load.
    void highlightCodeInto(this.lang, this.code, code);

    return wrap;
  }

  // Let clicks on the copy button (or text selection inside the widget)
  // through to the DOM handlers; CodeMirror would otherwise treat the whole
  // widget as opaque.
  ignoreEvent(e: Event) {
    if (e.type === "mousedown" || e.type === "click") {
      const target = e.target as HTMLElement;
      if (target.closest(".cm-typst-codeblock-copy")) return true;
    }
    return false;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly pos: number,
    readonly alt: string | null = null,
    readonly width: string | null = null,
    readonly height: string | null = null,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return this.path === other.path && this.pos === other.pos
      && this.alt === other.alt && this.width === other.width
      && this.height === other.height;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-image";

    const label = document.createElement("div");
    label.className = "cm-typst-image-label";
    label.textContent = this.path;
    wrap.appendChild(label);

    const imgPath = this.path;
    ipc.resolveEmbedPath(imgPath).then((absPath) => {
      if (!absPath) return;
      const img = document.createElement("img");
      img.className = "cm-typst-image-img";
      img.alt = this.alt ?? imgPath;
      img.src = convertFileSrc(absPath);
      if (this.width) img.style.width = typstLengthToCss(this.width);
      if (this.height) img.style.height = typstLengthToCss(this.height);
      // Preserve aspect ratio when only one axis is constrained — Typst scales
      // the other proportionally — and lift the default preview height cap so
      // an explicitly-sized image isn't silently clipped to a different ratio.
      if (this.width && !this.height) img.style.height = "auto";
      if (this.height && !this.width) img.style.width = "auto";
      if (this.width || this.height) img.style.maxHeight = "none";
      img.addEventListener("load", () => {
        label.style.display = "none";
      });
      img.addEventListener("error", () => {
        img.style.display = "none";
      });
      wrap.insertBefore(img, label);
    });

    return wrap;
  }

  ignoreEvent() { return false; }
}

export type ImageAlign = "left" | "center" | "right";

export class ImageBlockWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly pos: number,
    readonly withPill: boolean,
    readonly alt: string | null = null,
    readonly width: string | null = null,
    readonly height: string | null = null,
    // Horizontal placement, mirroring the source's `#align(...)` wrapper so
    // the visual editor reflects how the image will actually sit on the page.
    // A bare `#image(...)` is left-aligned, matching Typst's inline layout.
    readonly align: ImageAlign = "left",
  ) {
    super();
  }

  eq(other: ImageBlockWidget) {
    return this.path === other.path && this.pos === other.pos
      && this.withPill === other.withPill && this.alt === other.alt
      && this.width === other.width && this.height === other.height
      && this.align === other.align;
  }

  get estimatedHeight(): number { return this.withPill ? 224 : 200; }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-image-block";
    wrap.style.overflow = "hidden";
    this.renderContent(wrap, view);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    dom.innerHTML = "";
    this.renderContent(dom, view);
    return true;
  }

  private renderContent(wrap: HTMLElement, view: EditorView) {
    if (this.withPill) wrap.appendChild(makeBlockPillRow("image", this.pos, view));

    const inner = document.createElement("div");
    inner.style.textAlign = this.align;

    const label = document.createElement("div");
    label.className = "cm-typst-image-label";
    label.textContent = this.path;
    inner.appendChild(label);

    const imgPath = this.path;
    ipc.resolveEmbedPath(imgPath).then((absPath) => {
      if (!absPath) return;
      const img = document.createElement("img");
      img.className = "cm-typst-image-img";
      img.alt = this.alt ?? imgPath;
      img.src = convertFileSrc(absPath);
      // The base style centres the image (margin: 0 auto); override per the
      // alignment so left/right sit flush to their margin.
      if (this.align === "left") { img.style.marginLeft = "0"; img.style.marginRight = "auto"; }
      else if (this.align === "right") { img.style.marginLeft = "auto"; img.style.marginRight = "0"; }
      if (this.width) img.style.width = typstLengthToCss(this.width);
      if (this.height) img.style.height = typstLengthToCss(this.height);
      // Preserve aspect ratio when only one axis is constrained — Typst scales
      // the other proportionally — and lift the default preview height cap so
      // an explicitly-sized image isn't silently clipped to a different ratio.
      if (this.width && !this.height) img.style.height = "auto";
      if (this.height && !this.width) img.style.width = "auto";
      if (this.width || this.height) img.style.maxHeight = "none";
      img.addEventListener("load", () => { label.style.display = "none"; });
      img.addEventListener("error", () => { img.style.display = "none"; });
      inner.insertBefore(img, label);
    });
    wrap.appendChild(inner);
  }

  ignoreEvent() { return false; }
}

/// Block widget for `#video(...)` / `#audio(...)`: an inline player rendered
/// from the notebox attachment, so the writer can scrub/preview media while
/// authoring. The compiled output differs by target (a real <video>/<audio>
/// element in HTML export, a placeholder in PDF) — this widget is purely an
/// authoring convenience, per CLAUDE.md's "visual editor as a user-friendliness
/// tool" principle.
export class MediaBlockWidget extends WidgetType {
  constructor(
    readonly kind: "video" | "audio",
    readonly path: string,
    readonly pos: number,
    readonly withPill: boolean,
    readonly width: string | null = null,
  ) {
    super();
  }

  eq(other: MediaBlockWidget) {
    return this.kind === other.kind && this.path === other.path
      && this.pos === other.pos && this.withPill === other.withPill
      && this.width === other.width;
  }

  get estimatedHeight(): number {
    const base = this.kind === "audio" ? 54 : 200;
    return this.withPill ? base + 24 : base;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-media-block";
    wrap.style.overflow = "hidden";
    this.renderContent(wrap, view);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    revokeMediaBlobs(dom);
    dom.innerHTML = "";
    this.renderContent(dom, view);
    return true;
  }

  destroy(dom: HTMLElement) {
    revokeMediaBlobs(dom);
  }

  private renderContent(wrap: HTMLElement, view: EditorView) {
    if (this.withPill) wrap.appendChild(makeBlockPillRow(this.kind, this.pos, view));

    const inner = document.createElement("div");
    inner.style.textAlign = "center";

    const label = document.createElement("div");
    label.className = "cm-typst-image-label";
    label.textContent = this.path;
    inner.appendChild(label);

    const mediaPath = this.path;
    loadMediaObjectUrl(mediaPath).then((url) => {
      if (!url || !document.body.contains(wrap)) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      const el = document.createElement(this.kind) as HTMLMediaElement;
      el.className = `cm-typst-media-${this.kind}`;
      el.controls = true;
      el.preload = "metadata";
      el.src = url;
      if (this.kind === "video" && this.width) el.style.width = typstLengthToCss(this.width);
      el.addEventListener("loadedmetadata", () => { label.style.display = "none"; });
      el.addEventListener("error", () => { el.style.display = "none"; });
      inner.insertBefore(el, label);
    });
    wrap.appendChild(inner);
  }

  // Let the native media controls own all interaction (play/seek/volume);
  // CM should not treat clicks on the player as editor input.
  ignoreEvent() { return true; }
}

export class TagWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }

  eq(other: TagWidget) {
    return this.name === other.name;
  }

  toDOM() {
    const pill = document.createElement("span");
    pill.className = "cm-typst-tag";
    pill.textContent = `#${this.name}`;
    return pill;
  }

  ignoreEvent() { return false; }
}

/** Inline `#task(...)` — a checkbox + body. Clicking the checkbox toggles
 *  the call's `done:` argument; clicking the body routes to source editing
 *  (the func is interactive, so the cursor-adjacent path reveals raw markup). */
export class TaskWidget extends WidgetType {
  constructor(
    readonly body: string,
    readonly done: boolean,
    readonly due: string | null,
    readonly from: number,
  ) {
    super();
  }

  eq(other: TaskWidget) {
    return this.body === other.body && this.done === other.done
      && this.due === other.due && this.from === other.from;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-typst-task";
    if (this.done) wrap.classList.add("cm-typst-task--done");

    const box = document.createElement("span");
    box.className = "cm-typst-task__box";
    box.textContent = this.done ? "☑" : "☐";
    box.title = this.done ? "Mark as not done" : "Mark as done";
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Set `done: true` when checking; drop the arg (→ default false)
      // when unchecking, so a freshly-unchecked task reads cleanly.
      applyCallTransform(view, this.from, (s) =>
        upsertNamedArg(s, "done", this.done ? "false" : "true", {
          defaultValue: "false",
        }),
      );
    });
    wrap.appendChild(box);

    const text = document.createElement("span");
    text.className = "cm-typst-task__body";
    text.textContent = this.body;
    wrap.appendChild(text);

    if (this.due) {
      const badge = document.createElement("span");
      badge.className = "cm-typst-task__due";
      badge.textContent = this.due;
      wrap.appendChild(badge);
    }
    return wrap;
  }

  ignoreEvent() { return true; }
}

/** Inline `#due(date, label: ...)` — a small date badge. */
export class DueWidget extends WidgetType {
  constructor(
    readonly date: string,
    readonly label: string,
  ) {
    super();
  }

  eq(other: DueWidget) {
    return this.date === other.date && this.label === other.label;
  }

  toDOM() {
    const badge = document.createElement("span");
    badge.className = "cm-typst-due";
    badge.textContent = this.label ? `${this.label} · ${this.date}` : this.date;
    badge.title = this.label ? `${this.label} (${this.date})` : this.date;
    return badge;
  }

  ignoreEvent() { return false; }
}

export type SuggestionKind = "insert" | "delete" | "replace";

// Only one suggestion menu is open at a time; track it module-side so a new
// open (or an outside click) tears down the previous one.
let activeSuggestionMenu: HTMLElement | null = null;
let suggestionMenuCleanup: (() => void) | null = null;
function closeSuggestionMenu() {
  suggestionMenuCleanup?.();
  suggestionMenuCleanup = null;
  activeSuggestionMenu?.remove();
  activeSuggestionMenu = null;
}

/** Inline `#suggestion(...)` tracked-change mark — the visual face of the
 *  suggesting-mode primitive. Renders the CriticMarkup idiom (insert = green
 *  underline, delete = red strike, replace = struck old + underlined new) and,
 *  on click, opens a small Accept / Reject menu.
 *
 *  Accept/reject is a source transform that **unwraps** the call to clean
 *  Typst (`applyCallTransform`). The resolution table mirrors
 *  `typst_pipeline::suggestion::resolution_text` in Rust (the authoritative
 *  transform used for non-editor resolution — md-import, package review); the
 *  two must stay in lock-step. The func is interactive, so the
 *  cursor-adjacent path reveals raw markup for editing the proposed text. */
export class SuggestionWidget extends WidgetType {
  constructor(
    readonly kind: SuggestionKind,
    readonly body: string,
    readonly oldText: string,
    readonly by: string,
    readonly on: string,
    readonly from: number,
    /** Optional reviewer comment carried on the open suggestion (`note:`). */
    readonly note: string = "",
  ) {
    super();
  }

  eq(other: SuggestionWidget) {
    return this.kind === other.kind && this.body === other.body
      && this.oldText === other.oldText && this.by === other.by
      && this.on === other.on && this.from === other.from
      && this.note === other.note;
  }

  private attribution(): string {
    const parts: string[] = [];
    if (this.by) parts.push(this.by);
    if (this.on) parts.push(this.on);
    return parts.join(" · ");
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-typst-suggestion";
    wrap.dataset.kind = this.kind;

    const addMark = (cls: string, txt: string) => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = txt;
      wrap.appendChild(s);
    };
    if (this.kind === "insert") addMark("cm-suggestion-ins", this.body);
    else if (this.kind === "delete") addMark("cm-suggestion-del", this.body);
    else {
      addMark("cm-suggestion-del", this.oldText);
      addMark("cm-suggestion-ins", this.body);
    }

    // A visible comment marker when the suggestion carries a note, so the
    // reviewer's remark is discoverable without opening the menu.
    if (this.note.trim()) {
      const c = document.createElement("span");
      c.className = "cm-suggestion-note";
      c.textContent = "💬";
      wrap.appendChild(c);
    }

    const kindLabel =
      this.kind === "insert" ? "Insertion" : this.kind === "delete" ? "Deletion" : "Replacement";
    const attr = this.attribution();
    const noteSuffix = this.note.trim() ? `\nComment: ${this.note.trim()}` : "";
    wrap.title = `Suggested ${kindLabel.toLowerCase()}${attr ? ` by ${attr}` : ""} — click to review${noteSuffix}`;

    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openMenu(view, wrap);
    });
    return wrap;
  }

  private openMenu(view: EditorView, anchor: HTMLElement) {
    openSuggestionMenu(
      view,
      {
        kind: this.kind,
        body: this.body,
        oldText: this.oldText,
        by: this.by,
        on: this.on,
        note: this.note,
        from: this.from,
      },
      anchor,
    );
  }

  ignoreEvent() {
    return true;
  }
}

/** The data a suggestion's review menu needs — supplied by the inline
 *  [`SuggestionWidget`] or by the Changes & History pane (from a parsed
 *  `AnnotationEntry`). `from` is the call's start offset; the menu's actions go
 *  through [`applyCallTransform`], which re-resolves the call's live extent, so
 *  it stays correct even when opened from outside the editor. */
export interface SuggestionMenuParams {
  kind: SuggestionKind;
  body: string;
  oldText: string;
  by: string;
  on: string;
  note: string;
  from: number;
}

/** Clean-Typst text a suggestion resolves to (accept = take the change). */
function suggestionResolution(p: SuggestionMenuParams, accept: boolean): string {
  switch (p.kind) {
    case "insert":
      return accept ? p.body : "";
    case "delete":
      return accept ? "" : p.body;
    case "replace":
      return accept ? p.body : p.oldText;
  }
}

/** The full replacement on resolve: the resolution plus an inline `#annotation`
 *  carrying the reviewer's comment, when one was left. */
function suggestionReplacement(p: SuggestionMenuParams, accept: boolean, comment: string): string {
  const resolved = suggestionResolution(p, accept);
  const c = comment.trim();
  if (!c) return resolved;
  const annotation = `#annotation[${c}]`;
  return resolved ? `${resolved} ${annotation}` : annotation;
}

/** Open the Accept / Reject / Comment review menu for a suggestion, anchored to
 *  `anchor`. Shared by the inline [`SuggestionWidget`] (anchored to its own DOM)
 *  and the Changes & History pane (anchored to the clicked row). */
export function openSuggestionMenu(
  view: EditorView,
  p: SuggestionMenuParams,
  anchor: HTMLElement,
) {
  closeSuggestionMenu();
  const kindLabel =
    p.kind === "insert" ? "Insertion" : p.kind === "delete" ? "Deletion" : "Replacement";
  const attr = [p.by, p.on].filter(Boolean).join(" · ");

  const menu = document.createElement("div");
  menu.className = "cm-suggestion-menu";

  const header = document.createElement("div");
  header.className = "cm-suggestion-menu__header";
  header.textContent = attr ? `${kindLabel} · ${attr}` : kindLabel;
  menu.appendChild(header);

  // Comment — pre-filled with the suggestion's saved `note` so reopening the
  // menu shows the existing remark. "Save comment" persists it onto the open
  // suggestion (visible in the doc + Annotations pane); Accept/Reject resolve
  // the change and fold any comment in as an inline #annotation so the
  // rationale survives once the suggestion mark is gone.
  const comment = document.createElement("textarea");
  comment.className = "cm-suggestion-menu__comment";
  comment.rows = 2;
  comment.placeholder = "Comment — Save to keep it on the open suggestion";
  comment.value = p.note;
  // Keep keystrokes/selection inside the textarea, not routed to CodeMirror.
  for (const ev of ["mousedown", "keydown", "beforeinput", "input"]) {
    comment.addEventListener(ev, (e) => e.stopPropagation());
  }
  menu.appendChild(comment);

  // Save the comment onto the open suggestion without resolving it: rebuild the
  // call carrying the updated `note` (byte-preserving the body/old content).
  // Empty clears the note.
  const saveRow = document.createElement("div");
  saveRow.className = "cm-suggestion-menu__actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "cm-suggestion-menu__item is-comment";
  saveBtn.textContent = "Save comment";
  saveBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rebuilt = buildSuggestionCall({
      kind: p.kind,
      body: p.body,
      oldText: p.oldText,
      by: p.by,
      on: p.on,
      note: comment.value.trim() || undefined,
    });
    applyCallTransform(view, p.from, () => rebuilt);
    closeSuggestionMenu();
    view.focus();
  });
  saveRow.appendChild(saveBtn);
  menu.appendChild(saveRow);

  const row = document.createElement("div");
  row.className = "cm-suggestion-menu__actions";
  const mkBtn = (label: string, cls: string, accept: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cm-suggestion-menu__item ${cls}`;
    b.textContent = label;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = suggestionReplacement(p, accept, comment.value);
      applyCallTransform(view, p.from, () => text);
      closeSuggestionMenu();
      view.focus();
    });
    row.appendChild(b);
  };
  mkBtn("Accept", "is-accept", true);
  mkBtn("Reject", "is-reject", false);
  menu.appendChild(row);

  document.body.appendChild(menu);
  activeSuggestionMenu = menu;
  anchorPanelMenu(anchor, menu);

  const onDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) closeSuggestionMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeSuggestionMenu();
  };
  // Defer listener attach by a frame so the opening mousedown doesn't
  // immediately re-close the menu it just opened.
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  suggestionMenuCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

export class WikilinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly display: string,
    readonly isBold: boolean = false,
    readonly isItalic: boolean = false,
    readonly isStrike: boolean = false,
    readonly isHighlight: boolean = false,
    readonly headingLevel: number = 0,
    readonly label: string = "",
    readonly exists: boolean = true,
  ) {
    super();
  }

  eq(other: WikilinkWidget) {
    return this.target === other.target && this.display === other.display
      && this.isBold === other.isBold && this.isItalic === other.isItalic
      && this.isStrike === other.isStrike && this.isHighlight === other.isHighlight
      && this.headingLevel === other.headingLevel
      && this.label === other.label
      && this.exists === other.exists;
  }

  toDOM() {
    const pill = document.createElement("span");
    pill.className = "cm-typst-wikilink";
    if (!this.exists) pill.classList.add("cm-typst-wikilink--unresolved");
    if (this.isBold) pill.classList.add("cm-typst-bold");
    if (this.isItalic) pill.classList.add("cm-typst-italic");
    if (this.isStrike) pill.classList.add("cm-typst-strike");
    if (this.isHighlight) pill.classList.add("cm-typst-highlight");
    if (this.headingLevel > 0) pill.classList.add(`cm-typst-h${this.headingLevel}`);

    const nameSpan = document.createElement("span");
    nameSpan.textContent = this.display || this.target;
    pill.appendChild(nameSpan);

    if (this.label) {
      const sep = document.createElement("span");
      sep.className = "cm-typst-wikilink-sep";
      sep.textContent = " · ";
      pill.appendChild(sep);

      const labelSpan = document.createElement("span");
      labelSpan.className = "cm-typst-wikilink-label";
      labelSpan.textContent = this.label;
      pill.appendChild(labelSpan);
    }

    pill.title = this.label ? `${this.target}::${this.label}` : this.target;
    pill.addEventListener("mousedown", (e) => {
      if (e.button === 2) return;
      e.preventDefault();
      e.stopPropagation();
      const newTab = e.ctrlKey || e.metaKey || e.button === 1;
      document.dispatchEvent(
        new CustomEvent("inkycap:navigate-wikilink", { detail: { target: this.target, label: this.label || undefined, newTab } }),
      );
    });
    pill.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(
          new CustomEvent("inkycap:navigate-wikilink", { detail: { target: this.target, label: this.label || undefined, newTab: true } }),
        );
      }
    });
    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWikilinkContextMenu(e.clientX, e.clientY, this.target, this.label || undefined);
    });
    return pill;
  }

  ignoreEvent() { return true; }
}

// ───────────────────────────────────────────────────────────────────────
// VerseWidget — first-class verse element.
// =====================================================================
//
// A "verse" in InkyCap is a freeform poetry/lyrics block. The visual
// editor presents it as an open contentEditable canvas where the user
// types, deletes, pastes, and applies inline formatting just like in
// any rich-text editor. Behind the scenes, the canvas is a faithful
// round-trip projection of a single Typst source call:
//
//   #verse("body string", align-to: center, font: "Newsreader")
//
// Because the source is the source of truth (CodeMirror Live Preview,
// not ProseMirror), every edit eventually flows back to that string.
// The pipeline below is the round-trip — anyone touching this code
// should keep it in mind:
//
//                    ┌─────────────────────────────────┐
//                    │   #verse("...", align-to: …)    │   Typst source
//                    └────────────────┬────────────────┘
//                                     │ extract body string
//                                     ▼
//                            decodeVerseLiteral(src)
//                          (\n/\t/\"/\\/\u{} resolved;
//                          markup escapes \* \_ etc.
//                          PRESERVED for the renderer)
//                                     │
//                                     ▼
//                             renderVerseBody
//                       (line-by-line, parses *bold*,
//                        _italic_, #strike[…] etc. into
//                        <strong>/<em>/<s>/<mark>/<u>)
//                                     │
//                                     ▼
//                          contentEditable canvas DOM
//                          (user types, formats, edits)
//                                     │ blur
//                                     ▼
//                            encodeVerseDOM(canvas)
//                       (DOM walk → markup → escape for
//                        Typst string literal)
//                                     │
//                                     ▼
//                          new body string → dispatch
//                          a CM transaction replacing
//                          the between-quotes range
//                                     │
//                                     ▼
//                          (back to top — re-render)
//
// All markup metacharacters and string-escape backslashes are hidden
// from the user — the canvas presents plain text plus styled spans,
// and the encoder/decoder pair is the single source of truth for
// going between user-typed characters and the literal Typst storage.
// User-typed metacharacters are persisted as `\X` so they round-trip
// literally and are not re-interpreted as markup the next time the
// body is decoded.
//
// ── Sharp edges this widget has accumulated ───────────────────────
//
// 1. Focus routing on insertion. Inserting `/verse` from the command
//    palette lands the CM cursor INSIDE the widget's logical range
//    (between the quotes). At that point the canvas DOM exists but
//    doesn't have focus; CM's contentDOM does. Typed characters
//    bypass the canvas and land at CM's cursor — which sits
//    adjacent-to or inside the widget — producing scrambled output
//    (often reverse-typed because CM normalization keeps pulling the
//    cursor back to a stable widget-boundary position). Fix: when
//    the widget mounts and CM's selection is inside the widget's
//    body range, programmatically focus the canvas via
//    queueMicrotask. Once focus is in the canvas, contentEditable
//    owns the input loop and typing is normal.
//
// 2. Atomic wrap. `wrap.contentEditable = "false"` on the outer
//    element marks the widget atomic for CM6's MutationObserver, so
//    the editor doesn't try to interpret canvas keystrokes as edits
//    to its own document. The inner canvas overrides hierarchically
//    with `contentEditable = "true"`.
//
// 3. Blur-dispatch, not input-dispatch. If we resynced the source on
//    every input event, each keystroke would tear the widget DOM
//    down mid-keystroke (rebuild race) and scatter focus back to CM.
//    The canvas instead accumulates DOM mutations until blur, at
//    which point we encode it once and dispatch a single transaction.
//
// 4. Stop-propagation belt-and-braces. Even with (2) in place, we
//    `stopPropagation` on input/beforeinput/composition*/keydown/
//    mousedown so they don't bubble to CM's contentDOM listener.
//    Defense in depth.
//
// 5. Undo/redo forwarding. Ctrl/Cmd-Z inside the canvas would
//    otherwise hit the contentEditable's per-element history,
//    leaving CM's source out of sync. We blur first (flushing the
//    canvas to source) then redispatch the keydown on CM's
//    contentDOM so the editor's undo stack handles it.
//
// 6. Tab inserts a literal tab character. Verse layouts routinely
//    need indentation and the alternative (focus moves to the next
//    UI control) breaks the open-canvas illusion.
// =====================================================================

const VERSE_MARKUP_META = new Set([
  "\\", "*", "_", "#", "[", "]", "$", "`", "<", ">", "@", "~",
]);

/** Re-dispatch a Ctrl/Cmd-Z or -Y on CM's contentDOM so the editor's
 *  undo stack handles it, rather than the contentEditable's internal
 *  one. The caller should `.blur()` the editable element first so its
 *  pending changes flush to source via the blur listener — otherwise
 *  CM's undo would replay against a stale doc state. */
function forwardUndoRedo(view: EditorView, e: KeyboardEvent): void {
  view.focus();
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
  }));
}

/** Encode a markup chunk (already markup-escaped where needed) into a
 *  Typst string literal — i.e., `\` → `\\`, `"` → `\"`, newline → `\n`. */
function encodeAsStringLiteral(markup: string): string {
  let out = "";
  for (const ch of markup) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return out;
}

/** Encode user-typed text: first escape any markup metacharacter so
 *  Typst's `eval(..., mode: "markup")` treats it literally, then encode
 *  the result for the surrounding string literal. */
function encodeUserText(text: string): string {
  let markup = "";
  for (const ch of text) {
    if (VERSE_MARKUP_META.has(ch)) markup += "\\" + ch;
    else markup += ch;
  }
  return encodeAsStringLiteral(markup);
}

/** Walk the contentEditable DOM, emitting the source-level Typst string
 *  literal contents. Structural inline formatting (`<strong>`, `<em>`,
 *  …) becomes unescaped markup (`*x*`, `_x_`, `#strike[x]`, etc.); text
 *  nodes are escape-laundered through {@link encodeUserText}.
 *
 *  Block boundary handling: browsers wrap line-broken content in `<div>`
 *  or `<p>` after the first Enter (the canvas starts as text + `<br>`s
 *  but Chromium-family contentEditable upgrades the structure once the
 *  user presses Enter). Each block opens with an implicit newline
 *  EXCEPT the first one — `firstBlock` suppresses that lead so the
 *  encoded string doesn't gain a phantom blank line on every save.
 *  We also coalesce consecutive boundaries (skip if the buffer already
 *  ends in `\n`) so user-typed `<br>`s don't double up with the wrapper
 *  block's implicit break.  */
function encodeVerseDOM(canvas: HTMLElement): string {
  const parts: string[] = [];
  let firstBlock = true;
  const blockBoundary = () => {
    if (firstBlock) { firstBlock = false; return; }
    if (parts.length === 0) return;
    const last = parts[parts.length - 1];
    if (!last.endsWith("\\n")) parts.push(encodeAsStringLiteral("\n"));
  };
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(encodeUserText(node.textContent ?? ""));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") { parts.push(encodeAsStringLiteral("\n")); return; }
    if (tag === "DIV" || tag === "P") {
      blockBoundary();
      for (const c of Array.from(el.childNodes)) walk(c);
      return;
    }
    if (tag === "STRONG" || tag === "B") {
      parts.push(encodeAsStringLiteral("*"));
      for (const c of Array.from(el.childNodes)) walk(c);
      parts.push(encodeAsStringLiteral("*"));
      return;
    }
    if (tag === "EM" || tag === "I") {
      parts.push(encodeAsStringLiteral("_"));
      for (const c of Array.from(el.childNodes)) walk(c);
      parts.push(encodeAsStringLiteral("_"));
      return;
    }
    if (tag === "U") {
      parts.push(encodeAsStringLiteral("#underline["));
      for (const c of Array.from(el.childNodes)) walk(c);
      parts.push(encodeAsStringLiteral("]"));
      return;
    }
    if (tag === "S" || tag === "DEL" || tag === "STRIKE") {
      parts.push(encodeAsStringLiteral("#strike["));
      for (const c of Array.from(el.childNodes)) walk(c);
      parts.push(encodeAsStringLiteral("]"));
      return;
    }
    if (tag === "MARK") {
      parts.push(encodeAsStringLiteral("#highlight["));
      for (const c of Array.from(el.childNodes)) walk(c);
      parts.push(encodeAsStringLiteral("]"));
      return;
    }
    // Pass-through for SPAN and other neutral wrappers.
    for (const c of Array.from(el.childNodes)) walk(c);
  };
  for (const c of Array.from(canvas.childNodes)) walk(c);
  return parts.join("");
}

/** Decode the raw between-quotes Typst string literal into the user's
 *  text — i.e., apply `\n`/`\t`/`\r`/`\"`/`\\`/`\u{…}` escapes.
 *  Markup-level escapes (`\*`, `\_`, …) are PRESERVED so the line
 *  renderer can recognize them and emit the literal char without
 *  interpreting it as bold/italic markup. */
export function decodeVerseLiteral(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === "n") { out += "\n"; i += 2; continue; }
      if (next === "t") { out += "\t"; i += 2; continue; }
      if (next === "r") { out += "\r"; i += 2; continue; }
      if (next === '"') { out += '"'; i += 2; continue; }
      if (next === "\\") { out += "\\"; i += 2; continue; }
      if (next === "u" && src[i + 2] === "{") {
        const close = src.indexOf("}", i + 3);
        if (close > i + 2) {
          const hex = src.substring(i + 3, close);
          const cp = parseInt(hex, 16);
          if (!Number.isNaN(cp)) {
            out += String.fromCodePoint(cp);
            i = close + 1;
            continue;
          }
        }
      }
      // Pass through \X for the markup-aware renderer.
      out += src[i] + src[i + 1];
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/** Render one decoded verse line into `parent`, parsing `*bold*`,
 *  `_italic_`, `#strike[…]`/`#highlight[…]`/`#underline[…]`, and `\X`
 *  escapes. Recurses for nested formatting.
 *
 *  This is a deliberately tiny subset parser, not a full Typst markup
 *  parser. The verse body is *constrained* to inline formatting only —
 *  no headings, no lists, no math, no functions other than the three
 *  bracket-content ones above — because the canvas can only present
 *  what HTML can faithfully edit (contentEditable doesn't have a
 *  notion of "headings nested inside a poem"). Anything beyond the
 *  recognized vocabulary is preserved as literal text by `flush()`,
 *  which means the user's source survives a round-trip even if it
 *  contains markup we don't render specially.
 *
 *  Why mirror Typst's emphasis rules (non-whitespace required on the
 *  inside of `*…*` and `_…_`): Typst itself rejects `* foo*` as
 *  emphasis. If we recognized it here, the rendered DOM would show
 *  bold but the compiled output wouldn't — a confusing source/visual
 *  divergence. Easier to refuse it everywhere. */
function renderVerseLine(parent: Element, line: string): void {
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) { parent.appendChild(document.createTextNode(buf)); buf = ""; }
  };
  while (i < line.length) {
    const ch = line[i];
    // \X — literal next character (markup-level escape).
    if (ch === "\\" && i + 1 < line.length) {
      buf += line[i + 1];
      i += 2;
      continue;
    }
    // *…* → bold ; _…_ → italic — but only if a matching close exists
    // on this line and the next char isn't whitespace (Typst's emphasis
    // rules require non-space on the inside).
    if ((ch === "*" || ch === "_") && i + 1 < line.length) {
      const inner = line[i + 1];
      if (inner !== ch && inner !== " " && inner !== "\t") {
        const close = findVerseClose(line, i + 1, ch);
        if (close > i + 1) {
          flush();
          const tag = ch === "*" ? "strong" : "em";
          const el = document.createElement(tag);
          renderVerseLine(el, line.substring(i + 1, close));
          parent.appendChild(el);
          i = close + 1;
          continue;
        }
      }
    }
    // #strike[…] / #highlight[…] / #underline[…] — bracket-content funcs.
    if (ch === "#") {
      const m = line.substring(i).match(/^#(strike|highlight|underline)\[/);
      if (m) {
        const fnName = m[1];
        const bodyStart = i + m[0].length;
        const close = findUnescapedBracketClose(line, bodyStart);
        if (close > bodyStart) {
          flush();
          const tag =
            fnName === "strike" ? "s" :
            fnName === "highlight" ? "mark" :
            "u";
          const el = document.createElement(tag);
          renderVerseLine(el, line.substring(bodyStart, close));
          parent.appendChild(el);
          i = close + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
}

/** Find the next unescaped `marker` after `start`. */
function findVerseClose(line: string, start: number, marker: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") { i += 2; continue; }
    if (line[i] === marker) return i;
    i++;
  }
  return -1;
}

/** Find the matching `]` for a `[` at `start - 1`, respecting nesting
 *  and `\]` escapes. Returns the position of the closing bracket or -1. */
function findUnescapedBracketClose(line: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < line.length) {
    if (line[i] === "\\") { i += 2; continue; }
    if (line[i] === "[") depth++;
    else if (line[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Render the full body (with real newlines) into the canvas as
 *  inline-formatted HTML. */
function renderVerseBody(canvas: HTMLElement, decoded: string): void {
  canvas.replaceChildren();
  const lines = decoded.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) canvas.appendChild(document.createElement("br"));
    renderVerseLine(canvas, lines[i]);
  }
  // Ensure at least one node so the cursor has a landing spot.
  if (canvas.childNodes.length === 0) {
    canvas.appendChild(document.createElement("br"));
  }
}


export type VerseAlign = "left" | "center" | "right";

/** Discrete weight steps offered by the verse pill. Mirrors common
 *  Typst integer weights; matches the wght axis of any variable verse
 *  font and works fine on static fonts that ship Light/Bold faces. */
export type VerseWeight = 300 | 400 | 500 | 600 | 700;
export const VERSE_WEIGHT_DEFAULT: VerseWeight = 400;
export const VERSE_WEIGHT_OPTIONS: ReadonlyArray<{ value: VerseWeight; label: string }> = [
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
];

export interface VerseWidgetOptions {
  /** Raw between-quotes Typst string literal contents (the current source). */
  source: string;
  /** Document offset of the first char inside the quotes. */
  bodyFrom: number;
  /** Document offset of the closing quote (exclusive). */
  bodyTo: number;
  /** Document offset of the entire `#verse(...)` call (for navigation). */
  callFrom: number;
  align: VerseAlign;
  /** Explicit `font:` argument from source, or null to fall back to the
   *  user's editor preference (resolved via CSS var --verse-font). */
  font: string | null;
  /** Explicit `weight:` argument from source, or null to inherit. Only the
   *  five discrete steps in `VERSE_WEIGHT_OPTIONS` are surfaced via the pill,
   *  but a hand-authored value outside that set is preserved as-is in source
   *  (the pill just shows no chip as active). */
  weight: number | null;
}

export class VerseWidget extends WidgetType {
  constructor(readonly opts: VerseWidgetOptions) {
    super();
  }

  eq(other: VerseWidget): boolean {
    return this.opts.source === other.opts.source
      && this.opts.align === other.opts.align
      && this.opts.font === other.opts.font
      && this.opts.weight === other.opts.weight
      && this.opts.bodyFrom === other.opts.bodyFrom
      && this.opts.bodyTo === other.opts.bodyTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-verse";
    wrap.style.textAlign = this.opts.align;
    if (this.opts.font) {
      wrap.style.setProperty("--verse-active-font", this.opts.font);
    }
    if (this.opts.weight !== null) {
      wrap.style.fontWeight = String(this.opts.weight);
    }
    // contentEditable="false" on the wrap marks the widget atomic for
    // CM6's MutationObserver. The inner canvas overrides hierarchically
    // with contentEditable="true" so typing works inside.
    wrap.contentEditable = "false";
    // Body range stamped on the wrap so verseFocusRouter (below) can
    // detect when CM's selection moves into this widget's body — e.g.
    // backspacing from below into existing verse content — and forward
    // focus to the canvas. Without this, the widget DOM is reused
    // (eq() returns true while body bounds are unchanged) so toDOM's
    // focus-routing branch doesn't re-run, and keystrokes go to CM.
    wrap.dataset.bodyFrom = String(this.opts.bodyFrom);
    wrap.dataset.bodyTo = String(this.opts.bodyTo);

    // ── Pill (top-left): identifies the block as verse and opens the
    // super-menu, which includes the alignment options for verse. The
    // pill is the unified PillChip (R1) — same visuals as every other
    // pill in the editor. .cm-typst-verse-pill only positions it.
    const pill = buildPillButton("verse", view, () => ({
      funcName: "verse",
      callFrom: this.opts.callFrom,
      // Verse covers the whole #verse(...) call; for the universal
      // Copy/Duplicate/Delete actions we need the closing paren too.
      callTo: findCallEnd(view, this.opts.callFrom),
      optionSections: this.buildOptionSections(view),
      // The verse canvas IS the editor surface; "Edit source" doesn't
      // apply (the user types directly into the canvas). Suppress it.
      allowEditSource: false,
    }));
    pill.classList.add("cm-typst-verse-pill");
    wrap.appendChild(pill);

    // ── Canvas: contentEditable region with inline formatting rendered.
    const canvas = document.createElement("div");
    canvas.className = "cm-typst-verse-canvas";
    canvas.contentEditable = "true";
    canvas.spellcheck = true;
    renderVerseBody(canvas, decodeVerseLiteral(this.opts.source));

    canvas.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    // Stop input-family events from bubbling to CM's `contentDOM`
    // listener. Defense-in-depth on top of contentEditable=false on
    // the wrap.
    for (const t of ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"] as const) {
      canvas.addEventListener(t, (e) => { e.stopPropagation(); });
    }

    canvas.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const meta = e.ctrlKey || e.metaKey;
      if (meta && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "b") { e.preventDefault(); document.execCommand("bold"); return; }
        if (k === "i") { e.preventDefault(); document.execCommand("italic"); return; }
        if (k === "u") { e.preventDefault(); document.execCommand("underline"); return; }
        // Forward undo/redo to CM6 so it operates on the source
        // document, not the contentEditable's internal history.
        // Mixing the two leaves the widget DOM and the source out of
        // sync, which manifests as "characters appear in weird
        // places, then the widget collapses to source mode" mid-undo.
        // Blur first so the canvas's pending edits flush to source
        // before CM applies the undo.
        if (k === "z" || k === "y") {
          e.preventDefault();
          canvas.blur();
          forwardUndoRedo(view, e);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.execCommand("insertLineBreak");
        return;
      }
      // Tab inside the canvas inserts a real tab character, rather
      // than escaping focus to the next UI control. Verse layouts
      // routinely need indentation — preserving Tab keeps the
      // open-canvas feel honest.
      if (e.key === "Tab") {
        e.preventDefault();
        document.execCommand("insertText", false, "\t");
        return;
      }
    });

    canvas.addEventListener("paste", (e) => {
      // Sanitize pasted content to plain text. Browser-supplied HTML
      // would import attributes that don't round-trip cleanly through
      // the encoder; plain text passes through encodeUserText cleanly.
      const text = e.clipboardData?.getData("text/plain");
      if (text != null) {
        e.preventDefault();
        document.execCommand("insertText", false, text);
      }
    });

    canvas.addEventListener("blur", () => {
      this.flushToSource(canvas, view);
    });

    wrap.appendChild(canvas);

    // Focus routing on insertion: if CM's selection is inside the
    // widget's body range when this widget mounts, the user just
    // inserted /verse (or otherwise positioned the cursor inside
    // the widget). Without this, keystrokes go to CM's contentDOM
    // and land adjacent to the widget — producing scrambled output.
    // Transfer focus to the canvas and place the caret at the end
    // of its content so typing flows into the canvas naturally.
    const sel = view.state.selection.main;
    if (sel.empty && sel.head >= this.opts.bodyFrom && sel.head <= this.opts.bodyTo) {
      queueMicrotask(() => {
        // Re-check after the microtask in case focus already moved
        // somewhere intentional (e.g. the user clicked elsewhere).
        if (!document.body.contains(canvas)) return;
        canvas.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(canvas);
        range.collapse(false);
        const docSel = window.getSelection();
        docSel?.removeAllRanges();
        docSel?.addRange(range);
      });
    }

    return wrap;
  }

  /** Read the canvas DOM, encode to Typst source, and dispatch a
   *  transaction replacing the between-quotes range — but only if the
   *  source actually changed. Recompute body bounds from the live
   *  document because earlier edits elsewhere may have shifted them. */
  private flushToSource(canvas: HTMLElement, view: EditorView): void {
    const next = encodeVerseDOM(canvas);
    if (next === this.opts.source) return;
    const docLen = view.state.doc.length;
    if (this.opts.bodyFrom < 0 || this.opts.bodyTo > docLen
        || this.opts.bodyFrom > this.opts.bodyTo) {
      return;
    }
    const current = view.state.doc.sliceString(this.opts.bodyFrom, this.opts.bodyTo);
    if (current === next) return;
    view.dispatch({
      changes: { from: this.opts.bodyFrom, to: this.opts.bodyTo, insert: next },
    });
  }

  /** Build the verse pill's option sections (R7). Exposes alignment and
   *  weight; future verse-specific options (numbering, leading, font
   *  override) plug in here. */
  private buildOptionSections(view: EditorView): PillMenuSection[] {
    const activeWeight: number = this.opts.weight ?? VERSE_WEIGHT_DEFAULT;
    return [
      {
        heading: "Alignment",
        items: (["left", "center", "right"] as const).map((a) => ({
          label: a,
          isActive: a === this.opts.align,
          onSelect: () => this.setAlign(a, view),
        })),
      },
      {
        heading: "Weight",
        items: VERSE_WEIGHT_OPTIONS.map((w) => ({
          label: w.label,
          isActive: w.value === activeWeight,
          onSelect: () => this.setWeight(w.value, view),
        })),
      },
    ];
  }

  /** Rewrite (or insert) the `align-to:` named argument in the source,
   *  preserving the body string and any other arguments. */
  private setAlign(next: VerseAlign, view: EditorView): void {
    if (next === this.opts.align) return;
    this.rewriteCallArgs(view, (args) => upsertAlignArg(args, next));
  }

  /** Rewrite (or insert) the `weight:` named argument. Setting Regular
   *  (400) drops the arg entirely so the source stays clean — same
   *  policy as alignment's "left" default. */
  private setWeight(next: VerseWeight, view: EditorView): void {
    const current = this.opts.weight ?? VERSE_WEIGHT_DEFAULT;
    if (next === current) return;
    this.rewriteCallArgs(view, (args) => upsertWeightArg(args, next));
  }

  /** Slice out the verse call's argument list, hand it to a rewriter,
   *  and dispatch a CM change with the result. Quote-aware paren matching
   *  avoids treating a `)` inside the body literal as the call's close. */
  private rewriteCallArgs(view: EditorView, rewrite: (args: string) => string): void {
    const callFrom = this.opts.callFrom;
    const docText = view.state.doc.sliceString(
      callFrom,
      Math.min(callFrom + 100000, view.state.doc.length),
    );
    const openParen = docText.indexOf("(");
    if (openParen < 0) return;
    let depth = 0;
    let inStr = false;
    let close = -1;
    for (let i = openParen; i < docText.length; i++) {
      const ch = docText[i];
      if (ch === '"' && (i === 0 || docText[i - 1] !== "\\")) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) return;
    const argsText = docText.substring(openParen + 1, close);
    const newArgsText = rewrite(argsText);
    if (newArgsText === argsText) return;
    view.dispatch({
      changes: {
        from: callFrom + openParen + 1,
        to: callFrom + close,
        insert: newArgsText,
      },
    });
  }

  ignoreEvent(): boolean {
    // Let the contentEditable own its own input loop; CM resyncs on
    // blur via {@link flushToSource}. See the class header for why.
    return true;
  }
}

/** Add or replace the `align-to:` named arg in a verse argument list,
 *  preserving the leading body string and any other named args. */
function upsertAlignArg(argsText: string, align: VerseAlign): string {
  const re = /(,\s*align-to\s*:\s*)(left|center|right)/;
  if (re.test(argsText)) {
    if (align === "left") {
      // Drop the arg entirely — left is the default, keep source clean.
      return argsText.replace(/,\s*align-to\s*:\s*(left|center|right)/, "");
    }
    return argsText.replace(re, `$1${align}`);
  }
  if (align === "left") return argsText;
  // Append after the existing arguments. Trim trailing whitespace so the
  // separator lands cleanly.
  return `${argsText.replace(/\s+$/, "")}, align-to: ${align}`;
}

/** Add or replace the `weight:` named arg in a verse argument list.
 *  Matches integer values (set by the pill) and named strings like
 *  `"bold"` (hand-authored) so an existing literal isn't duplicated.
 *  Setting Regular (400) drops the arg entirely. */
function upsertWeightArg(argsText: string, weight: VerseWeight): string {
  const existing = /,\s*weight\s*:\s*(?:\d+|"[^"]*")/;
  if (existing.test(argsText)) {
    if (weight === VERSE_WEIGHT_DEFAULT) {
      return argsText.replace(existing, "");
    }
    return argsText.replace(existing, `, weight: ${weight}`);
  }
  if (weight === VERSE_WEIGHT_DEFAULT) return argsText;
  return `${argsText.replace(/\s+$/, "")}, weight: ${weight}`;
}

export class FootnoteWidget extends WidgetType {
  constructor(readonly content: string) {
    super();
  }

  eq(other: FootnoteWidget) {
    return this.content === other.content;
  }

  toDOM() {
    const sup = document.createElement("sup");
    sup.className = "cm-typst-footnote";
    sup.textContent = "*";
    sup.title = this.content;
    return sup;
  }

  ignoreEvent() { return false; }
}

export class BlockquoteWidget extends WidgetType {
  constructor(
    readonly content: string,
    readonly attribution: string,
  ) {
    super();
  }

  eq(other: BlockquoteWidget) {
    return this.content === other.content && this.attribution === other.attribution;
  }

  toDOM() {
    const wrap = document.createElement("blockquote");
    wrap.className = "cm-typst-blockquote";

    const text = document.createElement("div");
    text.className = "cm-typst-blockquote-text";
    renderTypstBody(this.content, text);
    wrap.appendChild(text);

    if (this.attribution) {
      const attr = document.createElement("div");
      attr.className = "cm-typst-blockquote-attr";
      attr.textContent = `— ${this.attribution}`;
      wrap.appendChild(attr);
    }

    return wrap;
  }

  ignoreEvent(e: Event) {
    if (e.type === "mousedown") {
      return !!(e.target as HTMLElement).closest(".cm-typst-wikilink");
    }
    return false;
  }
}

export class CalloutBlockWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly title: string,
    readonly bodyText: string,
    readonly pos: number,
    readonly withPill: boolean,
  ) {
    super();
  }

  eq(other: CalloutBlockWidget) {
    return this.kind === other.kind && this.title === other.title
      && this.bodyText === other.bodyText && this.pos === other.pos
      && this.withPill === other.withPill;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-callout-block";
    wrap.style.overflow = "hidden";
    this.renderContent(wrap, view);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    dom.innerHTML = "";
    this.renderContent(dom, view);
    return true;
  }

  private renderContent(wrap: HTMLElement, view: EditorView) {
    if (this.withPill) wrap.appendChild(makeBlockPillRow("callout", this.pos, view));

    const color = CALLOUT_COLORS[this.kind] ?? CALLOUT_COLORS.note;
    const inner = document.createElement("div");
    inner.className = "cm-typst-callout";
    inner.style.borderLeftColor = color;
    inner.style.backgroundColor = `color-mix(in srgb, ${color} 8%, transparent)`;

    const heading = document.createElement("div");
    heading.className = "cm-typst-callout-heading";
    heading.style.color = color;
    heading.textContent = this.title || this.kind.charAt(0).toUpperCase() + this.kind.slice(1);
    inner.appendChild(heading);

    if (this.bodyText) {
      const body = document.createElement("div");
      body.className = "cm-typst-callout-body";
      renderTypstBody(this.bodyText, body);
      inner.appendChild(body);
    }

    wrap.appendChild(inner);
  }

  ignoreEvent(e: Event) {
    if (e.type === "mousedown") {
      return !!(e.target as HTMLElement).closest(".cm-typst-wikilink");
    }
    return false;
  }
}

// An annotation (`#annotation[…]`). Renders as a tinted block — the
// visual-editor sibling of CalloutBlockWidget — so an annotation stays
// visually distinct from body text even when the cursor is away, matching how
// lib.typ renders it in the reading view. Reuses the callout block CSS with
// the annotation accent set inline.
export class AnnotationBlockWidget extends WidgetType {
  constructor(
    readonly bodyText: string,
    readonly by: string,
    readonly on: string,
    readonly pos: number,
    readonly withPill: boolean,
  ) {
    super();
  }

  eq(other: AnnotationBlockWidget) {
    return this.bodyText === other.bodyText && this.by === other.by
      && this.on === other.on && this.pos === other.pos
      && this.withPill === other.withPill;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-callout-block";
    wrap.style.overflow = "hidden";
    this.renderContent(wrap, view);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    dom.innerHTML = "";
    this.renderContent(dom, view);
    return true;
  }

  private renderContent(wrap: HTMLElement, view: EditorView) {
    if (this.withPill) wrap.appendChild(makeBlockPillRow("annotation", this.pos, view));

    const inner = document.createElement("div");
    inner.className = "cm-typst-callout";
    inner.style.borderLeftColor = ANNOTATION_COLOR;
    inner.style.backgroundColor = `color-mix(in srgb, ${ANNOTATION_COLOR} 8%, transparent)`;

    const heading = document.createElement("div");
    heading.className = "cm-typst-callout-heading";
    heading.style.color = ANNOTATION_COLOR;
    const attribution = [this.by, this.on].filter(Boolean).join(" · ");
    heading.textContent = attribution ? `Annotation — ${attribution}` : "Annotation";
    inner.appendChild(heading);

    if (this.bodyText) {
      const body = document.createElement("div");
      body.className = "cm-typst-callout-body";
      renderTypstBody(this.bodyText, body);
      inner.appendChild(body);
    }

    wrap.appendChild(inner);
  }

  ignoreEvent(e: Event) {
    if (e.type === "mousedown") {
      return !!(e.target as HTMLElement).closest(".cm-typst-wikilink");
    }
    return false;
  }
}

export class BlockquoteBlockWidget extends WidgetType {
  constructor(
    readonly content: string,
    readonly attribution: string,
    readonly pos: number,
    readonly withPill: boolean,
  ) {
    super();
  }

  eq(other: BlockquoteBlockWidget) {
    return this.content === other.content && this.attribution === other.attribution
      && this.pos === other.pos && this.withPill === other.withPill;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-blockquote-block";
    wrap.style.overflow = "hidden";
    this.renderContent(wrap, view);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    dom.innerHTML = "";
    this.renderContent(dom, view);
    return true;
  }

  private renderContent(wrap: HTMLElement, view: EditorView) {
    if (this.withPill) wrap.appendChild(makeBlockPillRow("quote", this.pos, view));

    const inner = document.createElement("blockquote");
    inner.className = "cm-typst-blockquote";

    const text = document.createElement("div");
    text.className = "cm-typst-blockquote-text";
    renderTypstBody(this.content, text);
    inner.appendChild(text);

    if (this.attribution) {
      const attr = document.createElement("div");
      attr.className = "cm-typst-blockquote-attr";
      attr.textContent = `— ${this.attribution}`;
      inner.appendChild(attr);
    }

    wrap.appendChild(inner);
  }

  ignoreEvent(e: Event) {
    if (e.type === "mousedown") {
      return !!(e.target as HTMLElement).closest(".cm-typst-wikilink");
    }
    return false;
  }
}

// Bibliography is a non-editable region in visual mode by default — it's a
// declarative directive rather than flowing prose. Rather than hiding the
// line entirely (which would leave no signal that a bibliography exists),
// we render a pill placeholder. The pill opens the universal super-menu,
// from which the user can edit source, switch to source mode, or copy/
// duplicate/delete the call.
export class BibliographyBlockWidget extends WidgetType {
  constructor(readonly path: string, readonly pos: number) { super(); }

  eq(other: BibliographyBlockWidget) {
    return this.path === other.path && this.pos === other.pos;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-bibliography-block";
    wrap.appendChild(buildPillButton("bibliography", view, () => ({
      funcName: "bibliography",
      callFrom: this.pos,
      callTo: findCallEnd(view, this.pos),
    })));
    return wrap;
  }

  ignoreEvent() { return true; }
}

export class LinkWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly display: string,
  ) {
    super();
  }

  eq(other: LinkWidget) {
    return this.url === other.url && this.display === other.display;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-typst-link";
    el.style.cursor = "pointer";
    el.title = this.url;

    const text = document.createElement("span");
    text.textContent = this.display || this.url;
    el.appendChild(text);

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("width", "12");
    icon.setAttribute("height", "12");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.classList.add("cm-typst-link-external-icon");
    icon.innerHTML = // static-only
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/>' +
      '<line x1="10" y1="14" x2="21" y2="3"/>';
    el.appendChild(icon);

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openLink(this.url);
    });
    return el;
  }

  ignoreEvent() { return true; }
}

export class CitationWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly refFrom: number = 0,
    readonly refTo: number = 0,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return other instanceof CitationWidget
      && this.key === other.key
      && this.refFrom === other.refFrom
      && this.refTo === other.refTo;
  }

  toDOM(view: EditorView) {
    const pill = document.createElement("span");
    pill.className = "cm-typst-citation";
    pill.textContent = `@${this.key}`;

    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCiteContextMenu(pill, view, this.key, this.refFrom, this.refTo);
    });

    return pill;
  }

  ignoreEvent(e: Event) {
    return e.type === "contextmenu";
  }
}

function showCiteContextMenu(
  anchor: HTMLElement,
  view: EditorView,
  key: string,
  from: number,
  to: number,
) {
  const currentSrc = view.state.doc.sliceString(from, Math.min(to, view.state.doc.length));
  if (!currentSrc.startsWith("@")) return;

  document.querySelectorAll(".cm-typst-pill-menu").forEach((m) => m.remove());

  const menu = document.createElement("div");
  menu.className = "cm-typst-pill-menu";
  menu.setAttribute("role", "menu");

  const item = document.createElement("button");
  item.type = "button";
  item.className = "cm-typst-pill-menu-item";
  item.addEventListener("click", (e) => {
    e.preventDefault();
    menu.remove();
    const replacement = `#cite(<${key}>)`;
    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
    });
    view.focus();
  });
  const label = document.createElement("span");
  label.className = "cm-typst-pill-menu-label";
  label.textContent = "Convert to advanced citation";
  item.appendChild(label);
  menu.appendChild(item);

  view.dom.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const editorRect = view.dom.getBoundingClientRect();
  menu.style.position = "absolute";
  menu.style.left = `${rect.left - editorRect.left}px`;
  menu.style.top = `${rect.bottom - editorRect.top + 4}px`;

  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", close, true);
    }
  };
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      menu.remove();
      document.removeEventListener("keydown", closeOnEscape, true);
      view.focus();
    }
  };
  document.addEventListener("mousedown", close, true);
  document.addEventListener("keydown", closeOnEscape, true);
}

/** Route focus into a verse canvas whenever CM's logical cursor moves
 *  into a verse body range. Complements VerseWidget.toDOM's mount-time
 *  focus routing: that branch only fires on widget construction, but
 *  if the user backspaces from below into an existing verse, the
 *  widget DOM is reused (eq() returns true while bodyFrom/bodyTo
 *  haven't shifted), so toDOM doesn't re-run — yet CM's selection has
 *  entered the body range. Without this plugin, keystrokes go to CM's
 *  contentDOM instead of the canvas, producing reverse-typing /
 *  caret-at-edge symptoms documented in CLAUDE.md (CM6 widget recipe). */
export const verseFocusRouter = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return;
      const sel = update.state.selection.main;
      const lo = Math.min(sel.anchor, sel.head);
      const hi = Math.max(sel.anchor, sel.head);
      const view = update.view;
      // Defer the DOM scan: when a verse is just inserted, ViewPlugin
      // `update` fires before CM flushes the new widget DOM, so an
      // immediate querySelector wouldn't find it. queueMicrotask runs
      // after the current task finishes (including CM's DOM write) but
      // before paint.
      queueMicrotask(() => {
        const wraps = view.dom.querySelectorAll<HTMLElement>(".cm-typst-verse");
        for (const wrap of wraps) {
          const from = Number(wrap.dataset.bodyFrom);
          const to = Number(wrap.dataset.bodyTo);
          if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
          // Selection (point or range) must lie entirely within this
          // verse's body. Toolbar-wrap-around-selection produces a range;
          // backspace-into-verse and slash-insert produce a point — both
          // flow here.
          if (lo < from || hi > to) continue;
          const canvas = wrap.querySelector<HTMLElement>(".cm-typst-verse-canvas");
          if (!canvas) return;
          if (document.activeElement === canvas) return;
          canvas.focus({ preventScroll: true });
          const range = document.createRange();
          range.selectNodeContents(canvas);
          // Empty source selection → caret at end; non-empty (wrap-around)
          // → select the canvas contents so the user can immediately
          // continue typing/formatting over their original text.
          if (lo === hi) range.collapse(false);
          const docSel = window.getSelection();
          docSel?.removeAllRanges();
          docSel?.addRange(range);
          return;
        }
      });
    }
  },
);
