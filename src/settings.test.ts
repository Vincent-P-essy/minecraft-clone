import { describe, expect, it } from "vitest";
import { defaultSettings, sanitizeSettings, type KeyValueStore, SettingsStore } from "./settings";

const desktop = defaultSettings({ touch: false, cores: 8 });

function memory(initial?: string): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set("voxel-world:settings:v1", initial);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe("defaultSettings", () => {
  it("starts phones lighter than desktops, with auto-jump on", () => {
    const phone = defaultSettings({ touch: true, cores: 4 });
    expect(phone.quality).toBe("low");
    expect(phone.autoJump).toBe(true);
    expect(phone.viewDistance).toBeLessThan(desktop.viewDistance);
    expect(desktop.quality).toBe("high");
    expect(desktop.autoJump).toBe(false);
  });

  it("gives a many-core phone the middle tier", () => {
    expect(defaultSettings({ touch: true, cores: 8 }).quality).toBe("medium");
  });
});

describe("sanitizeSettings", () => {
  it("returns the defaults for anything that isn't an object", () => {
    for (const raw of [null, undefined, 3, "x", []]) {
      expect(sanitizeSettings(raw, desktop)).toEqual(desktop);
    }
  });

  it("keeps valid values and clamps out-of-range numbers", () => {
    const out = sanitizeSettings(
      { quality: "ultra", viewDistance: 99, fov: 10, sensitivity: 1.5, volume: -4 },
      desktop,
    );
    expect(out.quality).toBe("ultra");
    expect(out.viewDistance).toBe(16);
    expect(out.fov).toBe(55);
    expect(out.sensitivity).toBe(1.5);
    expect(out.volume).toBe(0);
  });

  it("discards wrong types and unknown tiers field by field", () => {
    const out = sanitizeSettings(
      { quality: "cinematic", fov: "wide", invertY: "yes", autoJump: true, volume: Number.NaN },
      desktop,
    );
    expect(out.quality).toBe(desktop.quality);
    expect(out.fov).toBe(desktop.fov);
    expect(out.invertY).toBe(desktop.invertY);
    expect(out.autoJump).toBe(true);
    expect(out.volume).toBe(desktop.volume);
  });

  it("accepts only known languages", () => {
    expect(sanitizeSettings({ language: "fr" }, desktop).language).toBe("fr");
    expect(sanitizeSettings({ language: "en" }, desktop).language).toBe("en");
    expect(sanitizeSettings({ language: "klingon" }, desktop).language).toBe("auto");
    expect(sanitizeSettings({ language: 3 }, desktop).language).toBe("auto");
  });

  it("never passes unknown keys through", () => {
    const out = sanitizeSettings({ __proto__: { evil: 1 }, extra: "x" }, desktop);
    expect(Object.keys(out).sort()).toEqual(Object.keys(desktop).sort());
  });
});

describe("SettingsStore", () => {
  it("loads stored values over the defaults", () => {
    const store = new SettingsStore(memory(JSON.stringify({ fov: 90, quality: "low" })), desktop);
    expect(store.values.fov).toBe(90);
    expect(store.values.quality).toBe("low");
    expect(store.values.viewDistance).toBe(desktop.viewDistance);
  });

  it("survives a corrupt payload", () => {
    expect(new SettingsStore(memory("{not json"), desktop).values).toEqual(desktop);
  });

  it("works with no storage at all", () => {
    const store = new SettingsStore(null, desktop);
    store.set("fov", 80);
    expect(store.values.fov).toBe(80);
  });

  it("persists a change and notifies listeners with the key", () => {
    const storage = memory();
    const store = new SettingsStore(storage, desktop);
    const seen: string[] = [];
    store.onChange((_values, key) => seen.push(key));
    store.set("volume", 0.25);
    expect(seen).toEqual(["volume"]);
    expect(new SettingsStore(storage, desktop).values.volume).toBe(0.25);
  });

  it("stays quiet when a value doesn't actually change", () => {
    const store = new SettingsStore(memory(), desktop);
    let calls = 0;
    store.onChange(() => calls++);
    store.set("fov", desktop.fov);
    expect(calls).toBe(0);
  });

  it("still applies a setting when storage refuses the write", () => {
    const store = new SettingsStore(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
      desktop,
    );
    expect(() => {
      store.set("fov", 95);
    }).not.toThrow();
    expect(store.values.fov).toBe(95);
  });
});
