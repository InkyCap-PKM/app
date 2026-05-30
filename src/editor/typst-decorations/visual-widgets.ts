import { EditorView, WidgetType } from "@codemirror/view";
import { buildPillButton, findCallEnd } from "./pill";
import { getPillOptions } from "./pill-options";
import { t, tPlural } from "../../lib/i18n";

export class FuncPillWidget extends WidgetType {
  constructor(readonly pos: number, readonly funcName: string) { super(); }
  eq(other: FuncPillWidget) { return this.pos === other.pos && this.funcName === other.funcName; }
  toDOM(view: EditorView) {
    return buildPillButton(this.funcName, view, () => {
      const callTo = findCallEnd(view, this.pos);
      return {
        funcName: this.funcName,
        callFrom: this.pos,
        callTo,
        optionSections: getPillOptions(this.funcName, view, this.pos, callTo),
      };
    });
  }
  ignoreEvent() { return true; }
}

export class FuncChipWidget extends WidgetType {
  constructor(readonly pos: number, readonly funcName: string) { super(); }
  eq(other: FuncChipWidget) { return this.pos === other.pos && this.funcName === other.funcName; }
  toDOM(view: EditorView) {
    return buildPillButton(this.funcName, view, () => {
      const callTo = findCallEnd(view, this.pos);
      return {
        funcName: this.funcName,
        callFrom: this.pos,
        callTo,
        optionSections: getPillOptions(this.funcName, view, this.pos, callTo),
      };
    });
  }
  ignoreEvent() { return true; }
}


/**
 * Collapsed affordance for a contiguous leading run of `#set` / `#show` rules
 * (the "document style preamble"). Replaces the whole multi-line block with a
 * single chip so the visual editor isn't cluttered with configuration markup.
 *
 * Routes through {@link buildPillButton} so it inherits the universal pill
 * behaviour: left-click reveals the raw source for editing (`alwaysExpandOnClick`
 * — the block is multi-line, so it would otherwise be classed "complex" and
 * open the menu), and right-click / Enter open the standard super-menu (Edit
 * source / Open in source editor / Copy / Duplicate / Delete) acting on the
 * whole block. The block re-collapses once the cursor leaves (handled in
 * visual-plugin's collapse decision). `from`/`to` bound the block's lines.
 */
export class StylePreambleWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly count: number) { super(); }
  eq(other: StylePreambleWidget) {
    return this.from === other.from && this.to === other.to && this.count === other.count;
  }
  toDOM(view: EditorView) {
    const row = document.createElement("div");
    row.className = "cm-typst-block-pill-row cm-typst-style-preamble";

    const count = document.createElement("span");
    count.className = "cm-typst-style-preamble-count";
    count.textContent = tPlural("editor.stylePreamble.count", this.count);

    const btn = buildPillButton(
      "set",
      view,
      () => ({
        funcName: t("editor.stylePreamble.label"),
        callFrom: this.from,
        callTo: this.to,
        alwaysExpandOnClick: true,
      }),
      {
        label: t("editor.stylePreamble.label"),
        title: t("editor.stylePreamble.hint"),
        accessory: count,
      },
    );
    row.appendChild(btn);
    return row;
  }
  ignoreEvent() { return true; }
}

/**
 * Pill for a `#sym.*` named-symbol reference (a `FieldAccess` code expression,
 * e.g. `#sym.arrow.r`). Renders the resolved glyph when the symbol is in the
 * curated set, otherwise the raw dotted name — either way clearer than the raw
 * `#sym.…` markup. Routes through {@link buildPillButton} so it gets the
 * standard pill behaviour; the pill menu (see pill-options `symOptions`) carries
 * a name input so any symbol can be entered/changed without touching source.
 * `from`/`to` bound the whole `#sym.…` reference.
 */
export class SymWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly path: string,
    readonly glyph: string | null,
  ) { super(); }
  eq(other: SymWidget) {
    return this.from === other.from && this.to === other.to
      && this.path === other.path && this.glyph === other.glyph;
  }
  toDOM(view: EditorView) {
    return buildPillButton(
      "sym",
      view,
      () => ({
        funcName: "sym",
        callFrom: this.from,
        callTo: this.to,
        optionSections: getPillOptions("sym", view, this.from, this.to),
      }),
      { label: this.glyph ?? this.path, title: `#sym.${this.path}` },
    );
  }
  ignoreEvent() { return true; }
}

export class BulletWidget extends WidgetType {
  constructor(readonly marker: string) { super(); }
  eq(other: BulletWidget) { return this.marker === other.marker; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-typst-list-bullet";
    el.textContent = this.marker;
    return el;
  }
}

export class ShorthandWidget extends WidgetType {
  constructor(readonly rendered: string, readonly raw: string, readonly ghost = false) { super(); }
  eq(other: ShorthandWidget) { return this.rendered === other.rendered && this.ghost === other.ghost; }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.ghost ? "cm-typst-shorthand cm-typst-shorthand--ghost" : "cm-typst-shorthand";
    el.textContent = this.rendered;
    el.title = this.raw;
    return el;
  }
}

export class HrWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("hr");
    el.className = "cm-typst-hr";
    return el;
  }
}

export const ANGLE_BRACKET_TAGS = /(?<!\\)<(script|style|iframe|object|embed|form|input|link|meta|base)(?:\s|>|\/)/gi;

export class AngleBracketWarningWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly tag: string) { super(); }
  eq(other: AngleBracketWarningWidget) { return this.from === other.from && this.tag === other.tag; }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-typst-angle-bracket-warning";
    el.title = `Bare <${this.tag}> is ambiguous in Typst — click to escape as \\<${this.tag}>`;
    el.textContent = "⚠";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = view.state.doc.sliceString(this.from, this.to);
      const escaped = text.replace(/</g, "\\<");
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: escaped },
      });
    });
    return el;
  }
  ignoreEvent() { return true; }
}
