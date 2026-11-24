import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { joinScrollSync, type ScrollSyncMember } from "./scroll-sync";

/** A pane 100px tall whose content is `height` px and whose source has 100
 *  lines, spread evenly. */
function pane(height: number) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "scrollHeight", { value: height });
  Object.defineProperty(scroller, "clientHeight", { value: 100 });
  return {
    scroller,
    content: document.createElement("div"),
    positionAt: (offset: number) => (offset / height) * 100,
    offsetOf: (position: number) => (position / 100) * height,
  };
}

describe("joinScrollSync", () => {
  let members: ScrollSyncMember[] = [];
  let editor: ReturnType<typeof pane>;
  let preview: ReturnType<typeof pane>;

  function join(key: string, p: ReturnType<typeof pane>, leadsByDefault: boolean) {
    const member = joinScrollSync(key, { ...p, leadsByDefault });
    members.push(member);
    return member;
  }
  const frames = () => vi.advanceTimersByTime(100);
  /** What a user's scroll does: the offset changes and an event follows. */
  function scroll(p: ReturnType<typeof pane>, top: number) {
    p.scroller.scrollTop = top;
    p.scroller.dispatchEvent(new Event("scroll"));
    frames();
  }

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"],
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    editor = pane(1100);
    preview = pane(2100);
  });

  afterEach(() => {
    members.forEach((m) => m.leave());
    members = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("moves each pane to match the other, reaching the end together", () => {
    join("a", editor, true);
    join("a", preview, false);
    scroll(editor, 500);
    expect(preview.scroller.scrollTop).toBeCloseTo(1000);
    scroll(editor, 1000);
    expect(preview.scroller.scrollTop).toBeCloseTo(2000);

    preview.scroller.dispatchEvent(new Event("wheel"));
    scroll(preview, 400);
    expect(editor.scroller.scrollTop).toBeCloseTo(200);
  });

  it("brings a newly opened preview to the editor's place", () => {
    editor.scroller.scrollTop = 300;
    join("a", preview, false);
    join("a", editor, true);
    frames();
    expect(preview.scroller.scrollTop).toBeCloseTo(600);
    expect(editor.scroller.scrollTop).toBe(300);
  });

  it("doesn't let the following pane's own scroll event lead", () => {
    join("a", editor, true);
    join("a", preview, false);
    scroll(editor, 500);
    vi.advanceTimersByTime(1000);
    scroll(preview, 1000.4);
    expect(editor.scroller.scrollTop).toBe(500);
  });

  it("ignores a scroll position lost while the preview's content is replaced", () => {
    join("a", editor, true);
    const member = join("a", preview, false);
    scroll(editor, 500);
    vi.advanceTimersByTime(1000);
    member.contentReplaced();
    preview.scroller.scrollTop = 0;
    preview.scroller.dispatchEvent(new Event("scroll"));
    frames();
    expect(editor.scroller.scrollTop).toBe(500);
    expect(preview.scroller.scrollTop).toBeCloseTo(1000);
  });

  it("leaves panes of another group, or that have left, alone", () => {
    const member = join("a", editor, true);
    join("b", preview, false);
    scroll(editor, 500);
    expect(preview.scroller.scrollTop).toBe(0);
    join("a", preview, false);
    member.leave();
    scroll(preview, 700);
    expect(editor.scroller.scrollTop).toBe(500);
  });
});
