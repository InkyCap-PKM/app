import { type EditorView, WidgetType } from "@codemirror/view";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as ipc from "../../lib/ipc";
import { expandFunc } from "./effects";

// Build the small pill row that block elements (image, embed, callout,
// blockquote) show at their top edge when the cursor is on the line.
// The pill is rendered INSIDE the element's widget DOM, not as a
// separate block widget above it: keeping it inside means
// (a) `coordsAtPos(from)` returns the same y whether the pill is
// present, replaced by raw markup, or absent — so the click-anchor
// plugin sees zero delta on pill clicks and doesn't drift, and
// (b) there's no extra block-widget container introducing line-spacing
// above the element.
function makeBlockPillRow(funcName: string, pos: number, view: EditorView): HTMLElement {
  const row = document.createElement("div");
  row.className = "cm-typst-block-pill-row";

  const chip = document.createElement("span");
  chip.className = "cm-typst-func-chip";
  chip.title = funcName;
  const hash = document.createElement("span");
  hash.className = "cm-typst-func-chip-hash";
  chip.appendChild(hash);
  const label = document.createElement("span");
  label.textContent = funcName;
  chip.appendChild(label);
  chip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    view.dispatch({
      effects: expandFunc.of(pos),
      selection: { anchor: pos + 1 },
    });
  });
  row.appendChild(chip);

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
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(
        new CustomEvent("inkycap:navigate-wikilink", { detail: { target } }),
      );
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

const CALLOUT_COLORS: Record<string, string> = {
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

    if (this.lang) {
      const label = document.createElement("span");
      label.className = "cm-typst-codeblock-lang";
      label.textContent = this.lang;
      wrap.appendChild(label);
    }

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = this.code;
    pre.appendChild(code);
    wrap.appendChild(pre);

    return wrap;
  }

  ignoreEvent() { return false; }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return this.path === other.path && this.pos === other.pos;
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
      img.alt = imgPath;
      img.src = convertFileSrc(absPath);
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

export class ImageBlockWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly pos: number,
    readonly withPill: boolean,
  ) {
    super();
  }

  eq(other: ImageBlockWidget) {
    return this.path === other.path && this.pos === other.pos && this.withPill === other.withPill;
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
    inner.style.textAlign = "center";

    const label = document.createElement("div");
    label.className = "cm-typst-image-label";
    label.textContent = this.path;
    inner.appendChild(label);

    const imgPath = this.path;
    ipc.resolveEmbedPath(imgPath).then((absPath) => {
      if (!absPath) return;
      const img = document.createElement("img");
      img.className = "cm-typst-image-img";
      img.alt = imgPath;
      img.src = convertFileSrc(absPath);
      img.addEventListener("load", () => { label.style.display = "none"; });
      img.addEventListener("error", () => { img.style.display = "none"; });
      inner.insertBefore(img, label);
    });
    wrap.appendChild(inner);
  }

  ignoreEvent() { return false; }
}

