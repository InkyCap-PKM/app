import { type EditorView, WidgetType, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getSearchQuery, setSearchQuery } from "@codemirror/search";
import { openLink } from "../../lib/open-link";
import { loadImageObjectUrl, loadMediaObjectUrl, revokeBlobUrls } from "../../lib/media-src";
import { highlightCodeInto } from "./code-highlight";
import { buildPillButton, findCallEnd, applyCallTransform, upsertNamedArg, type PillMenuSection } from "./pill";
import { getPillOptions } from "./pill-options";
import { showWikilinkContextMenu } from "../../lib/wikilink-nav";
import { anchorPanelMenu } from "../../lib/uiMenu";
import { buildSuggestionCall } from "./annotation-insert";
import { parseInlineBody, type BodySegment } from "./block-body-parse";
import { findLabelDefinition } from "./label-nav";
import { t } from "../../lib/i18n";
import { calloutKindLabel } from "./pill-options";

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

/** Resolve the document offset of the `#image(...)` call backing an image
 *  widget anchored at `pos`. A bare image is anchored at its own `#image`;
 *  an alignment-wrapped image (`#align(kw)[#image(...)]`) is anchored at the
 *  `#align`, so we step inward to the `#image` whose `width:` we want to edit.
 *  Mirrors the inner-image resolution in `imageOptions` so drag-resize and the
 *  pill's Width field write to the same argument. */
function resolveImageCallFrom(view: EditorView, pos: number): number {
  const liveTo = findCallEnd(view, pos);
  const src = view.state.doc.sliceString(pos, liveTo);
  if (/^\s*#align\b/.test(src)) {
    const idx = src.indexOf("#image");
    if (idx >= 0) return pos + idx;
  }
  return pos;
}

// Round a fraction of the text column to a whole-percent width, clamped to a
// sane authoring range. Typst's `image(width: …)` accepts a ratio, and a
// percentage is the resolution-independent, WYSIWYM-friendly unit — it scales
// to the page's text column the same way the editor preview scales to its own
// content width (CLAUDE.md: the visual editor is an authoring tool, not a
// pixel-faithful renderer).
function fractionToPercent(width: number, reference: number): number {
  if (reference <= 0) return 100;
  return Math.max(5, Math.min(100, Math.round((width / reference) * 100)));
}

/** Attach a hover-revealed corner handle that resizes an image by dragging.
 *
 *  Width-only by design: Typst scales the unconstrained axis proportionally
 *  and the widgets already set `height: auto` when only width is present, so a
 *  single handle gives aspect-locked resizing for free. During the drag we
 *  update the `<img>` width in pixels for smooth feedback and pin the
 *  alignment container to the left so the handle tracks the cursor regardless
 *  of centre/right alignment; on release we convert to a percentage and write
 *  it through `applyCallTransform` + `upsertNamedArg` — the same source-mutation
 *  path the pill's Width field uses, so the source ↔ visual round-trip
 *  invariant (R11) holds. Nothing is dispatched mid-drag (per the CM6 widget
 *  recipe: sync the source once when the gesture ends, never per input event). */
