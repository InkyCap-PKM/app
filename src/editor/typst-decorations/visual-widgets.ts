import { EditorView, WidgetType } from "@codemirror/view";
import { buildPillButton, findCallEnd } from "./pill";
import { getPillOptions } from "./pill-options";

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
  constructor(readonly rendered: string, readonly raw: string) { super(); }
  eq(other: ShorthandWidget) { return this.rendered === other.rendered; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-typst-shorthand";
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
