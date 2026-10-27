import { type EditorView, WidgetType, ViewPlugin, type ViewUpdate, type DecorationSet, keymap } from "@codemirror/view";
import { type StateField } from "@codemirror/state";
import { getSearchQuery, setSearchQuery } from "@codemirror/search";
import { openLink } from "../../lib/open-link";
import {
  attachmentViewKind,
  fetchImageObjectUrl,
  fetchMediaObjectUrl,
  revokeBlobUrls,
} from "../../lib/media-src";
import { errorCode } from "../../lib/errors";
import {
  openAttachmentExternally,
  openAttachmentInTab,
  showAttachmentContextMenu,
} from "../../lib/attachment-nav";
import { highlightCodeInto } from "./code-highlight";
import { buildPillButton, findCallEnd, applyCallTransform, upsertNamedArg, type PillMenuSection } from "./pill";
import { getPillOptions } from "./pill-options";
import { showWikilinkContextMenu } from "../../lib/wikilink-nav";
import { anchorPanelMenu } from "../../lib/uiMenu";
import { buildSuggestionCall } from "./annotation-insert";
import { parseInlineBody, HIGHLIGHT_FORMAT_CLASS, type BodySegment } from "./block-body-parse";
import { findLabelDefinition } from "./label-nav";
import { t } from "../../lib/i18n";
import { calloutKindLabel } from "./callout-kinds";
import { calloutIcon } from "./callout-icons";
import { applyWidgetHighlight, highlightInlineStyle, type WidgetHighlight } from "./visual-colors";

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

/**
 * Document offset of the `#image(...)` call behind an image widget at `pos`. An
 * aligned image (`#align(kw)[#image(...)]`) is anchored at the `#align`, so
 * step inward to the `#image`. Matches `imageOptions`, so drag-resize and the
 * pill's Width field edit the same argument.
 */
function resolveImageCallFrom(view: EditorView, pos: number): number {
  const liveTo = findCallEnd(view, pos);
  const src = view.state.doc.sliceString(pos, liveTo);
  if (/^\s*#align\b/.test(src)) {
    const idx = src.indexOf("#image");
    if (idx >= 0) return pos + idx;
  }
  return pos;
}

// Convert a width to a whole percentage of the text column, clamped to a
// sensible range. A percentage scales with the page the same way the preview
// scales with the editor.
function fractionToPercent(width: number, reference: number): number {
  if (reference <= 0) return 100;
  return Math.max(5, Math.min(100, Math.round((width / reference) * 100)));
}

/**
 * Attach a corner handle that resizes an image by dragging. Only the width is
 * set; Typst scales the height to match. During the drag the `<img>` is resized
 * in pixels; on release the width is written as a percentage through
 * `applyCallTransform` + `upsertNamedArg`, as the pill's Width field does.
 * Nothing is dispatched mid-drag.
 */
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
    // The percentage is relative to the column the image sits in.
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

// Block pills (callout, quote) that always reveal the source when clicked,
// since the body is the content and is often multi-line. Other block pills
// (image, figure) use the default rule: simple calls expand, complex ones open
// the menu.
const ALWAYS_EXPAND_PILLS = new Set(["callout", "quote"]);

/** The pill for a block-level call, wired to that call's option menu. */
function makeBlockPill(funcName: string, pos: number, view: EditorView): HTMLElement {
  return buildPillButton(funcName, view, () => {
    const callTo = findCallEnd(view, pos);
    return {
      funcName,
      callFrom: pos,
      callTo,
      optionSections: getPillOptions(funcName, view, pos, callTo),
      alwaysExpandOnClick: ALWAYS_EXPAND_PILLS.has(funcName),
    };
  });
}

/**
 * A block pill floated over the widget's top-left corner, so showing it doesn't
 * change the widget's height. The widget's root must be `position: relative`.
 */
function makeBlockPillOverlay(funcName: string, pos: number, view: EditorView): HTMLElement {
  const row = document.createElement("div");
  row.className = "cm-typst-block-pill-row cm-typst-block-pill-overlay";
  row.appendChild(makeBlockPill(funcName, pos, view));
  return row;
}

/**
 * Heading row shared by the rendered callout and its edit-state head row:
 * optional `pill` (edit state only), then the label and the kind's `icon`. Its
 * minimum height keeps both states the same size.
 */
function buildCalloutHeading(
  label: string,
  color: string,
  parts: { pill?: HTMLElement; icon?: SVGElement } = {},
): HTMLElement {
  const heading = document.createElement("div");
  heading.className = "cm-typst-callout-heading";
  heading.style.color = color;
  if (parts.pill) heading.appendChild(parts.pill);
  if (parts.icon) heading.appendChild(parts.icon);
  heading.appendChild(document.createTextNode(label));
  return heading;
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

/**
 * A 12px Lucide-style icon from static SVG markup. `markup` must be a constant
 * from this file, never note content.
 */
function lucideIcon(markup: string, className: string): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("width", "12");
  icon.setAttribute("height", "12");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.classList.add(className);
  icon.innerHTML = markup; // static-only
  return icon;
}

/**
 * A tag pill (`<span class="cm-typst-tag">`) with a Lucide `tag` icon in place
 * of the `#`. Shared by TagWidget and the block-body renderer.
 */
function buildTagPill(name: string): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "cm-typst-tag";

  pill.appendChild(
    lucideIcon(
      '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>' +
        '<circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
      "cm-typst-tag-icon",
    ),
  );

  const label = document.createElement("span");
  label.textContent = name;
  pill.appendChild(label);

  return pill;
}

