// Vitest setup, run in jsdom before the tests.
//
// jsdom has no layout, so geometry methods like `Range.getClientRects()` are
// missing. CodeMirror calls them to position popups (`coordsAtPos()`), in a
// `requestAnimationFrame`, so the error would surface after the test as an
// unhandled rejection and make the exit code flaky.
//
// These stubs return empty rects (so popups just aren't positioned), and are
// only added where jsdom lacks the method. Cast through `Record` because lib.dom
// types them as always present.

function emptyRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function emptyRectList(): DOMRectList {
  return {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  } as unknown as DOMRectList;
}

function stubGeometry(proto: object): void {
  const p = proto as unknown as Record<string, unknown>;
  if (typeof p.getClientRects !== "function") {
    p.getClientRects = () => emptyRectList();
  }
  if (typeof p.getBoundingClientRect !== "function") {
    p.getBoundingClientRect = () => emptyRect();
  }
  // Scrolling is layout too: any list that keeps a highlighted row in view
  // calls this, and jsdom has no implementation at all.
  if (typeof p.scrollIntoView !== "function") {
    p.scrollIntoView = () => {};
  }
}

if (typeof Range !== "undefined") stubGeometry(Range.prototype);
if (typeof Element !== "undefined") stubGeometry(Element.prototype);
