// Vitest setup — runs in the jsdom environment before any test.
//
// jsdom has no layout/rendering engine, so element/range geometry methods are
// missing or absent. CodeMirror's `coordsAtPos()` calls `Range.getClientRects()`
// to position popups (e.g. the wikilink autocomplete) — in jsdom that throws
// `getClientRects is not a function`, and because the call is scheduled in a
// `requestAnimationFrame` callback it surfaces *after* the test as an unhandled
// rejection (making the suite's exit code flaky) rather than a real failure.
//
// Stub the geometry methods to return empty rects so editor code under test
// no-ops cleanly (coordsAtPos then returns null and the popup simply isn't
// positioned). We only fill in what jsdom is missing — `??`-style guards leave
// any real implementation untouched. Cast through `Record` because lib.dom
// types these as always-present, which they are in a real browser.

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
}

if (typeof Range !== "undefined") stubGeometry(Range.prototype);
if (typeof Element !== "undefined") stubGeometry(Element.prototype);