/** The text Typst shows for a link with no text of its own: the address,
 *  without a `mailto:` or `tel:` prefix. */
export function linkTextFromUrl(url: string): string {
  return url.replace(/^(?:mailto|tel):/, "");
}

/**
 * An external-link span for a rendered block body. Like LinkWidget, a mousedown
 * opens the URL and is kept from CM, so the click doesn't put the block into
 * edit mode.
 */
function buildLinkSpan(url: string, display: string): HTMLElement {
  const a = document.createElement("span");
  a.className = "cm-typst-link";
  a.style.cursor = "pointer";
  a.textContent = display || linkTextFromUrl(url);
  a.title = url;
  a.addEventListener("mousedown", (e) => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    void openLink(url);
  });
  return a;
}

/**
 * Context that makes a block body's inline elements interactive. `bodyFrom` is
 * the document offset where the body begins.
 */
type BlockBodyContext = { view: EditorView; bodyFrom: number; blockFrom: number };

/**
 * A task checkbox and body for a rendered block body; the checkbox toggles the
 * call's `done:` argument. The owning widget's `ignoreEvent` must let the
 * checkbox's mousedown through.
 */
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
    // The task's offset from the block widget's start stays valid as the document
    // shifts. At click time the widget's current start is read from the DOM and
    // the offset added, since incremental updates move a widget's range without
    // rebuilding the widget.
    const offsetInBlock = ctx.bodyFrom + seg.start - ctx.blockFrom;
    const view = ctx.view;
    box.title = seg.done ? t("task.markNotDone") : t("task.markDone");
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const callFrom = view.posAtDOM(box) + offsetInBlock;
      applyCallTransform(view, callFrom, (s) =>
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

/** Drop the backslash from Typst inline escapes (`\*`, `\#`, `\[`, …); the
 *  parser leaves the `\` in text runs. */
function unescapeInline(text: string): string {
  return text.replace(/\\([*_#`[\]()\\])/g, "$1");
}

/** Render a callout or quote body, turning recognized inline notebox
 *  primitives into the same elements the inline widgets use and leaving
 *  everything else as text. Parsing is in block-body-parse.ts. With `ctx`, task
 *  checkboxes and wikilinks are interactive; without it the body is inert. */
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
        // The class gives the default highlight; a call's own
        // fill/stroke/radius is applied on top.
        if (seg.className === HIGHLIGHT_FORMAT_CLASS && seg.args) {
          const style = highlightInlineStyle(seg.args, true);
          if (style) span.style.cssText += `;${style}`;
        }
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

/**
 * `ignoreEvent` for rendered block bodies. A mousedown on a wikilink or task
 * checkbox is handled by that element, so CM ignores it; other clicks reach CM
 * and enter edit mode.
 */
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

/**
 * Rendered fenced code block: header strip, code area, footer strip. The strips
 * match the height of the edit state's fence lines (see visual-theme.ts).
 * `hasBody` is false when the fences are on adjacent lines.
 */
export class CodeBlockWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly code: string,
    readonly hasBody: boolean,
  ) {
    super();
  }

  eq(other: CodeBlockWidget) {
    return this.lang === other.lang && this.code === other.code && this.hasBody === other.hasBody;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-codeblock cm-typst-block-row";

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

    if (this.hasBody) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.appendChild(code);
      wrap.appendChild(pre);

      // Highlighting is async; `highlightCodeInto` fills in plain text first so
      // the widget is never empty.
      void highlightCodeInto(this.lang, this.code, code);
    }

    const footer = document.createElement("div");
    footer.className = "cm-typst-codeblock-footer";
    wrap.appendChild(footer);

    return wrap;
  }

  // Let clicks on the copy button and text selection reach the widget's DOM.
  ignoreEvent(e: Event) {
    if (e.type === "mousedown" || e.type === "click") {
      const target = e.target as HTMLElement;
      if (target.closest(".cm-typst-codeblock-copy")) return true;
    }
    return false;
  }
}

/** Lucide `file-text`, the PDF opener's glyph. */
const FILE_TEXT_ICON =
  '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
  '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>';

/** Lucide `external-link`, for links and openers that leave the app. */
const EXTERNAL_LINK_ICON =
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
  '<polyline points="15 3 21 3 21 9"/>' +
  '<line x1="10" y1="14" x2="21" y2="3"/>';

/**
 * True when an `#image(...)` points at a PDF. The webview can't show it as a
 * picture, so the editor shows the path with a button to open it.
 */
function isPdfImage(path: string): boolean {
  return attachmentViewKind(path) === "pdf";
}

/**
 * Turn an embed widget's content row into a file row: the path with a button
 * that opens the file. A PDF opens in InkyCap's viewer; a picture or player
 * that couldn't be shown here opens in the default application. Does nothing if
 * the button is already there.
 */
function appendFileOpener(row: HTMLElement, path: string, opens: "viewer" | "default-app"): void {
  if (row.classList.contains("cm-typst-file-row")) return;
  row.classList.add("cm-typst-file-row");
  const title = opens === "viewer" ? t("attachmentView.openPdf") : t("attachmentView.openExternally");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-typst-file-open";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.appendChild(
    lucideIcon(opens === "viewer" ? FILE_TEXT_ICON : EXTERNAL_LINK_ICON, "cm-typst-file-open-icon"),
  );
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void (opens === "viewer" ? openAttachmentInTab(path) : openAttachmentExternally(path));
  });
  row.appendChild(button);
}

