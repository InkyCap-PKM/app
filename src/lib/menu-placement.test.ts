import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fit, placeMenu } from "./menu-placement";

describe("fit", () => {
  it("keeps a position that already fits", () => {
    expect(fit(100, 200, 1000)).toBe(100);
  });

  it("opens backwards from the requested point when it would overflow", () => {
    // Asked for at 900 in a 1000px window: 300 tall does not fit below, so it
    // ends at the click instead.
    expect(fit(900, 300, 1000)).toBe(600);
  });

  it("pushes against the far edge when neither direction fits", () => {
    expect(fit(150, 300, 400)).toBe(92);
  });

  it("never starts before the margin", () => {
    expect(fit(2, 50, 1000)).toBe(8);
    expect(fit(10, 2000, 1000)).toBe(8);
  });
});

describe("placeMenu", () => {
  let menu: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.position = "fixed";
    document.body.appendChild(menu);
    menu.getBoundingClientRect = () =>
      ({ width: 180, height: 300, top: 0, left: 0, right: 180, bottom: 300 }) as DOMRect;
  });

  afterEach(() => {
    menu.remove();
    vi.unstubAllGlobals();
  });

  it("moves a menu opened near the bottom-right corner fully into view", () => {
    menu.style.left = "950px";
    menu.style.top = "700px";
    placeMenu(menu);
    expect(menu.style.left).toBe("770px");
    expect(menu.style.top).toBe("400px");
  });

  it("re-places the menu when its owner moves it", () => {
    menu.style.left = "950px";
    menu.style.top = "700px";
    placeMenu(menu);
    menu.style.left = "20px";
    menu.style.top = "20px";
    placeMenu(menu);
    expect(menu.style.left).toBe("20px");
    expect(menu.style.top).toBe("20px");
  });

  it("leaves menus that are not fixed-position alone", () => {
    menu.style.position = "absolute";
    menu.style.left = "950px";
    menu.style.top = "700px";
    placeMenu(menu);
    expect(menu.style.left).toBe("950px");
  });
});
