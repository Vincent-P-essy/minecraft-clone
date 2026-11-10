import { describe, expect, it } from "vitest";
import { DAYTIME_END, dayPhase, environmentAt, sunAngleAt } from "./environment";
import { DAY_LENGTH_SECONDS } from "./sky";

const at = (phase: number) => environmentAt(phase * DAY_LENGTH_SECONDS);
const length = (v: readonly [number, number, number]): number => Math.hypot(v[0], v[1], v[2]);
const luma = (v: readonly [number, number, number]): number =>
  v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;

describe("dayPhase", () => {
  it("wraps into [0, 1) for any time, including negative", () => {
    expect(dayPhase(0)).toBe(0);
    expect(dayPhase(DAY_LENGTH_SECONDS * 2.25)).toBeCloseTo(0.25);
    expect(dayPhase(-DAY_LENGTH_SECONDS * 0.25)).toBeCloseTo(0.75);
  });
});

describe("sunAngleAt", () => {
  it("rises at 0, sets at DAYTIME_END, and completes the circle overnight", () => {
    expect(sunAngleAt(0)).toBe(0);
    expect(sunAngleAt(DAYTIME_END / 2)).toBeCloseTo(Math.PI / 2);
    expect(sunAngleAt(DAYTIME_END)).toBeCloseTo(Math.PI);
    expect(sunAngleAt(1)).toBeCloseTo(Math.PI * 2);
  });

  it("is continuous across sunset", () => {
    expect(sunAngleAt(DAYTIME_END + 1e-6) - sunAngleAt(DAYTIME_END - 1e-6)).toBeLessThan(1e-4);
  });
});

describe("environmentAt", () => {
  it("is periodic over one day", () => {
    const a = environmentAt(137);
    const b = environmentAt(137 + DAY_LENGTH_SECONDS);
    expect(b.sunDir[0]).toBeCloseTo(a.sunDir[0], 9);
    expect(b.lightColor[1]).toBeCloseTo(a.lightColor[1], 9);
    expect(b.night).toBeCloseTo(a.night, 9);
  });

  it("keeps the sun and moon as opposite unit vectors", () => {
    for (let phase = 0; phase < 1; phase += 0.05) {
      const env = at(phase);
      expect(length(env.sunDir)).toBeCloseTo(1, 6);
      expect(length(env.moonDir)).toBeCloseTo(1, 6);
      expect(env.sunDir[1] + env.moonDir[1]).toBeCloseTo(0, 9);
    }
  });

  it("puts the sun high at midday and under the horizon at midnight", () => {
    expect(at(DAYTIME_END / 2).sunDir[1]).toBeGreaterThan(0.8);
    expect(at(0.8).sunDir[1]).toBeLessThan(-0.5);
  });

  it("never lets the sun pass straight overhead, so noon still casts slanted shadows", () => {
    for (let phase = 0; phase <= DAYTIME_END; phase += 0.01) {
      expect(at(phase).sunDir[1]).toBeLessThan(0.9);
    }
  });

  it("the shadow-casting light always comes from above", () => {
    for (let phase = 0; phase < 1; phase += 0.01) {
      expect(at(phase).lightDir[1]).toBeGreaterThan(-0.04);
    }
  });

  it("is bright by day and dim (but not black) by night", () => {
    const noon = at(DAYTIME_END / 2);
    const midnight = at(0.8);
    expect(luma(noon.lightColor)).toBeGreaterThan(1.5);
    expect(luma(midnight.lightColor)).toBeGreaterThan(0.02);
    expect(luma(midnight.lightColor)).toBeLessThan(luma(noon.lightColor) * 0.2);
    expect(luma(noon.ambientSky)).toBeGreaterThan(luma(midnight.ambientSky) * 8);
    expect(noon.night).toBe(0);
    expect(midnight.night).toBe(1);
  });

  it("shows stars only at night", () => {
    expect(at(0.3).starVisibility).toBe(0);
    expect(at(0.8).starVisibility).toBeGreaterThan(0.9);
  });

  it("warms the horizon at sunset: redder than at noon", () => {
    const sunset = at(DAYTIME_END - 0.02);
    const noon = at(DAYTIME_END / 2);
    const warmth = (v: readonly [number, number, number]): number => v[0] / (v[2] + 1e-6);
    expect(warmth(sunset.skyHorizon)).toBeGreaterThan(warmth(noon.skyHorizon) * 2);
    expect(warmth(sunset.lightColor)).toBeGreaterThan(warmth(noon.lightColor));
  });

  it("fades shadows out as the light reaches the horizon", () => {
    expect(at(DAYTIME_END / 2).shadowStrength).toBe(1);
    expect(at(0.001).shadowStrength).toBeLessThan(0.1);
  });

  it("opens the exposure at night, like eyes adjusting", () => {
    expect(at(0.8).exposure).toBeGreaterThan(at(0.3).exposure);
  });

  it("never jumps: quarter-second steps stay close across the whole cycle", () => {
    // A real discontinuity (say, at the sun/moon hand-over) would not get
    // smaller with the step, so a fine step with tight bounds catches it.
    let previous = environmentAt(0);
    for (let t = 0.25; t <= DAY_LENGTH_SECONDS; t += 0.25) {
      const next = environmentAt(t);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs((next.lightColor[c] ?? 0) - (previous.lightColor[c] ?? 0))).toBeLessThan(
          0.04,
        );
        expect(Math.abs((next.skyZenith[c] ?? 0) - (previous.skyZenith[c] ?? 0))).toBeLessThan(
          0.02,
        );
        expect(Math.abs((next.skyHorizon[c] ?? 0) - (previous.skyHorizon[c] ?? 0))).toBeLessThan(
          0.02,
        );
        expect(Math.abs((next.ambientSky[c] ?? 0) - (previous.ambientSky[c] ?? 0))).toBeLessThan(
          0.02,
        );
      }
      expect(Math.abs(next.exposure - previous.exposure)).toBeLessThan(0.02);
      previous = next;
    }
  });
});
