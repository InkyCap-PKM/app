import { describe, it, expect, afterEach } from "vitest";
import { EditorState, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildPillButton } from "./pill";
import { expandFunc } from "./effects";

// Every pill answers a click the same way: it opens its menu. Editing the
// source is one of the menu's items, never what the click itself does.

const CALL = "#strike[gone]";
const views: EditorView[] = [];

afterEach(() => {
  document.querySelectorAll(".cm-typst-pill-menu").forEach((m) => m.remove());
  while (views.length) views.pop()!.destroy();
});

function mountPill() {
  const effects: StateEffect<unknown>[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc: CALL,
      extensions: [EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) effects.push(...tr.effects);
      })],
    }),
    parent: document.body,
  });
  views.push(view);
  const pill = buildPillButton("strike", view, () => ({
    funcName: "strike",
    callFrom: 0,
    callTo: CALL.length,
  }));
  document.body.appendChild(pill);
  const expanded = () => effects.some((e) => e.is(expandFunc));
  return { pill, expanded };
}

const menu = () => document.querySelector<HTMLElement>(".cm-typst-pill-menu");
const menuItem = (label: string) =>
  [...(menu()?.querySelectorAll<HTMLElement>(".cm-typst-pill-menu-item") ?? [])]
    .find((el) => el.textContent?.includes(label));

describe("clicking a pill", () => {
  it("opens the menu and leaves the source collapsed", () => {
    const { pill, expanded } = mountPill();
    pill.click();
    expect(menu()).not.toBeNull();
    expect(expanded()).toBe(false);
  });

  it("opens the same menu on right-click", () => {
    const { pill } = mountPill();
    pill.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(menu()).not.toBeNull();
  });

  it("reveals the source from the menu's Edit source", () => {
    const { pill, expanded } = mountPill();
    pill.click();
    const edit = menuItem("Edit source");
    expect(edit).toBeTruthy();
    edit!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    edit!.click();
    expect(expanded()).toBe(true);
  });
});
