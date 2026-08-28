import { describe, it, expect } from "vitest";
import { computePlacement, type AnchorCoords } from "./popup-position";

const VIEWPORT = { width: 1000, height: 800 };

/** A 20px-tall caret-ish anchor at (x, y). */
function anchorAt(x: number, y: number, width = 0, height = 20): AnchorCoords {
  return { left: x, right: x + width, top: y, bottom: y + height };
}

const GAP = 4;
const MARGIN = 8;

describe("computePlacement", () => {
  it("opens below the anchor when there is room (the default)", () => {
    const p = computePlacement(anchorAt(100, 100), { width: 200, height: 260 }, VIEWPORT);
    expect(p.side).toBe("below");
    expect(p.top).toBe(120 + GAP);
    expect(p.left).toBe(100);
  });

  it("flips above when the popup would be clipped at the bottom", () => {
    // Anchor near the bottom: 800 - 720 - 8 = 72px below, not enough for 260.
    const p = computePlacement(anchorAt(100, 700), { width: 200, height: 260 }, VIEWPORT);
    expect(p.side).toBe("above");
    expect(p.top).toBe(700 - 260 - GAP);
  });

  it("stays below when neither side fits but below has more room", () => {
    const p = computePlacement(anchorAt(100, 40), { width: 200, height: 900 }, VIEWPORT);
    expect(p.side).toBe("below");
    // Clamped to the top margin rather than pushed off the bottom.
    expect(p.top).toBe(MARGIN);
  });

  it("clamps to the right edge instead of overflowing", () => {
    const p = computePlacement(anchorAt(950, 100), { width: 200, height: 100 }, VIEWPORT);
    expect(p.left).toBe(1000 - 200 - MARGIN);
  });

  it("clamps to the left edge instead of overflowing", () => {
    const p = computePlacement(anchorAt(-40, 100), { width: 200, height: 100 }, VIEWPORT);
    expect(p.left).toBe(MARGIN);
  });

  it("pins the leading edge when the popup is wider than the viewport", () => {
    const p = computePlacement(anchorAt(100, 100), { width: 1400, height: 100 }, VIEWPORT);
    expect(p.left).toBe(MARGIN);
  });
});

describe("computePlacement with prefer: above (the selection toolbar)", () => {
  const size = { width: 400, height: 36 };
  const opts = { prefer: "above", align: "center", gap: 8 } as const;

  it("opens above the selection and centres on it", () => {
    // Selection box spanning x 300–500, y 400–420.
    const p = computePlacement(
      { left: 300, right: 500, top: 400, bottom: 420 },
      size,
      VIEWPORT,
      opts,
    );
    expect(p.side).toBe("above");
    expect(p.top).toBe(400 - 36 - 8);
    expect(p.left).toBe(400 - 200); // centred on x=400
  });

  it("flips below the selection's last line when there is no room above", () => {
    const p = computePlacement(
      { left: 300, right: 500, top: 10, bottom: 30 },
      size,
      VIEWPORT,
      opts,
    );
    expect(p.side).toBe("below");
    expect(p.top).toBe(30 + 8);
  });

  it("clamps horizontally when the selection hugs the right margin", () => {
    const p = computePlacement(
      { left: 900, right: 990, top: 400, bottom: 420 },
      size,
      VIEWPORT,
      opts,
    );
    // Centring would put it at 945 - 200 = 745, whose right edge is 1145.
    expect(p.left).toBe(1000 - 400 - MARGIN);
  });
});
