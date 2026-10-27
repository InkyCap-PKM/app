import { EditorView, WidgetType } from "@codemirror/view";
import { buildPillButton, findCallEnd } from "./pill";
import { getPillOptions } from "./pill-options";
import { expandFunc } from "./effects";
import { revealAnnotation } from "./annotation-reveal";
import type { CommentRun } from "./comments";
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
 * Chip for the leading run of `#set` / `#show` rules (the style preamble),
 * replacing the whole block so configuration doesn't clutter the visual editor.
 * Uses {@link buildPillButton}: left-click reveals the source
 * (`alwaysExpandOnClick`, since a multi-line block would otherwise open the
 * menu), and right-click or Enter opens the standard menu for the whole block. It
 * collapses again when the cursor leaves (see visual-plugin). `from` / `to` bound
 * its lines.
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
    count.className = "cm-typst-pill-count";
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
        hides: () => ({ from: this.from, to: this.to }),
      },
    );
    row.appendChild(btn);
    return row;
  }
  ignoreEvent() { return true; }
}

/** Longest stretch of source a pill's hover tooltip shows. */
const PILL_TOOLTIP_MAX = 400;

function tooltipText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PILL_TOOLTIP_MAX ? `${trimmed.slice(0, PILL_TOOLTIP_MAX)}…` : trimmed;
}

/**
 * An annotation (`#annotation[…]`). A reviewer's remark isn't part of the
 * writing, so only a pill marks it; hovering shows the comment, and clicking
 * reveals the source and opens Changes & History on it. `summary` is the
 * comment with attribution, for the tooltip.
 */
export class AnnotationPillWidget extends WidgetType {
  constructor(readonly pos: number, readonly summary: string) { super(); }
  eq(other: AnnotationPillWidget) {
    return this.pos === other.pos && this.summary === other.summary;
  }
  toDOM(view: EditorView) {
    return buildPillButton(
      "annotation",
      view,
      () => {
        const callTo = findCallEnd(view, this.pos);
        return {
          funcName: "annotation",
          callFrom: this.pos,
          callTo,
          optionSections: getPillOptions("annotation", view, this.pos, callTo),
          alwaysExpandOnClick: true,
          onEditSource: (v) => {
            v.dispatch({ effects: expandFunc.of(this.pos), selection: { anchor: this.pos + 1 } });
            v.focus();
            revealAnnotation(this.pos);
          },
        };
      },
      {
        title: tooltipText(this.summary),
        hides: () => ({ from: this.pos, to: findCallEnd(view, this.pos) }),
      },
    );
  }
  ignoreEvent() { return true; }
}

/**
 * A run of Typst comments. They don't appear in the output but the caret still
 * moves around them, so a pill marks each run. Hovering shows the comment;
 * clicking reveals it with the caret at its end. A multi-line run shows its line
 * count.
 */
export class CommentPillWidget extends WidgetType {
  constructor(readonly run: CommentRun, readonly raw: string) { super(); }
  eq(other: CommentPillWidget) {
    return this.run.from === other.run.from && this.run.to === other.run.to
      && this.run.lines === other.run.lines && this.raw === other.raw;
  }
  toDOM(view: EditorView) {
    let accessory: HTMLElement | undefined;
    if (this.run.lines > 1) {
      accessory = document.createElement("span");
      accessory.className = "cm-typst-pill-count";
      accessory.textContent = tPlural("editor.comment.lines", this.run.lines);
    }
    const label = t("editor.comment.label");
    return buildPillButton(
      label,
      view,
      () => ({
        funcName: label,
        callFrom: this.run.from,
        callTo: this.run.to,
        alwaysExpandOnClick: true,
        onEditSource: (v) => {
          v.dispatch({ effects: expandFunc.of(this.run.from), selection: { anchor: this.run.to } });
          v.focus();
        },
      }),
      {
        label,
        title: tooltipText(this.raw),
        accessory,
        hides: () => ({ from: this.run.from, to: this.run.to }),
      },
    );
  }
  ignoreEvent() { return true; }
}

/**
 * Pill for a `#set` / `#show` rule after content, such as `#set text(…)` / `#set
 * par(…)` from the `/` Style menu (a leading run is the preamble; see {@link
 * StylePreambleWidget}). Shows the keyword and target (e.g. `set text`);
 * left-click reveals simple rules for editing or opens the menu, right-click or
 * Enter opens the standard menu. `from` / `to` include the `#`; `raw` is shown
 * on hover.
 */
export class SetRuleWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly label: string,
    readonly raw: string,
  ) { super(); }
  eq(other: SetRuleWidget) {
    return this.from === other.from && this.to === other.to
      && this.label === other.label && this.raw === other.raw;
  }
  toDOM(view: EditorView) {
    return buildPillButton(
      this.label,
      view,
      () => ({
        funcName: this.label,
        callFrom: this.from,
        callTo: this.to,
      }),
      {
        label: this.label,
        title: this.raw,
        hides: () => ({ from: this.from, to: this.to }),
      },
    );
  }
  ignoreEvent() { return true; }
}

/**
 * Pill for a `#sym.*` reference (e.g. `#sym.arrow.r`), showing the glyph for
 * known symbols, otherwise the dotted name. Its menu (`symOptions` in
 * pill-options) has a name field, so any symbol can be set. `from` / `to` bound
 * the whole reference.
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
      {
        label: this.glyph ?? this.path,
        title: `#sym.${this.path}`,
        hides: () => ({ from: this.from, to: this.to }),
      },
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

/**
 * A `#line(...)` rule. With the caret on it, the pill floats over the rule's
 * left end instead of replacing it, so the height doesn't change.
 */
export class HrWidget extends WidgetType {
  constructor(readonly pos: number, readonly withPill: boolean) { super(); }
  eq(other: HrWidget) { return this.pos === other.pos && this.withPill === other.withPill; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-typst-hr-block";
    const rule = document.createElement("hr");
    rule.className = "cm-typst-hr";
    wrap.appendChild(rule);
    if (this.withPill) {
      const row = document.createElement("div");
      row.className = "cm-typst-block-pill-row cm-typst-block-pill-overlay";
      row.appendChild(buildPillButton("line", view, () => {
        const callTo = findCallEnd(view, this.pos);
        return {
          funcName: "line",
          callFrom: this.pos,
          callTo,
          optionSections: getPillOptions("line", view, this.pos, callTo),
        };
      }));
      wrap.appendChild(row);
    }
    return wrap;
  }
  // The rule is inert and the pill handles its own mouse events.
  ignoreEvent() { return true; }
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