export class EmbedBlockWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly pos: number,
    readonly withPill: boolean,
  ) {
    super();
  }

  eq(other: EmbedBlockWidget) {
    return this.name === other.name && this.pos === other.pos && this.withPill === other.withPill;
  }

  get estimatedHeight(): number { return this.withPill ? 104 : 80; }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-embed-block";
    wrap.style.overflow = "hidden";
    if (this.withPill) wrap.appendChild(makeBlockPillRow("embed", this.pos, view));
    this.renderExpanded(wrap);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    dom.innerHTML = "";
    if (this.withPill) dom.appendChild(makeBlockPillRow("embed", this.pos, view));
    this.renderExpanded(dom);
    return true;
  }

  private renderExpanded(wrap: HTMLElement) {
    const header = document.createElement("div");
    header.className = "cm-typst-embed-header";

    const icon = document.createElement("span");
    icon.className = "cm-typst-embed-icon";
    icon.textContent = "↪";

    const label = document.createElement("span");
    label.className = "cm-typst-embed-label";
    label.textContent = this.name.replace(/\.typ$/, "");

    const embedName = this.name;

    const navBtn = document.createElement("span");
    navBtn.className = "cm-typst-embed-nav-btn";
    navBtn.title = `Open ${embedName.replace(/\.typ$/, "")}`;
    const navIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    navIcon.setAttribute("width", "14");
    navIcon.setAttribute("height", "14");
    navIcon.setAttribute("viewBox", "0 0 24 24");
    navIcon.setAttribute("fill", "none");
    navIcon.setAttribute("stroke", "currentColor");
    navIcon.setAttribute("stroke-width", "2");
    navIcon.setAttribute("stroke-linecap", "round");
    navIcon.setAttribute("stroke-linejoin", "round");
    navIcon.innerHTML =
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/>' +
      '<line x1="10" y1="14" x2="21" y2="3"/>';
    navBtn.appendChild(navIcon);
    navBtn.addEventListener("mousedown", (e) => {
      if (e.button === 2) return;
      e.preventDefault();
      e.stopPropagation();
      const newTab = e.ctrlKey || e.metaKey || e.button === 1;
      document.dispatchEvent(
        new CustomEvent("inkycap:navigate-wikilink", {
          detail: { target: embedName.replace(/\.typ$/, ""), newTab },
        }),
      );
    });
    navBtn.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(
          new CustomEvent("inkycap:navigate-wikilink", {
            detail: { target: embedName.replace(/\.typ$/, ""), newTab: true },
          }),
        );
      }
    });
    navBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.createElement("div");
      menu.style.cssText = "position:fixed;z-index:9999;background:var(--bg-primary);border:1px solid var(--border-primary);border-radius:4px;padding:4px 0;box-shadow:0 2px 8px rgba(0,0,0,0.2);font-size:13px;";
      const item = document.createElement("div");
      item.style.cssText = "padding:4px 12px;cursor:pointer;white-space:nowrap;";
      item.textContent = "Open in new tab";
      item.addEventListener("mouseenter", () => { item.style.backgroundColor = "var(--bg-hover)"; });
      item.addEventListener("mouseleave", () => { item.style.backgroundColor = ""; });
      item.addEventListener("click", () => {
        menu.remove();
        document.dispatchEvent(
          new CustomEvent("inkycap:navigate-wikilink", {
            detail: { target: embedName.replace(/\.typ$/, ""), newTab: true },
          }),
        );
      });
      menu.appendChild(item);
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      document.body.appendChild(menu);
      const dismiss = (ev: Event) => { if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("mousedown", dismiss); } };
      setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
    });

    header.appendChild(icon);
    header.appendChild(label);
    header.appendChild(navBtn);
    wrap.appendChild(header);

    const preview = document.createElement("div");
    preview.className = "cm-typst-embed-preview";
    preview.textContent = "Loading...";
    wrap.appendChild(preview);

    const baseName = embedName.replace(/\.typ$/, "");
    ipc.resolveWikilink(baseName).then(async (path) => {
      if (!path) {
        preview.textContent = "Note not found";
        preview.classList.add("cm-typst-embed-preview--error");
        return;
      }
      try {
        const content = await ipc.readFileContent(path);
        const lines = stripMetadata(content).split("\n")
          .filter((l) => l.trim() !== "")
          .slice(0, 4);
        preview.textContent = lines.join("\n") || "(empty note)";
      } catch {
        preview.textContent = "Could not load preview";
        preview.classList.add("cm-typst-embed-preview--error");
      }
    }).catch(() => {
      preview.textContent = "Could not load preview";
      preview.classList.add("cm-typst-embed-preview--error");
    });
  }

  ignoreEvent(e: Event) {
    if (e.type !== "mousedown") return false;
    const target = e.target as HTMLElement;
    return !!target.closest(".cm-typst-embed-nav-btn");
  }
}

export class EmbedWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: EmbedWidget) {
    return this.name === other.name && this.pos === other.pos;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-embed";

    const header = document.createElement("div");
    header.className = "cm-typst-embed-header";

    const icon = document.createElement("span");
    icon.className = "cm-typst-embed-icon";
    icon.textContent = "↪";

    const label = document.createElement("span");
    label.className = "cm-typst-embed-label";
    label.textContent = this.name.replace(/\.typ$/, "");

    const embedName = this.name;

    const navBtn = document.createElement("span");
    navBtn.className = "cm-typst-embed-nav-btn";
    navBtn.title = `Open ${embedName.replace(/\.typ$/, "")}`;
    const navIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    navIcon.setAttribute("width", "14");
    navIcon.setAttribute("height", "14");
    navIcon.setAttribute("viewBox", "0 0 24 24");
    navIcon.setAttribute("fill", "none");
    navIcon.setAttribute("stroke", "currentColor");
    navIcon.setAttribute("stroke-width", "2");
    navIcon.setAttribute("stroke-linecap", "round");
    navIcon.setAttribute("stroke-linejoin", "round");
    navIcon.innerHTML =
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/>' +
      '<line x1="10" y1="14" x2="21" y2="3"/>';
    navBtn.appendChild(navIcon);
    navBtn.addEventListener("mousedown", (e) => {
      if (e.button === 2) return;
      e.preventDefault();
      e.stopPropagation();
      const newTab = e.ctrlKey || e.metaKey || e.button === 1;
      document.dispatchEvent(
        new CustomEvent("inkycap:navigate-wikilink", {
          detail: { target: embedName.replace(/\.typ$/, ""), newTab },
        }),
      );
    });
    navBtn.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(
          new CustomEvent("inkycap:navigate-wikilink", {
            detail: { target: embedName.replace(/\.typ$/, ""), newTab: true },
          }),
        );
      }
    });
    navBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.createElement("div");
      menu.style.cssText = "position:fixed;z-index:9999;background:var(--bg-primary);border:1px solid var(--border-primary);border-radius:4px;padding:4px 0;box-shadow:0 2px 8px rgba(0,0,0,0.2);font-size:13px;";
      const item = document.createElement("div");
      item.style.cssText = "padding:4px 12px;cursor:pointer;white-space:nowrap;";
      item.textContent = "Open in new tab";
      item.addEventListener("mouseenter", () => { item.style.backgroundColor = "var(--bg-hover)"; });
      item.addEventListener("mouseleave", () => { item.style.backgroundColor = ""; });
      item.addEventListener("click", () => {
        menu.remove();
        document.dispatchEvent(
          new CustomEvent("inkycap:navigate-wikilink", {
            detail: { target: embedName.replace(/\.typ$/, ""), newTab: true },
          }),
        );
      });
      menu.appendChild(item);
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      document.body.appendChild(menu);
      const dismiss = (ev: Event) => { if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("mousedown", dismiss); } };
      setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
    });

    header.appendChild(icon);
    header.appendChild(label);
    header.appendChild(navBtn);
    wrap.appendChild(header);

    const preview = document.createElement("div");
    preview.className = "cm-typst-embed-preview";
    preview.textContent = "Loading...";
    wrap.appendChild(preview);

    const baseName = embedName.replace(/\.typ$/, "");
    ipc.resolveWikilink(baseName).then(async (path) => {
      if (!path) {
        preview.textContent = "Note not found";
        preview.classList.add("cm-typst-embed-preview--error");
        return;
      }
      try {
        const content = await ipc.readFileContent(path);
        const lines = stripMetadata(content).split("\n")
          .filter((l) => l.trim() !== "")
          .slice(0, 4);
        preview.textContent = lines.join("\n") || "(empty note)";
      } catch {
        preview.textContent = "Could not load preview";
        preview.classList.add("cm-typst-embed-preview--error");
      }
    }).catch(() => {
      preview.textContent = "Could not load preview";
      preview.classList.add("cm-typst-embed-preview--error");
    });

    return wrap;
  }

  ignoreEvent(e: Event) {
    if (e.type !== "mousedown") return false;
    const target = e.target as HTMLElement;
    return !!target.closest(".cm-typst-embed-nav-btn");
  }
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
      document.dispatchEvent(
        new CustomEvent("inkycap:navigate-wikilink", { detail: { target: this.target, label: this.label || undefined, newTab: true } }),
      );
    });
    return pill;
  }

  ignoreEvent() { return true; }
}

