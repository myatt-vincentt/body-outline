import { describe, expect, it } from "vitest";

import { createMotion, updateMotion } from "./motion";

const box = (w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
  const indices = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) indices[y * w + x] = 1;
  return { width: w, height: h, indices };
};

describe("motion", () => {
  it("finds the centre (top-left origin) and only edge cells as edges", () => {
    const m = createMotion(10, 10);
    updateMotion(m, box(100, 100, 20, 30, 60, 70), 1, 1 / 24);
    expect(m.centre?.[0]).toBeCloseTo(0.4, 1);
    expect(m.centre?.[1]).toBeCloseTo(0.5, 1);
    expect(m.active).toBe(16);
    expect(m.edgeCount).toBe(12); // a 4×4 block has 12 border cells
  });

  it("stays calm when still and pulses when the silhouette moves", () => {
    const m = createMotion(20, 20);
    const a = box(100, 100, 20, 20, 50, 80);
    const b = box(100, 100, 45, 20, 75, 80);
    for (let i = 0; i < 24; i++) updateMotion(m, a, 1, 1 / 24);
    expect(m.pulse).toBeLessThan(0.01);
    for (let i = 0; i < 12; i++) updateMotion(m, i % 2 ? a : b, 1, 1 / 24);
    expect(m.pulse).toBeGreaterThan(0.5);
    for (let i = 0; i < 72; i++) updateMotion(m, a, 1, 1 / 24);
    expect(m.pulse).toBeLessThan(0.1);
  });

  it("has no centre and no edges with nobody in view", () => {
    const m = createMotion(8, 8);
    updateMotion(m, box(80, 80, 0, 0, 0, 0), 1, 1 / 24);
    expect(m.centre).toBeNull();
    expect(m.edgeCount).toBe(0);
  });

  it("finds the feet under a standing figure; legs running off the bottom glow at the edge, a torso doesn't", () => {
    const m = createMotion(10, 10);
    // Figure from y 10..80 of 100, feet spanning x 30..60.
    updateMotion(m, box(100, 100, 30, 10, 60, 80), 1, 1 / 24);
    expect(m.foot).not.toBeNull();
    expect(m.foot?.x).toBeCloseTo(0.45, 1);
    expect(m.foot?.y).toBeCloseTo(0.8, 1);
    expect(m.foot?.width).toBeCloseTo(0.3, 1);
    // Legs (30 % wide) running off the bottom: glow at the bottom edge.
    updateMotion(m, box(100, 100, 30, 10, 60, 100), 1, 1 / 24);
    expect(m.foot?.y).toBeCloseTo(1, 1);
    // A torso (70 % wide) running off the bottom: no floor in view.
    updateMotion(m, box(100, 100, 15, 10, 85, 100), 1, 1 / 24);
    expect(m.foot).toBeNull();
  });
});