function attachImageResize(
  view: EditorView,
  holder: HTMLElement,
  img: HTMLImageElement,
  callFromAt: () => number,
): void {
  const handle = document.createElement("div");
  handle.className = "cm-typst-image-resize-handle";
  handle.title = t("widget.image.resizeHint");

  const badge = document.createElement("div");
  badge.className = "cm-typst-image-size-badge";

  let dragging = false;
  let startX = 0;
  let startW = 0;
  let refW = 0;
  let pct = 100;
  let alignEl: HTMLElement | null = null;
  let savedAlign = "";

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const min = Math.max(24, refW * 0.05);
    const w = Math.max(min, Math.min(startW + (e.clientX - startX), refW));
    pct = fractionToPercent(w, refW);
    img.style.width = `${w}px`;
    img.style.height = "auto";
    img.style.maxWidth = "none";
    img.style.maxHeight = "none";
    badge.textContent = `${pct}%`;
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    holder.classList.remove("is-resizing");
    if (alignEl) alignEl.style.textAlign = savedAlign;
    applyCallTransform(view, callFromAt(), (s) => upsertNamedArg(s, "width", `${pct}%`));
    view.focus();
  };

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = img.getBoundingClientRect();
    startX = e.clientX;
    startW = rect.width;
    // Reference width = the content column the image lays out within. The
    // block/inline image container spans that column, so its client width is
    // the right base for the percentage.
    refW = holder.parentElement?.clientWidth || rect.width;
    // Pin the alignment container left so the dragged right edge tracks the
    // cursor 1:1 instead of growing symmetrically away from a centre anchor.
    alignEl = holder.parentElement;
    if (alignEl) { savedAlign = alignEl.style.textAlign; alignEl.style.textAlign = "left"; }
    pct = fractionToPercent(startW, refW);
    badge.textContent = `${pct}%`;
    dragging = true;
    holder.classList.add("is-resizing");
    handle.setPointerCapture?.(e.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });

  // Defense in depth: keep the raw mouse-family events that pair with the
  // pointer drag from reaching CodeMirror's selection handling.
  handle.addEventListener("mousedown", (e) => e.stopPropagation());
  handle.addEventListener("click", (e) => e.stopPropagation());

  holder.appendChild(handle);
  holder.appendChild(badge);
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




function buildWikilinkSpan(target: string, display: string): HTMLElement {
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
  return link;
}

/** Build a tag pill (`<span class="cm-typst-tag">`) prefixed with a Lucide
 *  `tag` icon rather than a literal `#`. The hash is Typst syntax, not part of
 *  the tag name, so showing the icon reads as "tag" in InkyCap's context. Shared
 *  by TagWidget and the block-body renderer so both sites stay identical. */
function buildTagPill(name: string): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "cm-typst-tag";

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("width", "12");
  icon.setAttribute("height", "12");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.classList.add("cm-typst-tag-icon");
  icon.innerHTML = // static-only
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>' +
    '<circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>';
  pill.appendChild(icon);

  const label = document.createElement("span");
  label.textContent = name;
  pill.appendChild(label);

  return pill;
}

/** Build an interactive external-link span for a rendered block body. Mirrors
 *  LinkWidget's behaviour (pointer cursor, mousedown → openLink) and stops the
 *  event from reaching CM so the click opens the URL instead of dropping the
 *  block into source-edit mode. Without the handler the span is inert and a
 *  click inside the callout just enters edit mode. */
function buildLinkSpan(url: string, display: string): HTMLElement {
  const a = document.createElement("span");
  a.className = "cm-typst-link";
  a.style.cursor = "pointer";
  a.textContent = display || url;
  a.title = url;
  a.addEventListener("mousedown", (e) => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    void openLink(url);
  });
  return a;
}

/** Optional context that makes a block body's inline elements interactive.
 *  `bodyFrom` is the absolute document offset where the body string begins, so
 *  a segment's in-body `start` resolves to a real source position. */
type BlockBodyContext = { view: EditorView; bodyFrom: number };

/** Build a task checkbox + body whose checkbox toggles the call's `done:`
 *  argument in source. Mirrors TaskWidget; used inside rendered block bodies so
 *  a task is checkable without first entering edit mode. The owning widget's
 *  `ignoreEvent` must let the checkbox's mousedown through (return true) so CM
 *  doesn't also place the cursor / enter edit mode. */
function buildTaskSpan(
  seg: Extract<BodySegment, { kind: "task" }>,
  ctx: BlockBodyContext | undefined,
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "cm-typst-task";
  if (seg.done) wrap.classList.add("cm-typst-task--done");

  const box = document.createElement("span");
  box.className = "cm-typst-task__box";
  box.textContent = seg.done ? "☑" : "☐";
  if (ctx) {
    const callFrom = ctx.bodyFrom + seg.start;
    box.title = seg.done ? t("task.markNotDone") : t("task.markDone");
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyCallTransform(ctx.view, callFrom, (s) =>
        upsertNamedArg(s, "done", seg.done ? "false" : "true", { defaultValue: "false" }),
      );
    });
  }
  wrap.appendChild(box);

  const label = document.createElement("span");
  label.className = "cm-typst-task__body";
  label.textContent = seg.body;
  wrap.appendChild(label);

  if (seg.due) {
    const badge = document.createElement("span");
    badge.className = "cm-typst-task__due";
    badge.textContent = seg.due;
    wrap.appendChild(badge);
  }
  return wrap;
}