/**
 * When an embedded file can't be loaded and is too large to show, offer to open
 * it in the default application. Other failures (usually a missing file) keep
 * the plain path.
 */
function offerOpenerAfterLoadFailure(err: unknown, row: HTMLElement, wrap: HTMLElement, path: string) {
  if (!document.body.contains(wrap)) return;
  if (errorCode(err) === "file-too-large-to-show") appendFileOpener(row, path, "default-app");
}

/** The picture or player in `row` failed to display (a format the webview
 *  can't decode): hide it, bring the path back, and offer the default app. */
function offerOpenerAfterDisplayFailure(
  el: HTMLElement,
  label: HTMLElement,
  row: HTMLElement,
  path: string,
) {
  el.style.display = "none";
  label.style.display = "";
  appendFileOpener(row, path, "default-app");
}

/** Whether an event belongs to an embed's open button, which handles it
 *  itself rather than letting CodeMirror place the caret. */
function isFileOpenerEvent(e: Event): boolean {
  return !!(e.target as Element | null)?.closest?.(".cm-typst-file-open");
}

/** Right-click on an embedded image or media element opens the attachment
 *  menu (show in file tree / system file manager) for the file behind it. */
function attachAttachmentMenu(el: HTMLElement, path: string): void {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void showAttachmentContextMenu(e.clientX, e.clientY, path);
  });
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

    if (isPdfImage(this.path)) {
      appendFileOpener(wrap, this.path, "viewer");
      return wrap;
    }

    const imgPath = this.path;
    fetchImageObjectUrl(imgPath).then((url) => {
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
      // With only the width set, scale the height to match (as Typst does) and
      // lift the preview's height cap.
      if (this.width && !this.height) img.style.height = "auto";
      if (this.height && !this.width) img.style.width = "auto";
      if (this.width || this.height) img.style.maxHeight = "none";
      img.addEventListener("load", () => {
        label.style.display = "none";
      });
      img.addEventListener("error", () =>
        offerOpenerAfterDisplayFailure(img, label, wrap, imgPath),
      );
      wrap.insertBefore(img, label);
    }, (err) => offerOpenerAfterLoadFailure(err, wrap, wrap, imgPath));

    return wrap;
  }

  destroy(dom: HTMLElement) {
    revokeBlobUrls(dom);
  }

  ignoreEvent(e: Event) { return isFileOpenerEvent(e); }
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
    // Horizontal placement from the source's `#align(...)` wrapper. A bare
    // `#image(...)` is left-aligned.
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

  get estimatedHeight(): number { return 200; }

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
    if (this.withPill) wrap.appendChild(makeBlockPillOverlay("image", this.pos, view));

    const inner = document.createElement("div");
    inner.style.textAlign = this.align;
    attachAttachmentMenu(inner, this.path);

    const label = document.createElement("div");
    label.className = "cm-typst-image-label";
    label.textContent = this.path;
    inner.appendChild(label);

    if (isPdfImage(this.path)) {
      appendFileOpener(inner, this.path, "viewer");
      wrap.appendChild(inner);
      return;
    }

    const imgPath = this.path;
    fetchImageObjectUrl(imgPath).then((url) => {
      // Bail (and free the blob) if the widget was replaced while the bytes
      // were loading.
      if (!url || !document.body.contains(wrap)) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      // An inline-block holder, so the resize handle can sit over the image's
      // corner and `inner`'s text-align positions the image.
      const holder = document.createElement("div");
      holder.className = "cm-typst-image-holder";

      const img = document.createElement("img");
      img.className = "cm-typst-image-img";
      img.alt = this.alt ?? imgPath;
      img.src = url;
      if (this.width) img.style.width = typstLengthToCss(this.width);
      if (this.height) img.style.height = typstLengthToCss(this.height);
      // With only the width set, scale the height to match (as Typst does) and
      // lift the preview's height cap.
      if (this.width && !this.height) img.style.height = "auto";
      if (this.height && !this.width) img.style.width = "auto";
      if (this.width || this.height) img.style.maxHeight = "none";
      img.addEventListener("load", () => { label.style.display = "none"; });
      img.addEventListener("error", () =>
        offerOpenerAfterDisplayFailure(holder, label, inner, imgPath),
      );

      holder.appendChild(img);
      attachImageResize(view, holder, img, () => resolveImageCallFrom(view, this.pos));
      inner.insertBefore(holder, label);
    }, (err) => offerOpenerAfterLoadFailure(err, inner, wrap, imgPath));
    wrap.appendChild(inner);
  }

  // Right-click opens the attachment menu and the open button handles its own
  // clicks; everything else goes to CM.
  ignoreEvent(e: Event) { return e.type === "contextmenu" || isFileOpenerEvent(e); }
}

/// Block widget for `#video(...)` / `#audio(...)`: a player for previewing the
/// attachment while writing.
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
    return this.kind === "audio" ? 54 : 200;
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
    if (this.withPill) wrap.appendChild(makeBlockPillOverlay(this.kind, this.pos, view));

    const inner = document.createElement("div");
    inner.style.textAlign = "center";
    attachAttachmentMenu(inner, this.path);

    const label = document.createElement("div");
    label.className = "cm-typst-image-label";
    label.textContent = this.path;
    inner.appendChild(label);

    const mediaPath = this.path;
    fetchMediaObjectUrl(mediaPath).then((url) => {
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
      el.addEventListener("error", () =>
        offerOpenerAfterDisplayFailure(el, label, inner, mediaPath),
      );
      inner.insertBefore(el, label);
    }, (err) => offerOpenerAfterLoadFailure(err, inner, wrap, mediaPath));
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

