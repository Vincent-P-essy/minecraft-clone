import { describe, expect, it } from "vitest";
import {
  createTranslator,
  detectLocale,
  hasFrenchBlockName,
  LOCALES,
  resolveLocale,
  TEXT_KEYS,
} from "./i18n";
import { BLOCKS } from "./world/blocks";

describe("detectLocale", () => {
  it("picks the first supported language in the browser's list", () => {
    expect(detectLocale(["fr-FR", "en-US"])).toBe("fr");
    expect(detectLocale(["en-GB", "fr"])).toBe("en");
    expect(detectLocale(["de-DE", "fr-CA", "en"])).toBe("fr");
  });

  it("falls back to English when nothing matches or the list is empty", () => {
    expect(detectLocale(["de", "ja-JP"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });
});

describe("resolveLocale", () => {
  it("lets an explicit choice win over the browser", () => {
    expect(resolveLocale("en", ["fr-FR"])).toBe("en");
    expect(resolveLocale("fr", ["en-US"])).toBe("fr");
    expect(resolveLocale("auto", ["fr-FR"])).toBe("fr");
  });
});

describe("translations", () => {
  it("every key has non-empty text in every language", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      for (const key of TEXT_KEYS) expect(t(key).length).toBeGreaterThan(0);
    }
  });

  it("both languages use the same placeholders for each key", () => {
    const en = createTranslator("en");
    const fr = createTranslator("fr");
    const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of TEXT_KEYS) expect(placeholders(fr(key))).toEqual(placeholders(en(key)));
  });

  it("fills placeholders, every occurrence", () => {
    const t = createTranslator("en");
    expect(t("chunks", { n: 12 })).toBe("12 chunks");
    expect(t("version", { version: "1.0.0", seed: 7 })).toBe("v1.0.0 · seed 7");
    expect(createTranslator("fr")("chunks", { n: 12 })).toBe("12 tronçons");
  });

  it("French actually differs from English for ordinary labels", () => {
    const en = createTranslator("en");
    const fr = createTranslator("fr");
    for (const key of ["play", "settings", "worlds", "back", "flying"] as const) {
      expect(fr(key)).not.toBe(en(key));
    }
  });

  it("names every block in French, and leaves English names as they are", () => {
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    for (const def of Object.values(BLOCKS)) {
      expect(hasFrenchBlockName(def.name)).toBe(true);
      expect(fr.block(def.name).length).toBeGreaterThan(0);
      expect(en.block(def.name)).toBe(def.name);
    }
    expect(fr.block("lantern")).toBe("lanterne");
    expect(fr.block("something new")).toBe("something new");
  });
});
