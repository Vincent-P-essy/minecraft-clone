import { describe, expect, it } from "vitest";
import { environmentAt } from "./environment";
import { applyWeather, CLEAR, weatherAt } from "./weather";

const luma = (c: readonly [number, number, number]): number =>
  c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const noon = environmentAt(216); // phase 0.3 of a 720 s day

describe("weatherAt", () => {
  it("is deterministic per seed and time", () => {
    expect(weatherAt(7, 1234.5)).toEqual(weatherAt(7, 1234.5));
  });

  it("stays within [0, 1] and never rains from a clear sky", () => {
    for (let t = 0; t < 40000; t += 37) {
      const w = weatherAt(2026, t);
      expect(w.overcast).toBeGreaterThanOrEqual(0);
      expect(w.overcast).toBeLessThanOrEqual(1);
      expect(w.rain).toBeGreaterThanOrEqual(0);
      expect(w.rain).toBeLessThanOrEqual(1);
      if (w.rain > 0) expect(w.overcast).toBeGreaterThan(0.5);
    }
  });

  it("greets a new world with fair weather", () => {
    for (const seed of [1, 2, 42, 2026, 987654]) {
      for (let t = 0; t < 200; t += 10) {
        expect(weatherAt(seed, t)).toEqual(CLEAR);
      }
    }
  });

  it("changes gradually: no jump between consecutive seconds", () => {
    let previous = weatherAt(11, 0);
    for (let t = 1; t < 20000; t += 1) {
      const next = weatherAt(11, t);
      // At its fastest the sky takes a good half-minute to close over.
      expect(Math.abs(next.overcast - previous.overcast)).toBeLessThan(0.04);
      expect(Math.abs(next.rain - previous.rain)).toBeLessThan(0.04);
      previous = next;
    }
  });

  it("is mostly fair, sometimes grey, and now and then wet", () => {
    let grey = 0;
    let wet = 0;
    const samples = 6000;
    for (let i = 0; i < samples; i++) {
      const w = weatherAt(2026, 500 + i * 61);
      if (w.overcast > 0.5) grey++;
      if (w.rain > 0.5) wet++;
    }
    expect(grey / samples).toBeGreaterThan(0.15);
    expect(grey / samples).toBeLessThan(0.6);
    expect(wet / samples).toBeGreaterThan(0.05);
    expect(wet).toBeLessThan(grey);
  });

  it("differs between worlds", () => {
    let different = 0;
    for (let t = 1000; t < 20000; t += 500) {
      if (weatherAt(1, t).overcast !== weatherAt(2, t).overcast) different++;
    }
    expect(different).toBeGreaterThan(5);
  });
});

describe("applyWeather", () => {
  it("leaves a clear day untouched", () => {
    expect(applyWeather(noon, CLEAR)).toBe(noon);
  });

  it("an overcast sky dims the sun far more than the ambient light", () => {
    const grey = applyWeather(noon, { overcast: 1, rain: 0 });
    expect(luma(grey.lightColor)).toBeLessThan(luma(noon.lightColor) * 0.35);
    expect(luma(grey.ambientSky)).toBeGreaterThan(luma(noon.ambientSky) * 0.5);
    expect(grey.shadowStrength).toBeLessThan(noon.shadowStrength * 0.25);
    expect(luma(grey.sunColor)).toBe(0);
  });

  it("drains the colour out of the sky", () => {
    const grey = applyWeather(noon, { overcast: 1, rain: 0 });
    const saturation = (c: readonly [number, number, number]): number =>
      (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    expect(saturation(grey.skyZenith)).toBeLessThan(saturation(noon.skyZenith) * 0.4);
  });

  it("hides the stars at night", () => {
    const night = environmentAt(576); // phase 0.8
    expect(night.starVisibility).toBeGreaterThan(0.9);
    expect(applyWeather(night, { overcast: 1, rain: 1 }).starVisibility).toBe(0);
  });

  it("scales smoothly with cloud cover", () => {
    const half = applyWeather(noon, { overcast: 0.5, rain: 0 });
    const full = applyWeather(noon, { overcast: 1, rain: 0 });
    expect(luma(half.lightColor)).toBeLessThan(luma(noon.lightColor));
    expect(luma(half.lightColor)).toBeGreaterThan(luma(full.lightColor));
  });

  it("lightning floods the ambient light for a moment", () => {
    const storm = { overcast: 1, rain: 1 };
    const dark = applyWeather(environmentAt(576), storm);
    const struck = applyWeather(environmentAt(576), storm, 1);
    expect(luma(struck.ambientSky)).toBeGreaterThan(luma(dark.ambientSky) + 1.5);
  });
});