/**
 * Inline `#task(...)`: a checkbox and body. The checkbox toggles `done:`;
 * clicking the body reveals the source.
 */
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
      // Read the call's current start from the DOM. Incremental updates move a
      // widget's range without rebuilding it, so `this.from` can be stale and
      // would edit the wrong span.
      const pos = view.posAtDOM(wrap);
      // Set `done: true` when checking; drop the arg (→ default false)
      // when unchecking, so a freshly-unchecked task reads cleanly.
      applyCallTransform(view, pos, (s) =>
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

/**
 * Split a suggestion body for display: a `\` followed by whitespace or the end
 * becomes a line break, and newlines become spaces, as in Typst. An escaped `\\`
 * isn't handled specially. Exported for tests.
 */
export function typstInlineSegments(txt: string): string[] {
  return txt
    .split(/\\(?=\s|$)/)
    .map((seg) => seg.replace(/\s*\n\s*/g, " "));
}

/**
 * Inline `#suggestion(...)` tracked change: insert is underlined green, delete
 * struck red, replace both. Clicking opens an Accept / Reject menu.
 *
 * Accepting or rejecting unwraps the call to plain Typst
 * (`applyCallTransform`). The rules must match
 * `typst_pipeline::suggestion::resolution_text` in Rust.
 */
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

/**
 * What a suggestion's review menu needs, from the inline [`SuggestionWidget`]
 * or the Changes & History pane. `from` is the call's start;
 * [`applyCallTransform`] finds the call's current extent, so the menu works
 * from outside the editor too.
 */
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

/**
 * Open the Accept / Reject / Comment menu for a suggestion, anchored to
 * `anchor`.
 */
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

  // Comment field, filled with the suggestion's saved `note`. "Save comment"
  // stores it on the suggestion; Accept and Reject discard it along with the
  // mark. The proposed text is edited by expanding the pill.
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

  // Save the comment without resolving: rebuild the call with the new `note`,
  // keeping the body as is. Empty clears it.
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
    readonly highlight: WidgetHighlight = null,
    readonly label: string = "",
    readonly exists: boolean = true,
  ) {
    super();
  }

  eq(other: WikilinkWidget) {
    return this.target === other.target && this.display === other.display
      && this.isBold === other.isBold && this.isItalic === other.isItalic
      && this.isStrike === other.isStrike && this.highlight === other.highlight
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
    applyWidgetHighlight(pill, this.highlight);
    // Inside a heading this widget already inherits the heading's size; adding
    // the heading class would apply the `em` size twice.

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

// ── VerseWidget ──────────────────────────────────────────────────────────
//
// A verse is a freeform poetry block, shown as a contentEditable canvas over
// a single source call: `#verse("body", align-to: center, font: "…")`.
//
// Round trip:
//   - decodeVerseLiteral: string escapes resolved, markup escapes (`\*`) kept
//   - renderVerseBody: *bold*, _italic_, #strike[…] etc. become HTML elements
//   - the writer edits the canvas
//   - on blur, encodeVerseDOM turns the DOM back into markup and escapes it,
//     and one transaction replaces the text between the quotes
//
// Markup characters the writer types are stored as `\X`, so they stay
// literal. The widget follows the CM6 widget recipe in AGENTS.md (atomic wrap,
// focus routing on insertion, dispatch on blur, stopped input events), and
// also forwards undo/redo to CM and makes Tab insert a tab.

const VERSE_MARKUP_META = new Set([
  "\\", "*", "_", "#", "[", "]", "$", "`", "<", ">", "@", "~",
]);

/**
 * Send Ctrl/Cmd-Z or -Y to CM's contentDOM so the editor's undo stack handles
 * it. Blur the editable element first so its changes reach the source.
 */
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

/**
 * Escape markup characters so `eval(..., mode: "markup")` treats them
 * literally, then encode for the string literal.
 */
function encodeUserText(text: string): string {
  let markup = "";
  for (const ch of text) {
    if (VERSE_MARKUP_META.has(ch)) markup += "\\" + ch;
    else markup += ch;
  }
  return encodeAsStringLiteral(markup);
}

/**
 * Walk the canvas DOM and produce the Typst string literal's contents.
 * `<strong>`, `<em>` etc. become markup (`*x*`, `_x_`, `#strike[x]`); text goes
 * through {@link encodeUserText}.
 *
 * After the first Enter the browser wraps lines in `<div>` or `<p>`. Each block
 * except the first starts a new line, and consecutive breaks are merged so a
 * `<br>` and a block boundary don't produce two newlines.
 */
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

/**
 * Decode a Typst string literal's contents (`\n`, `\t`, `\"`, `\\`, `\u{…}`).
 * Markup escapes (`\*`, `\_`) are kept for the line renderer.
 */
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

/**
 * Render one decoded verse line into `parent`, handling `*bold*`, `_italic_`,
 * `#strike[…]` / `#highlight[…]` / `#underline[…]` and `\X` escapes,
 * recursively.
 *
 * This is a small subset of Typst markup: a verse holds inline formatting only.
 * Anything else is kept as literal text, so the source survives a round trip.
 * Like Typst, emphasis needs non-space just inside the delimiters (`* foo*`
 * isn't bold), so the canvas matches the output.
 */
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
    // Bold or italic only with a matching close on this line and non-space
    // inside.
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

/**
 * Weight steps offered by the verse pill. They match a variable font's wght
 * axis and static fonts with Light/Bold faces.
 */
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
  /**
   * Explicit `weight:` from source, or null to inherit. A value outside the
   * pill's steps is kept; the pill just shows none as active.
   */
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
    // Atomic wrap for CM6; the canvas inside is editable.
    wrap.contentEditable = "false";
    // Body range stamped on the wrap so `verseFocusRouter` can route focus into
    // the canvas when the selection enters the body (e.g. backspacing into it
    // from below). The DOM is reused while the body is unchanged, so `toDOM`
    // doesn't run again.
    //
    // The offsets are relative to the call start, because the widget isn't
    // rebuilt when edits elsewhere shift it. `liveVerseBodyRange` turns them
    // into document positions.
    wrap.dataset.bodyRelFrom = String(this.opts.bodyFrom - this.opts.callFrom);
    wrap.dataset.bodyRelTo = String(this.opts.bodyTo - this.opts.callFrom);

    // Pill (top-left): identifies the verse and opens the menu with its
    // alignment options.
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
      // Clear search highlights before the click places the caret.
      clearVerseHits(canvas);
    });

    // Keep input events from reaching CM's contentDOM.
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
        // Forward undo/redo to CM so it acts on the source, not the canvas's
        // own history. Blur first so pending edits reach the source.
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
      // Tab inserts a tab character; verse often needs indentation.
      if (e.key === "Tab") {
        e.preventDefault();
        document.execCommand("insertText", false, "\t");
        return;
      }
      // Arrow keys at the canvas edges return to the source editor, like a
      // table cell at the grid edge.
      if ((e.key === "ArrowLeft" || e.key === "ArrowUp")
          && caretAtCanvasEdge(canvas, "start", e.key === "ArrowUp")) {
        e.preventDefault();
        this.exitToEditor(view, wrap, "before");
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "ArrowDown")
          && caretAtCanvasEdge(canvas, "end", e.key === "ArrowDown")) {
        e.preventDefault();
        this.exitToEditor(view, wrap, "after");
        return;
      }
    });

    canvas.addEventListener("paste", (e) => {
      // Paste as plain text; pasted HTML doesn't round-trip through the
      // encoder.
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

    // Focus routing on insertion: if the selection is inside the body when the
    // widget mounts, move focus into the canvas with the caret at the end. Only
    // when the editor content has focus, so a panel such as the Ctrl+F search
    // field (whose matches move the selection) keeps it.
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
        placeCaretInVerseCanvas(canvas, "end");
      });
    }

    return wrap;
  }

  /**
   * Move the caret from the canvas back to the source editor, just before or
   * after the `#verse(...)` call.
   */
  private exitToEditor(view: EditorView, wrap: HTMLElement, direction: "before" | "after"): void {
    // The widget's build-time offset can be stale; read its start from the DOM.
    let callFrom: number;
    try {
      callFrom = view.posAtDOM(wrap);
    } catch {
      callFrom = this.opts.callFrom;
    }
    const canvas = wrap.querySelector<HTMLElement>(".cm-typst-verse-canvas");
    // Blur first so any pending canvas edit flushes to source before we
    // compute the call's end and move the selection.
    canvas?.blur();
    const target = direction === "before" ? callFrom : findCallEnd(view, callFrom);
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
    view.focus();
  }

  /**
   * Encode the canvas and replace the text between the quotes, if it changed.
   * Body bounds come from the live document, since edits elsewhere may have
   * moved them.
   */
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

  /** The verse pill's option sections: alignment and weight. */
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

  /**
   * Set the `weight:` argument. Regular (400) removes it, as "left" does for
   * alignment.
   */
  private setWeight(next: VerseWeight, view: EditorView): void {
    const current = this.opts.weight ?? VERSE_WEIGHT_DEFAULT;
    if (next === current) return;
    this.rewriteCallArgs(view, (args) => upsertWeightArg(args, next));
  }

  /**
   * Pass the verse call's argument list to `rewrite` and apply the result.
   * Paren matching skips quoted text, so a `)` in the body doesn't end the
   * call.
   */
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

