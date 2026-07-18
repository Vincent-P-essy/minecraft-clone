import { describe, expect, it } from "vitest";
import { deriveSeed, mulberry32 } from "./rng";

describe("mulberry32", () => {
  it("is deterministic: the same seed produces the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("always returns a value in [0, 1)", () => {
    const rng = mulberry32(123456);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("does not repeat within a short run (basic sanity, not a real statistical test)", () => {
    const rng = mulberry32(7);
    const seen = new Set(Array.from({ length: 200 }, () => rng()));
    expect(seen.size).toBe(200);
  });

  it("handles a zero seed without getting stuck at zero", () => {
    const rng = mulberry32(0);
    const values = Array.from({ length: 5 }, () => rng());
    expect(values.some((v) => v !== 0)).toBe(true);
  });
});

describe("deriveSeed", () => {
  it("is deterministic for the same inputs", () => {
    expect(deriveSeed(10, 1)).toBe(deriveSeed(10, 1));
  });

  it("differs by salt, so unrelated noise channels don't share a permutation table", () => {
    expect(deriveSeed(10, 1)).not.toBe(deriveSeed(10, 2));
  });

  it("differs by base seed", () => {
    expect(deriveSeed(10, 1)).not.toBe(deriveSeed(11, 1));
  });
});
