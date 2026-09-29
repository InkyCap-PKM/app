import { describe, it, expect, afterEach } from "vitest";
import {
  trackWrite,
  awaitPendingWrite,
  flushEditorsAt,
  moveOpenEditors,
  FLUSH_EDITOR_EVENT,
  EDITOR_PATH_MOVED_EVENT,
} from "./editor-writes";

/** A write the test finishes by hand. */
function manualWrite() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => (finish = resolve));
  return { promise, finish };
}

const listeners: [string, EventListener][] = [];
function on(type: string, listener: EventListener) {
  document.addEventListener(type, listener);
  listeners.push([type, listener]);
}
afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) {
    document.removeEventListener(type, listener);
  }
});

describe("awaitPendingWrite", () => {
  it("waits for every write to the same note, not only the latest", async () => {
    const first = manualWrite();
    const second = manualWrite();
    trackWrite("/nb/a.typ", first.promise);
    trackWrite("/nb/a.typ", second.promise);
    let done = false;
    const wait = awaitPendingWrite("/nb/a.typ").then(() => (done = true));
    second.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    first.finish();
    await wait;
    expect(done).toBe(true);
  });

  it("treats backslash and forward-slash paths as the same note", async () => {
    const write = manualWrite();
    trackWrite("C:\\nb\\a.typ", write.promise);
    let done = false;
    const wait = awaitPendingWrite("C:/nb/a.typ").then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    write.finish();
    await wait;
    expect(done).toBe(true);
  });
});

describe("flushEditorsAt", () => {
  it("asks editors to save and waits for the writes they start", async () => {
    const write = manualWrite();
    on(FLUSH_EDITOR_EVENT, (e) => {
      // An editor answering the request registers its write synchronously.
      expect((e as CustomEvent).detail.path).toBe("/nb/a.typ");
      trackWrite("/nb/a.typ", write.promise);
    });
    let done = false;
    const flushed = flushEditorsAt("/nb/a.typ").then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    write.finish();
    await flushed;
    expect(done).toBe(true);
  });

  it("covers notes inside a folder, but not a sibling with a longer name", async () => {
    const inside = manualWrite();
    const sibling = manualWrite();
    trackWrite("/nb/Box/a.typ", inside.promise);
    trackWrite("/nb/Boxes/b.typ", sibling.promise);
    let done = false;
    const flushed = flushEditorsAt("/nb/Box").then(() => (done = true));
    inside.finish();
    await flushed;
    expect(done).toBe(true);
    sibling.finish();
  });

  it("does not wait on a failed write", async () => {
    trackWrite("/nb/a.typ", Promise.reject(new Error("disk full")));
    await expect(flushEditorsAt("/nb/a.typ")).resolves.toBeUndefined();
  });
});

describe("moveOpenEditors", () => {
  it("tells open editors the old and new path", () => {
    const seen: unknown[] = [];
    on(EDITOR_PATH_MOVED_EVENT, (e) => seen.push((e as CustomEvent).detail));
    moveOpenEditors("/nb/old.typ", "/nb/new.typ");
    expect(seen).toEqual([{ from: "/nb/old.typ", to: "/nb/new.typ" }]);
  });
});