/**
 * Add or replace `weight:` in a verse argument list, matching integer and
 * named-string values. Regular (400) removes it.
 */
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

/**
 * A widget that draws a whole-line element around a body edited in place (block
 * quote, callout). Extending it tells the caret rules that the element has a
 * body, so motion into it lands in the text rather than on the hidden markup
 * (see `createBlockBodyCaretEntry` in pill-boundary-nav.ts).
 *
 * Elements that handle their own keyboard entry (table, verse) don't extend it,
 * nor does a margin comment, which has no visible body until its pill is
 * clicked.
 */
export abstract class BlockBodyElementWidget extends WidgetType {}

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

/**
 * Rendered callout, shown while the caret is outside the call. Its edit state
 * (`CalloutHeadRowWidget` and line decorations) uses the same geometry
 * variables, so the height doesn't change.
 */
export class CalloutBlockWidget extends BlockBodyElementWidget {
  constructor(
    readonly kind: string,
    readonly title: string,
    /** The colour to draw in, already resolved from the call's `color:`
     *  override or its kind (see `calloutColor`). */
    readonly color: string,
    readonly bodyText: string,
    readonly pos: number,
    readonly bodyFrom: number,
  ) {
    super();
  }

  eq(other: CalloutBlockWidget) {
    return this.kind === other.kind && this.title === other.title
      && this.color === other.color
      && this.bodyText === other.bodyText && this.pos === other.pos
      && this.bodyFrom === other.bodyFrom;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-callout-block cm-typst-block-row";
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
    const color = this.color;
    const inner = document.createElement("div");
    inner.className = "cm-typst-callout";
    inner.style.setProperty("--callout-color", color);
    inner.style.backgroundColor = `color-mix(in srgb, ${color} 8%, transparent)`;

    inner.appendChild(buildCalloutHeading(
      calloutKindLabel(this.kind, this.title),
      color,
      { icon: calloutIcon(this.kind) },
    ));

    if (this.bodyText) {
      const body = document.createElement("div");
      body.className = "cm-typst-callout-body";
      renderTypstBody(this.bodyText, body, { view, bodyFrom: this.bodyFrom, blockFrom: this.pos });
      inner.appendChild(body);
    }

    wrap.appendChild(inner);
  }

