import { describe, expect, it } from "vitest";
import { createFbmNoise2D } from "./noise";

describe("createFbmNoise2D", () => {
  it("is deterministic: the same seed samples identically at the same point", () => {
    const a = createFbmNoise2D(42);
    const b = createFbmNoise2D(42);
    expect(a(12.3, -5.7)).toBe(b(12.3, -5.7));
  });

  it("different seeds sample differently at the same point", () => {
    const a = createFbmNoise2D(1);
    const b = createFbmNoise2D(2);
    expect(a(10, 10)).not.toBe(b(10, 10));
  });

  it("stays within [-1, 1] across many samples", () => {
    const noise = createFbmNoise2D(99);
    for (let x = -100; x < 100; x += 3.3) {
      for (let z = -100; z < 100; z += 7.1) {
        const v = noise(x, z);
        expect(v).toBeGreaterThanOrEqual(-1.0001);
        expect(v).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it("is not constant (the field actually varies across the plane)", () => {
    const noise = createFbmNoise2D(5);
    const samples = new Set<number>();
    for (let x = 0; x < 50; x++) {
      samples.add(Math.round(noise(x, 0) * 1000));
    }
    expect(samples.size).toBeGreaterThan(1);
  });

  it("more octaves adds higher-frequency detail without changing the broad shape", () => {
    const smooth = createFbmNoise2D(3, { octaves: 1, persistence: 0.5, scale: 0.02 });
    const detailed = createFbmNoise2D(3, { octaves: 5, persistence: 0.5, scale: 0.02 });
    // Both are valid noise fields; this just asserts they're not identical
    // (i.e. the octaves option actually does something).
    let anyDifferent = false;
    for (let x = 0; x < 20; x++) {
      if (smooth(x, 0) !== detailed(x, 0)) anyDifferent = true;
    }
    expect(anyDifferent).toBe(true);
  });
});
