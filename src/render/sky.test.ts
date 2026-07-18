import { describe, expect, it } from "vitest";
import { DAY_LENGTH_SECONDS, skyStateAt } from "./sky";

describe("skyStateAt", () => {
  it("is periodic: one full day later, the sky is identical", () => {
    for (const t of [0, 13.7, 60, 100.2, 233]) {
      const a = skyStateAt(t);
      const b = skyStateAt(t + DAY_LENGTH_SECONDS);
      expect(b.skyColor[0]).toBeCloseTo(a.skyColor[0], 10);
      expect(b.sunIntensity).toBeCloseTo(a.sunIntensity, 10);
      expect(b.ambientIntensity).toBeCloseTo(a.ambientIntensity, 10);
      expect(b.sunAngle).toBeCloseTo(a.sunAngle, 10);
    }
  });

  it("never jumps: adjacent half-second samples stay close across the whole cycle", () => {
    for (let t = 0; t < DAY_LENGTH_SECONDS; t += 0.5) {
      const a = skyStateAt(t);
      const b = skyStateAt(t + 0.5);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs((b.skyColor[c] ?? 0) - (a.skyColor[c] ?? 0))).toBeLessThan(0.05);
      }
      expect(Math.abs(b.sunIntensity - a.sunIntensity)).toBeLessThan(0.15);
      expect(Math.abs(b.ambientIntensity - a.ambientIntensity)).toBeLessThan(0.05);
    }
  });

  it("keeps every channel in a sane range over the whole cycle", () => {
    for (let t = 0; t < DAY_LENGTH_SECONDS; t += 1) {
      const s = skyStateAt(t);
      for (const c of s.skyColor) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      expect(s.sunIntensity).toBeGreaterThan(0);
      expect(s.ambientIntensity).toBeGreaterThan(0);
      expect(s.sunAngle).toBeGreaterThanOrEqual(0);
      expect(s.sunAngle).toBeLessThanOrEqual(Math.PI);
    }
  });

  it("midday is brighter than midnight, in both sun and sky", () => {
    const midday = skyStateAt(DAY_LENGTH_SECONDS * 0.3);
    const midnight = skyStateAt(DAY_LENGTH_SECONDS * 0.85);
    expect(midday.sunIntensity).toBeGreaterThan(midnight.sunIntensity * 5);
    expect(midday.skyColor[2]).toBeGreaterThan(midnight.skyColor[2]);
    expect(midday.ambientIntensity).toBeGreaterThan(midnight.ambientIntensity);
  });

  it("the sun rises at phase 0, peaks mid-morningish, and has set by the dusk phase", () => {
    expect(skyStateAt(0).sunAngle).toBeCloseTo(0);
    const midday = skyStateAt(DAY_LENGTH_SECONDS * 0.3);
    expect(midday.sunAngle).toBeGreaterThan(Math.PI / 4);
    expect(midday.sunAngle).toBeLessThan((3 * Math.PI) / 4);
    expect(skyStateAt(DAY_LENGTH_SECONDS * 0.7).sunAngle).toBeCloseTo(Math.PI);
  });

  it("handles negative times without breaking periodicity", () => {
    const a = skyStateAt(-10);
    const b = skyStateAt(DAY_LENGTH_SECONDS - 10);
    expect(a.sunIntensity).toBeCloseTo(b.sunIntensity, 10);
  });
});