  ignoreEvent(e: Event) {
    return blockBodyIgnoreEvent(e);
  }
}

/**
 * Rendered block quote, shown while the caret is outside the call. Its edit
 * state (line decorations and `BlockquoteAttributionRowWidget`) uses the same
 * geometry variables, so the height doesn't change.
 */
export class BlockquoteBlockWidget extends BlockBodyElementWidget {
  constructor(
    readonly content: string,
    readonly attribution: string,
    readonly pos: number,
    readonly bodyFrom: number,
  ) {
    super();
  }

  eq(other: BlockquoteBlockWidget) {
    return this.content === other.content && this.attribution === other.attribution
      && this.pos === other.pos && this.bodyFrom === other.bodyFrom;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-blockquote-block cm-typst-block-row";
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
    const inner = document.createElement("blockquote");
    inner.className = "cm-typst-blockquote";

    const text = document.createElement("div");
    text.className = "cm-typst-blockquote-text";
    renderTypstBody(this.content, text, { view, bodyFrom: this.bodyFrom, blockFrom: this.pos });
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

/**
 * Edit-state heading row for a callout. Replaces the hidden opener on the first
 * body line with the pill and the rendered widget's heading, so the height doesn't
 * change.
 */
export class CalloutHeadRowWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly title: string,
    /** Resolved the same way as `CalloutBlockWidget.color`, so the block looks
     *  the same whether the caret is on it or not. */
    readonly color: string,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: CalloutHeadRowWidget) {
    return this.kind === other.kind && this.title === other.title
      && this.color === other.color && this.pos === other.pos;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-callout-head cm-typst-block-row";
    wrap.appendChild(buildCalloutHeading(
      calloutKindLabel(this.kind, this.title),
      this.color,
      { pill: makeBlockPill("callout", this.pos, view), icon: calloutIcon(this.kind) },
    ));
    return wrap;
  }

  ignoreEvent() { return true; }
}

/**
 * Edit-state attribution row for a block quote. Replaces the hidden closing `]`
 * with the rendered widget's "— attribution" row. The attribution is edited
 * through the pill.
 */
export class BlockquoteAttributionRowWidget extends WidgetType {
  constructor(readonly attribution: string) {
    super();
  }

  eq(other: BlockquoteAttributionRowWidget) {
    return this.attribution === other.attribution;
  }

  toDOM() {
    const row = document.createElement("div");
    row.className = "cm-typst-block-row";
    const attr = document.createElement("div");
    attr.className = "cm-typst-blockquote-attr";
    attr.textContent = `— ${this.attribution}`;
    row.appendChild(attr);
    return row;
  }

  ignoreEvent() { return true; }
}

// A bibliography renders as a pill placeholder, so it is visible without being
// editable prose. The pill's menu offers source editing, copy and delete.
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
    readonly highlight: WidgetHighlight = null,
  ) {
    super();
  }

  eq(other: LinkWidget) {
    return this.url === other.url && this.display === other.display
      && this.isBold === other.isBold && this.isItalic === other.isItalic
      && this.isStrike === other.isStrike && this.highlight === other.highlight;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-typst-link";
    // A replace widget renders outside surrounding marks, so apply their
    // formatting classes here.
    if (this.isBold) el.classList.add("cm-typst-bold");
    if (this.isItalic) el.classList.add("cm-typst-italic");
    if (this.isStrike) el.classList.add("cm-typst-strike");
    applyWidgetHighlight(el, this.highlight);
    el.style.cursor = "pointer";
    el.title = this.url;

    const text = document.createElement("span");
    text.textContent = this.display || linkTextFromUrl(this.url);
    el.appendChild(text);

    el.appendChild(lucideIcon(EXTERNAL_LINK_ICON, "cm-typst-link-external-icon"));

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openLink(this.url);
    });
    return el;
  }

  ignoreEvent() { return true; }
}

/**
 * A `#link(<label>)[text]` link to a label in this note. Renders like
 * `LinkWidget`, but a click jumps to where the label is defined.
 */
