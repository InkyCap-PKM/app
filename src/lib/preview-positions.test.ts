import { describe, it, expect } from "vitest";
import { interpolate, orderedAnchors } from "./preview-positions";

describe("orderedAnchors", () => {
  it("adds the ends of the content", () => {
    expect(orderedAnchors([{ position: 5, offset: 100 }], 400)).toEqual([
      { position: 1, offset: 0 },
      { position: 5, offset: 100 },
      { position: 6, offset: 400 },
    ]);
  });

  it("drops content shown out of source order, such as an outline or footnotes", () => {
    const outline = [
      { position: 10, offset: 10 },
      { position: 30, offset: 20 },
    ];
    const body = [4, 10, 20, 30, 40].map((position, i) => ({ position, offset: 100 + i * 50 }));
    const footnotes = [
      { position: 12, offset: 500 },
      { position: 22, offset: 520 },
    ];
    const run = orderedAnchors([...outline, ...body, ...footnotes], 600).slice(1, -1);
    expect(run).toEqual(body);
  });

  it("keeps positions and offsets strictly increasing", () => {
    const run = orderedAnchors(
      [
        { position: 3, offset: 50 },
        { position: 4, offset: 50 },
        { position: 4, offset: 80 },
        { position: 7, offset: 90 },
      ],
      200,
    );
    for (let i = 1; i < run.length; i++) {
      expect(run[i].position).toBeGreaterThan(run[i - 1].position);
      expect(run[i].offset).toBeGreaterThan(run[i - 1].offset);
    }
  });
});

describe("interpolate", () => {
  const anchors = orderedAnchors(
    [
      { position: 5, offset: 100 },
      { position: 9, offset: 300 },
    ],
    400,
  );

  it("reads between anchors, in both directions", () => {
    expect(interpolate(anchors, "position", "offset", 7)).toBe(200);
    expect(interpolate(anchors, "offset", "position", 200)).toBe(7);
  });

  it("stops at the ends", () => {
    expect(interpolate(anchors, "position", "offset", 99)).toBe(400);
    expect(interpolate(anchors, "offset", "position", -5)).toBe(1);
  });
});