export class VerseWidget extends WidgetType {
  constructor(
    readonly body: string,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: VerseWidget) {
    return this.body === other.body;
  }

  toDOM(view: import("@codemirror/view").EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-verse";

    const label = document.createElement("span");
    label.className = "cm-typst-verse-label";
    label.textContent = "verse";
    wrap.appendChild(label);

    const textarea = document.createElement("textarea");
    textarea.className = "cm-typst-verse-textarea";
    textarea.value = this.body;
    textarea.rows = Math.max(this.body.split("\n").length, 2);
    textarea.spellcheck = false;

    const verseFrom = this.from;
    const verseTo = this.to;

    textarea.addEventListener("input", () => {
      const newBody = textarea.value;
      textarea.rows = Math.max(newBody.split("\n").length, 2);

      const fullText = view.state.doc.sliceString(verseFrom, verseTo);
      const openQuote = fullText.indexOf('"');
      const closeQuote = fullText.lastIndexOf('"');
      if (openQuote < 0 || closeQuote <= openQuote) return;

      const absFrom = verseFrom + openQuote + 1;
      const absTo = verseFrom + closeQuote;

      view.dispatch({
        changes: { from: absFrom, to: absTo, insert: newBody },
      });
    });

    textarea.addEventListener("keydown", (e) => {
      e.stopPropagation();
    });

    wrap.appendChild(textarea);
    return wrap;
  }

  ignoreEvent(e: Event) {
    return e.type === "mousedown" || e.type === "input" || e.type === "keydown";
  }
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
// we render a pill placeholder that shows its presence and source path. The
// pill is clickable: clicking dispatches `expandFunc`, which exposes the
// raw `#bibliography(...)` source so the user can inspect or change it.
// When the cursor leaves the line the pill returns.
export class BibliographyBlockWidget extends WidgetType {
  constructor(readonly path: string, readonly pos: number) { super(); }

  eq(other: BibliographyBlockWidget) {
    return this.path === other.path && this.pos === other.pos;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-bibliography-block";

    const chip = document.createElement("span");
    chip.className = "cm-typst-func-chip";
    chip.title = "bibliography";
    const hash = document.createElement("span");
    hash.className = "cm-typst-func-chip-hash";
    chip.appendChild(hash);
    const chipLabel = document.createElement("span");
    chipLabel.textContent = "bibliography";
    chip.appendChild(chipLabel);
    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        effects: expandFunc.of(this.pos),
        selection: { anchor: this.pos + 1 },
      });
    });
    wrap.appendChild(chip);

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
    icon.innerHTML =
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/>' +
      '<line x1="10" y1="14" x2="21" y2="3"/>';
    el.appendChild(icon);

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      shellOpen(this.url);
    });
    return el;
  }

  ignoreEvent() { return true; }
}

export class CitationWidget extends WidgetType {
  constructor(readonly key: string) {
    super();
  }

  eq(other: CitationWidget) {
    return this.key === other.key;
  }

  toDOM() {
    const pill = document.createElement("span");
    pill.className = "cm-typst-citation";
    pill.textContent = `@${this.key}`;
    return pill;
  }

  ignoreEvent() { return false; }
}