export class LabelLinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly display: string,
    readonly isBold: boolean = false,
    readonly isItalic: boolean = false,
    readonly isStrike: boolean = false,
    readonly highlight: WidgetHighlight = null,
  ) {
    super();
  }

  eq(other: LabelLinkWidget) {
    return this.label === other.label && this.display === other.display
      && this.isBold === other.isBold && this.isItalic === other.isItalic
      && this.isStrike === other.isStrike && this.highlight === other.highlight;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-typst-link cm-typst-link--internal";
    // See LinkWidget: replace widgets fall outside surrounding mark decorations,
    // so apply the wrapping formatting directly.
    if (this.isBold) el.classList.add("cm-typst-bold");
    if (this.isItalic) el.classList.add("cm-typst-italic");
    if (this.isStrike) el.classList.add("cm-typst-strike");
    applyWidgetHighlight(el, this.highlight);
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

/**
 * Move the cursor to the start of the line where `<label>` is defined, and
 * scroll to it.
 */
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

/**
 * A pill for an `@label` reference to a heading, figure, equation or table in
 * the note (the non-citation use of `@`). Unlike {@link CitationWidget} it
 * shows the target's text (e.g. the heading) rather than `@key`. Clicking jumps
 * to the label.
 */
export class ReferenceWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly kind: string,
    readonly display: string,
    readonly refFrom: number = 0,
    readonly refTo: number = 0,
  ) {
    super();
  }

  eq(other: WidgetType) {
    return other instanceof ReferenceWidget
      && this.key === other.key
      && this.kind === other.kind
      && this.display === other.display
      && this.refFrom === other.refFrom
      && this.refTo === other.refTo;
  }

  toDOM(view: EditorView) {
    const pill = document.createElement("span");
    pill.className = `cm-typst-ref-pill cm-typst-ref-pill--${this.kind}`;
    const shown = this.display.length > 40 ? this.display.slice(0, 37) + "…" : this.display;
    pill.textContent = shown;
    pill.title = t("widget.reference.goTo", { target: `@${this.key}` });

    pill.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToLabel(view, this.key);
    });

    return pill;
  }

  ignoreEvent() {
    return true;
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

/** Collapse the selection to the start or end of a verse canvas. */
function placeCaretInVerseCanvas(canvas: HTMLElement, where: "start" | "end"): void {
  const range = document.createRange();
  range.selectNodeContents(canvas);
  range.collapse(where === "start");
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Whether the caret is at the canvas edge an arrow key would leave from.
 * Left/Right leave only at the very start or end; Up/Down also leave from the
 * first or last visual line.
 */
function caretAtCanvasEdge(
  canvas: HTMLElement,
  edge: "start" | "end",
  vertical: boolean,
): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const caret = sel.getRangeAt(0);

  // No text between the caret and the edge.
  const probe = document.createRange();
  probe.selectNodeContents(canvas);
  if (edge === "start") probe.setEnd(caret.startContainer, caret.startOffset);
  else probe.setStart(caret.endContainer, caret.endOffset);
  if (probe.toString().length === 0) return true;

  if (!vertical) return false;

  // Vertical: caret on the first (start) / last (end) visual line. The
  // tolerance scales with the caret height so it holds at any font size.
  const caretRect = caret.getBoundingClientRect();
  if (caretRect.height === 0) return false;
  const box = canvas.getBoundingClientRect();
  const tol = caretRect.height * 0.5;
  return edge === "start"
    ? caretRect.top - box.top < tol
    : box.bottom - caretRect.bottom < tol;
}

/**
 * A verse wrap's current body range: the offsets stamped at mount time plus the
 * widget's live start from `posAtDOM`. Null if it can't be resolved.
 */
function liveVerseBodyRange(
  view: EditorView,
  wrap: HTMLElement,
): { from: number; to: number } | null {
  const relFrom = Number(wrap.dataset.bodyRelFrom);
  const relTo = Number(wrap.dataset.bodyRelTo);
  if (!Number.isFinite(relFrom) || !Number.isFinite(relTo)) return null;
  let callFrom: number;
  try {
    callFrom = view.posAtDOM(wrap);
  } catch {
    // posAtDOM can throw for a node CM no longer tracks.
    return null;
  }
  return { from: callFrom + relFrom, to: callFrom + relTo };
}

/**
 * Route focus into a verse canvas when the cursor moves into its body. `toDOM`
 * handles this when the widget is created; this covers a reused widget, e.g.
 * after backspacing into a verse from below.
 */
export const verseFocusRouter = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return;
      const sel = update.state.selection.main;
      const lo = Math.min(sel.anchor, sel.head);
      const hi = Math.max(sel.anchor, sel.head);
      const view = update.view;
      // Defer the lookup until CM has written a just-inserted widget's DOM.
      queueMicrotask(() => {
        // Only when the editor content has focus, so a search match inside a
        // verse doesn't take focus from the search field.
        if (!view.hasFocus) return;
        const wraps = view.dom.querySelectorAll<HTMLElement>(".cm-typst-verse");
        for (const wrap of wraps) {
          const body = liveVerseBodyRange(view, wrap);
          if (!body) continue;
          // The selection (a point or a range) must lie within this verse's
          // body.
          if (lo < body.from || hi > body.to) continue;
          const canvas = wrap.querySelector<HTMLElement>(".cm-typst-verse-canvas");
          if (!canvas) return;
          if (document.activeElement === canvas) return;
          canvas.focus({ preventScroll: true });
          const range = document.createRange();
          range.selectNodeContents(canvas);
          // Empty selection: caret at the end. A range: select the canvas
          // contents.
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

/**
 * Find the verse widget an arrow press from `pos` should enter, and the end the
 * caret lands at. The verse is atomic, so a plain arrow press would skip it.
 * `decoField` is passed in to avoid a circular import. Like
 * `findTableWrapNear`.
 */
function findVerseEntry(
  view: EditorView,
  pos: number,
  direction: "up" | "down" | "left" | "right",
  decoField: StateField<DecorationSet>,
): { wrap: HTMLElement; place: "start" | "end" } | null {
  const decos = view.state.field(decoField, false);
  if (!decos) return null;
  let vf = -1;
  let vt = -1;
  decos.between(0, view.state.doc.length, (f, t, deco) => {
    if (!(deco.spec?.widget instanceof VerseWidget)) return;
    if (direction === "up" && t <= pos && t > vt) { vf = f; vt = t; }
    else if (direction === "down" && f >= pos && (vf < 0 || f < vf)) { vf = f; vt = t; }
    else if (direction === "right" && f === pos) { vf = f; vt = t; }
    else if (direction === "left" && t === pos) { vf = f; vt = t; }
  });
  if (vf < 0) return null;

  // Vertical motion only enters when the verse is actually on the adjacent
  // line, so Up/Down near (but not next to) a verse behaves normally.
  if (direction === "up" || direction === "down") {
    const line = view.state.doc.lineAt(pos);
    const adjacent = direction === "up"
      ? (line.number > 1 ? view.state.doc.line(line.number - 1) : null)
      : (line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1) : null);
    if (!adjacent) return null;
    if (!(vf <= adjacent.to && vt >= adjacent.from)) return null;
  }

  const wraps = view.dom.querySelectorAll<HTMLElement>(".cm-typst-verse");
  for (const w of wraps) {
    try {
      const p = view.posAtDOM(w);
      if (p >= vf && p <= vt) {
        const place = direction === "up" || direction === "left" ? "end" : "start";
        return { wrap: w, place };
      }
    } catch { /* posAtDOM can throw for unmounted nodes */ }
  }
  return null;
}

/**
 * Keymap for entering an adjacent verse canvas with the arrow keys. A factory,
 * so visual-plugin can pass its decoration field without a circular import.
 * Like `createTableEntryKeymap`.
 */
export function createVerseEntryKeymap(decoField: StateField<DecorationSet>) {
  const enter = (view: EditorView, direction: "up" | "down" | "left" | "right"): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    // On a wrapped line, only enter vertically from the first/last visual
    // line, so intra-line motion runs first (matches the table entry keymap).
    if (direction === "up" || direction === "down") {
      const line = view.state.doc.lineAt(sel.head);
      const headC = view.coordsAtPos(sel.head);
      const edgeC = view.coordsAtPos(direction === "up" ? line.from : line.to);
      if (headC && edgeC) {
        if (direction === "up" && headC.top > edgeC.top + 2) return false;
        if (direction === "down" && headC.top < edgeC.top - 2) return false;
      }
    }
    const target = findVerseEntry(view, sel.head, direction, decoField);
    if (!target) return false;
    const canvas = target.wrap.querySelector<HTMLElement>(".cm-typst-verse-canvas");
    if (!canvas) return false;
    canvas.focus({ preventScroll: true });
    placeCaretInVerseCanvas(canvas, target.place);
    return true;
  };
  return keymap.of([
    { key: "ArrowRight", run: (v) => enter(v, "right") },
    { key: "ArrowLeft", run: (v) => enter(v, "left") },
    { key: "ArrowDown", run: (v) => enter(v, "down") },
    { key: "ArrowUp", run: (v) => enter(v, "up") },
  ]);
}

// ---------------------------------------------------------------------------
// verseSearchHighlighter: paints the current Ctrl+F match inside a verse
// canvas. CM's own match decoration lands on the hidden source, so it isn't
// visible.
//
// The match is found by occurrence: its text and how many earlier matches
// are in the same verse. This is exact for plain text; with markup or
// regexp queries it can land on a nearby occurrence of the same text. The
// highlight is a pass-through `<span>` and never changes the source.
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

/** Remove all search-hit spans from a canvas, restoring the text nodes. */
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

/**
 * Repaint the current search match in whichever verse contains it, clearing the
 * others.
 */
function refreshVerseSearchHits(view: EditorView): void {
  for (const canvas of view.dom.querySelectorAll<HTMLElement>(".cm-typst-verse-canvas")) {
    clearVerseHits(canvas);
  }

  const query = getSearchQuery(view.state);
  if (!query.search) return;
  const sel = view.state.selection.main;
  if (sel.empty) return;

  for (const wrap of view.dom.querySelectorAll<HTMLElement>(".cm-typst-verse")) {
    const body = liveVerseBodyRange(view, wrap);
    if (!body) continue;
    if (sel.from < body.from || sel.to > body.to) continue;

    const canvas = wrap.querySelector<HTMLElement>(".cm-typst-verse-canvas");
    if (!canvas) return;
    // While the user is editing inside the canvas there is no search caret to
    // honour, and mutating the DOM under their cursor would be disruptive.
    if (document.activeElement === canvas) return;

    // Decode the source slices to their canvas-visible form so the text we
    // search for (and count) matches what the canvas actually renders.
    const needle = decodeVerseLiteral(view.state.doc.sliceString(sel.from, sel.to));
    if (!needle) return;
    const prefix = decodeVerseLiteral(view.state.doc.sliceString(body.from, sel.from));
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
  // Flatten the canvas to a string, recording each text node's span. `<br>`
  // counts as a newline.
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

  // Collect each text node's covered portion first; splitting one node doesn't
  // shift another's offsets.
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

/**
 * Split `node` so `[from, to)` is its own text node, wrap it in a hit span and
 * return the span.
 */
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