/** Render a block body string (callout / quote / annotation preview), turning
 *  recognized inline notebox primitives into their semantic elements while
 *  leaving everything else as plain text. Parsing lives in block-body-parse.ts;
 *  here we only build DOM, reusing the same classes as the standalone inline
 *  widgets (TaskWidget, TagWidget, …) so a task inside a callout looks identical
 *  to one in flowing text. With `ctx`, a task's checkbox toggles `done` in place
 *  and wikilinks navigate; without it everything is inert preview. */
/** Drop the backslash from Typst inline escapes (`\*`, `\#`, `\[`, …) so the
 *  escaped character shows literally — the parser leaves the `\` in text runs. */
function unescapeInline(text: string): string {
  return text.replace(/\\([*_#`[\]()\\])/g, "$1");
}

function renderTypstBody(text: string, parent: HTMLElement, ctx?: BlockBodyContext) {
  appendBodySegments(parseInlineBody(text), parent, ctx);
}

/** Render parsed block-body segments into `parent`. Recurses through `format`
 *  wrappers so nested markup (`#highlight[a *b*]`) renders. */
function appendBodySegments(segs: BodySegment[], parent: HTMLElement, ctx?: BlockBodyContext) {
  for (const seg of segs) {
    switch (seg.kind) {
      case "text":
        parent.appendChild(document.createTextNode(unescapeInline(seg.text)));
        break;
      case "wikilink":
        parent.appendChild(buildWikilinkSpan(seg.target, seg.display));
        break;
      case "tag":
        parent.appendChild(buildTagPill(seg.name));
        break;
      case "link":
        parent.appendChild(buildLinkSpan(seg.url, seg.display));
        break;
      case "task":
        parent.appendChild(buildTaskSpan(seg, ctx));
        break;
      case "raw": {
        if (seg.block) {
          const pre = document.createElement("pre");
          pre.className = "cm-typst-raw-block";
          const code = document.createElement("code");
          code.textContent = seg.text;
          pre.appendChild(code);
          parent.appendChild(pre);
        } else {
          const code = document.createElement("span");
          code.className = "cm-typst-raw-inline";
          code.textContent = seg.text;
          parent.appendChild(code);
        }
        break;
      }
      case "format": {
        const span = document.createElement("span");
        span.className = seg.className;
        appendBodySegments(seg.children, span, ctx);
        parent.appendChild(span);
        break;
      }
      case "list": {
        const list = document.createElement(seg.ordered ? "ol" : "ul");
        list.className = "cm-typst-body-list";
        for (const item of seg.items) {
          const li = document.createElement("li");
          appendBodySegments(item, li, ctx);
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
    }
  }
}

/** Shared `ignoreEvent` for rendered block bodies (callout / quote / annotation).
 *  A mousedown on an interactive child — a wikilink or a task checkbox — is
 *  handled by that child, so CM must ignore it (return true) and not also place
 *  the cursor inside the block, which would drop it into source-edit mode. Any
 *  other click falls through (return false) so clicking the body still enters
 *  edit mode as expected. */
function blockBodyIgnoreEvent(e: Event): boolean {
  if (e.type !== "mousedown") return false;
  return !!(e.target as HTMLElement).closest(
    ".cm-typst-wikilink, .cm-typst-link, .cm-typst-task__box",
  );
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
    heading.textContent = calloutKindLabel(this.kind, this.title);
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
    copyBtn.title = t("widget.codeBlock.copy");
    copyBtn.setAttribute("aria-label", t("widget.codeBlock.copy"));
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
          copyBtn.title = t("widget.codeBlock.copied");
          setTimeout(() => {
            copyBtn.classList.remove("is-copied");
            copyBtn.title = t("widget.codeBlock.copy");
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
    loadImageObjectUrl(imgPath).then((url) => {
      // The widget may have been torn down while the bytes were in flight;
      // don't leak the blob URL or touch a detached DOM.
      if (!url || !document.body.contains(wrap)) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      const img = document.createElement("img");
      img.className = "cm-typst-image-img";
      img.alt = this.alt ?? imgPath;
      img.src = url;
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

  destroy(dom: HTMLElement) {
    revokeBlobUrls(dom);
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
    revokeBlobUrls(dom);
    dom.innerHTML = "";
    this.renderContent(dom, view);
    return true;
  }

  destroy(dom: HTMLElement) {
    revokeBlobUrls(dom);
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
    loadImageObjectUrl(imgPath).then((url) => {
      // Bail (and free the blob) if the widget was replaced while the bytes
      // were loading.
      if (!url || !document.body.contains(wrap)) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      // The holder is an inline-block wrapper so (a) the resize handle can be
      // absolutely positioned over the image's corner and (b) `inner`'s
      // text-align governs left/centre/right placement of the whole image
      // without per-margin overrides.
      const holder = document.createElement("div");
      holder.className = "cm-typst-image-holder";

      const img = document.createElement("img");
      img.className = "cm-typst-image-img";
      img.alt = this.alt ?? imgPath;
      img.src = url;
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

      holder.appendChild(img);
      attachImageResize(view, holder, img, () => resolveImageCallFrom(view, this.pos));
      inner.insertBefore(holder, label);
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
    revokeBlobUrls(dom);
    dom.innerHTML = "";
    this.renderContent(dom, view);
    return true;
  }

  destroy(dom: HTMLElement) {
    revokeBlobUrls(dom);
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
    return buildTagPill(this.name);
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
    box.title = this.done ? t("task.markNotDone") : t("task.markDone");
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

/** Render a suggestion body's text into `el`, interpreting Typst hard line
 *  breaks (a `\` followed by whitespace or end-of-text) as actual line breaks
 *  rather than showing a stray backslash, and collapsing literal newlines to
 *  spaces (Typst treats a single newline as a space within a paragraph). This is
 *  display-only — the source is never touched — so the widget reads as the text
 *  the suggestion proposes, not its raw markup. (A literal escaped `\\` is the
 *  rare case this simple split doesn't special-case; acceptable for a WYSIWYM
 *  affordance that is not a faithful renderer.) Exported for unit testing. */
export function typstInlineSegments(txt: string): string[] {
  return txt
    .split(/\\(?=\s|$)/)
    .map((seg) => seg.replace(/\s*\n\s*/g, " "));
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

  /** Human label for the suggestion's kind, localized. */
  private kindLabel(): string {
    return this.kind === "insert"
      ? t("suggestion.kind.insert")
      : this.kind === "delete"
        ? t("suggestion.kind.delete")
        : t("suggestion.kind.replace");
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
      // Render Typst hard line breaks as actual breaks instead of a literal "\".
      const segments = typstInlineSegments(txt);
      segments.forEach((seg, i) => {
        if (i > 0) s.appendChild(document.createElement("br"));
        s.appendChild(document.createTextNode(seg));
      });
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

    const attr = this.attribution();
    const noteSuffix = this.note.trim()
      ? `\n${t("suggestion.commentPrefix")} ${this.note.trim()}`
      : "";
    wrap.title = t("suggestion.widgetTitle", { kind: this.kindLabel() })
      + (attr ? ` ${t("suggestion.byAttribution", { who: attr })}` : "")
      + noteSuffix;

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
    p.kind === "insert"
      ? t("suggestion.kind.insert")
      : p.kind === "delete"
        ? t("suggestion.kind.delete")
        : t("suggestion.kind.replace");
  const attr = [p.by, p.on].filter(Boolean).join(" · ");

  const menu = document.createElement("div");
  menu.className = "cm-suggestion-menu";

  const header = document.createElement("div");
  header.className = "cm-suggestion-menu__header";
  header.textContent = attr ? `${kindLabel} · ${attr}` : kindLabel;
  menu.appendChild(header);

  // Comment — pre-filled with the suggestion's saved `note` so reopening the
  // menu shows the existing remark. "Save comment" persists it onto the open
  // suggestion (visible in the doc + Annotations pane). Accept/Reject resolve
  // the change and DISCARD the comment along with the suggestion mark: once the
  // change is decided, the review-conversation note is moot, so resolving leaves
  // only the clean result. The proposed text itself is edited inline by expanding
  // the pill (the marks can run to many paragraphs — too big for this popup).
  const comment = document.createElement("textarea");
  comment.className = "cm-suggestion-menu__comment";
  comment.rows = 2;
  comment.placeholder = t("suggestion.menu.commentPlaceholder");
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
  saveBtn.textContent = t("suggestion.menu.saveComment");
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
      const text = suggestionResolution(p, accept);
      applyCallTransform(view, p.from, () => text);
      closeSuggestionMenu();
      view.focus();
    });
    row.appendChild(b);
  };
  mkBtn(t("suggestion.menu.accept"), "is-accept", true);
  mkBtn(t("suggestion.menu.reject"), "is-reject", false);
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
    readonly label: string = "",
    readonly exists: boolean = true,
  ) {
    super();
  }

  eq(other: WikilinkWidget) {
    return this.target === other.target && this.display === other.display
      && this.isBold === other.isBold && this.isItalic === other.isItalic
      && this.isStrike === other.isStrike && this.isHighlight === other.isHighlight
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
    // Note: when this wikilink sits inside a heading, the heading mark
    // already wraps this widget in a `cm-typst-h*` span, so it inherits
    // the heading's font-size and weight. Adding the heading class here
    // too would compound the `em`-based size (e.g. 1.8em × 1.8em),
    // rendering the link larger than the surrounding heading text.

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
      // Drop any search-match highlight before the click places the caret, so
      // the user starts editing on clean DOM (the spans are pass-through and
      // never corrupt source, but clearing first keeps the caret honest).
      clearVerseHits(canvas);
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
    // `view.hasFocus` gate: only pull focus into the canvas when the editor
    // content itself is focused. When a panel owns focus — most notably the
    // Ctrl+F search field, whose `findNext` moves the selection into matches
    // anywhere in the doc — stealing focus here would route the user's typing
    // into the verse and overwrite it. The panel input is in `view.dom` but
    // not `contentDOM`, so `hasFocus` is false while it's active.
    const sel = view.state.selection.main;
    if (
      view.hasFocus &&
      sel.empty &&
      sel.head >= this.opts.bodyFrom &&
      sel.head <= this.opts.bodyTo
    ) {
      queueMicrotask(() => {
        // Re-check after the microtask in case focus already moved
        // somewhere intentional (e.g. the user clicked elsewhere).
        if (!document.body.contains(canvas)) return;
        if (!view.hasFocus) return;
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
    readonly bodyFrom: number,
  ) {
    super();
  }

  eq(other: CalloutBlockWidget) {
    return this.kind === other.kind && this.title === other.title
      && this.bodyText === other.bodyText && this.pos === other.pos
      && this.withPill === other.withPill && this.bodyFrom === other.bodyFrom;
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
    heading.textContent = calloutKindLabel(this.kind, this.title);
    inner.appendChild(heading);

    if (this.bodyText) {
      const body = document.createElement("div");
      body.className = "cm-typst-callout-body";
      renderTypstBody(this.bodyText, body, { view, bodyFrom: this.bodyFrom });
      inner.appendChild(body);
    }

    wrap.appendChild(inner);
  }

  ignoreEvent(e: Event) {
    return blockBodyIgnoreEvent(e);
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
    readonly bodyFrom: number,
  ) {
    super();
  }

  eq(other: AnnotationBlockWidget) {
    return this.bodyText === other.bodyText && this.by === other.by
      && this.on === other.on && this.pos === other.pos
      && this.withPill === other.withPill && this.bodyFrom === other.bodyFrom;
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
    heading.textContent = attribution
      ? t("widget.annotation.labelBy", { name: attribution })
      : t("widget.annotation.label");
    inner.appendChild(heading);

    if (this.bodyText) {
      const body = document.createElement("div");
      body.className = "cm-typst-callout-body";
      renderTypstBody(this.bodyText, body, { view, bodyFrom: this.bodyFrom });
      inner.appendChild(body);
    }

    wrap.appendChild(inner);
  }

  ignoreEvent(e: Event) {
    return blockBodyIgnoreEvent(e);
  }
}

export class BlockquoteBlockWidget extends WidgetType {
  constructor(
    readonly content: string,
    readonly attribution: string,
    readonly pos: number,
    readonly withPill: boolean,
    readonly bodyFrom: number,
  ) {
    super();
  }

  eq(other: BlockquoteBlockWidget) {
    return this.content === other.content && this.attribution === other.attribution
      && this.pos === other.pos && this.withPill === other.withPill
      && this.bodyFrom === other.bodyFrom;
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
    renderTypstBody(this.content, text, { view, bodyFrom: this.bodyFrom });
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
    return blockBodyIgnoreEvent(e);
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
    readonly isBold: boolean = false,
    readonly isItalic: boolean = false,
    readonly isStrike: boolean = false,
    readonly isHighlight: boolean = false,
  ) {
    super();
  }

  eq(other: LinkWidget) {
    return this.url === other.url && this.display === other.display
      && this.isBold === other.isBold && this.isItalic === other.isItalic
      && this.isStrike === other.isStrike && this.isHighlight === other.isHighlight;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-typst-link";
    // A replace widget is rendered outside any surrounding mark decoration, so
    // bold/italic/etc. wrapping the call (`*#link(...)[…]*`) would be lost. Carry
    // the formatting flags and apply the same classes the marks would have.
    if (this.isBold) el.classList.add("cm-typst-bold");
    if (this.isItalic) el.classList.add("cm-typst-italic");
    if (this.isStrike) el.classList.add("cm-typst-strike");
    if (this.isHighlight) el.classList.add("cm-typst-highlight");
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

/** A `#link(<label>)[text]` internal cross-reference — its destination is a
 *  Typst label (an anchor next to a heading, etc.) rather than a URL. The
 *  string-URL form is `LinkWidget`; this renders the same way but, on click,
 *  jumps the editor to where the `<label>` is defined in this note instead of
 *  opening anything externally. Without this the call fell through to raw
 *  source, showing `#link(<label>)[…]` literally. */
export class LabelLinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly display: string,
    readonly isBold: boolean = false,
    readonly isItalic: boolean = false,
    readonly isStrike: boolean = false,
    readonly isHighlight: boolean = false,
  ) {
    super();
  }

  eq(other: LabelLinkWidget) {
    return this.label === other.label && this.display === other.display
      && this.isBold === other.isBold && this.isItalic === other.isItalic
      && this.isStrike === other.isStrike && this.isHighlight === other.isHighlight;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-typst-link cm-typst-link--internal";
    // See LinkWidget: replace widgets fall outside surrounding mark decorations,
    // so apply the wrapping formatting directly.
    if (this.isBold) el.classList.add("cm-typst-bold");
    if (this.isItalic) el.classList.add("cm-typst-italic");
    if (this.isStrike) el.classList.add("cm-typst-strike");
    if (this.isHighlight) el.classList.add("cm-typst-highlight");
    el.style.cursor = "pointer";
    el.title = t("visual.link.jumpToLabel", { label: this.label });

    const text = document.createElement("span");
    text.textContent = this.display || this.label;
    el.appendChild(text);

    // A "link" (chain) glyph, distinct from LinkWidget's external-arrow, to
    // signal this jumps within the document rather than opening externally.
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
      '<path d="M9 17H7A5 5 0 0 1 7 7h2"/>' +
      '<path d="M15 7h2a5 5 0 1 1 0 10h-2"/>' +
      '<line x1="8" x2="16" y1="12" y2="12"/>';
    el.appendChild(icon);

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToLabel(view, this.label);
    });
    return el;
  }

  ignoreEvent() { return true; }
}

/** Move the cursor to (and scroll to) the `<label>` definition in this note —
 *  the anchor that tags an element, not a reference to it (which would land the
 *  cursor back inside the clicked link and reveal its source). Cursor goes to
 *  the start of the tagged line so the heading/element reads naturally. */
function jumpToLabel(view: EditorView, label: string): void {
  const pos = findLabelDefinition(view.state.doc.toString(), label);
  if (pos < 0) return;
  const lineStart = view.state.doc.lineAt(pos).from;
  view.dispatch({ selection: { anchor: lineStart }, scrollIntoView: true });
  view.focus();
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
  label.textContent = t("widget.citation.convertToAdvanced");
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
        // Only route focus into a verse canvas when the editor content has
        // focus. The Ctrl+F search field's `findNext` fires `selectionSet`
        // as it walks matches; without this gate, a match inside a verse
        // body would steal focus from the search input and the user's typing
        // would overwrite the verse. The search panel lives in `view.dom`
        // but outside `contentDOM`, so `hasFocus` is false while it's active.
        if (!view.hasFocus) return;
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

// ---------------------------------------------------------------------------
// verseSearchHighlighter: paints the current Ctrl+F match inside a verse
// canvas.
//
// A verse renders as an atomic widget whose canvas replaces the underlying
// `#verse("…")` source. CM's own search-match decoration is applied to that
// hidden source range, so a match inside a verse is found and selected but
// stays invisible — the user steps onto it with no visual cue. This plugin
// re-paints the current match (CM's selection) directly in the canvas.
//
// Mapping doc offsets through the decode + inline-markup render pipeline
// precisely would be costly; instead we locate the match by *occurrence*:
// the matched text and how many earlier matches sit before it in the same
// verse uniquely identify which rendered occurrence to highlight. This is
// exact for plain verse (the common case) and for case-insensitive substring
// search (the default). Markup/escapes or whole-word/regexp queries can in
// rare cases shift the occurrence count; the highlight then lands on a
// nearby same-text occurrence — never crashes, never corrupts source (the
// highlight is a pass-through `<span>`; see `encodeVerseDOM`'s SPAN case).
// ---------------------------------------------------------------------------

const VERSE_HIT_CLASS = "cm-verse-search-hit";

export const verseSearchHighlighter = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setSearchQuery)),
      );
      if (
        !update.selectionSet &&
        !update.docChanged &&
        !update.focusChanged &&
        !queryChanged
      ) {
        return;
      }
      const view = update.view;
      // Defer the DOM work until after CM flushes any widget DOM rebuild this
      // selection change triggered, so the canvas we paint into is current.
      queueMicrotask(() => refreshVerseSearchHits(view));
    }
  },
);

/** Remove every search-hit span from a canvas, restoring the original text
 *  nodes. Pass-through spans never alter encoded source, but stale ones would
 *  leave a misleading highlight, so each refresh clears before re-painting. */
function clearVerseHits(canvas: HTMLElement): void {
  const hits = canvas.querySelectorAll<HTMLElement>("." + VERSE_HIT_CLASS);
  if (hits.length === 0) return;
  for (const span of hits) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  // Merge the text nodes we just split so the canvas DOM (and the next
  // occurrence search over it) sees contiguous text again.
  canvas.normalize();
}

/** Re-paint the current search match inside whichever verse canvas contains
 *  it. Clears all verse canvases first so a moved/cleared match leaves none
 *  behind. */
function refreshVerseSearchHits(view: EditorView): void {
  for (const canvas of view.dom.querySelectorAll<HTMLElement>(".cm-typst-verse-canvas")) {
    clearVerseHits(canvas);
  }

  const query = getSearchQuery(view.state);
  if (!query.search) return;
  const sel = view.state.selection.main;
  if (sel.empty) return;

  for (const wrap of view.dom.querySelectorAll<HTMLElement>(".cm-typst-verse")) {
    const from = Number(wrap.dataset.bodyFrom);
    const to = Number(wrap.dataset.bodyTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (sel.from < from || sel.to > to) continue;

    const canvas = wrap.querySelector<HTMLElement>(".cm-typst-verse-canvas");
    if (!canvas) return;
    // While the user is editing inside the canvas there is no search caret to
    // honour, and mutating the DOM under their cursor would be disruptive.
    if (document.activeElement === canvas) return;

    // Decode the source slices to their canvas-visible form so the text we
    // search for (and count) matches what the canvas actually renders.
    const needle = decodeVerseLiteral(view.state.doc.sliceString(sel.from, sel.to));
    if (!needle) return;
    const prefix = decodeVerseLiteral(view.state.doc.sliceString(from, sel.from));
    const occurrence = countOccurrences(prefix, needle, query.caseSensitive);
    paintVerseHit(canvas, needle, occurrence, query.caseSensitive);
    return;
  }
}

/** Count non-overlapping occurrences of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string, caseSensitive: boolean): number {
  if (!needle) return 0;
  const h = caseSensitive ? hay : hay.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  let pos = 0;
  for (;;) {
    const f = h.indexOf(n, pos);
    if (f < 0) break;
    count++;
    pos = f + n.length;
  }
  return count;
}

/** Wrap the `occurrence`-th (0-based) appearance of `needle` in the canvas's
 *  visible text in a hit span, then scroll it into view. */
function paintVerseHit(
  canvas: HTMLElement,
  needle: string,
  occurrence: number,
  caseSensitive: boolean,
): void {
  // Flatten the canvas to a string while recording each text node's span in
  // that flat coordinate. `<br>` contributes a newline so multi-line matches
  // line up with the decoded source.
  const segs: { node: Text; start: number; len: number }[] = [];
  let flat = "";
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        segs.push({ node: child as Text, start: flat.length, len: text.length });
        flat += text;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if ((child as HTMLElement).tagName === "BR") flat += "\n";
        else walk(child);
      }
    }
  };
  walk(canvas);

  const hay = caseSensitive ? flat : flat.toLowerCase();
  const ndl = caseSensitive ? needle : needle.toLowerCase();
  let idx = -1;
  let count = 0;
  let pos = 0;
  for (;;) {
    const f = hay.indexOf(ndl, pos);
    if (f < 0) break;
    if (count === occurrence) { idx = f; break; }
    count++;
    pos = f + ndl.length;
  }
  if (idx < 0) return;
  const end = idx + ndl.length;

  // Collect the covered portion of each overlapping text node up front: the
  // offsets are in the pre-mutation flat space, and splitting one text node
  // never shifts another's, so wrapping them afterwards is safe.
  const portions = segs
    .map((s) => {
      const a = Math.max(idx, s.start);
      const b = Math.min(end, s.start + s.len);
      return a < b ? { node: s.node, from: a - s.start, to: b - s.start } : null;
    })
    .filter((p): p is { node: Text; from: number; to: number } => p !== null);

  let firstSpan: HTMLElement | null = null;
  for (const p of portions) {
    const span = wrapTextPortion(p.node, p.from, p.to);
    if (span && !firstSpan) firstSpan = span;
  }
  firstSpan?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Split `node` so that `[from, to)` is its own text node, wrap that node in a
 *  hit span (inserted in place, preserving any surrounding markup element),
 *  and return the span. */
function wrapTextPortion(node: Text, from: number, to: number): HTMLElement | null {
  let target = node;
  if (from > 0) target = target.splitText(from);
  if (to - from < (target.textContent ?? "").length) target.splitText(to - from);
  const parent = target.parentNode;
  if (!parent) return null;
  const span = document.createElement("span");
  span.className = VERSE_HIT_CLASS;
  parent.insertBefore(span, target);
  span.appendChild(target);
  return span;
}
