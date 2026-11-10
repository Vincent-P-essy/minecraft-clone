import { describe, expect, it } from "vitest";
import { BlockId, INVENTORY_BLOCKS, PLACEABLE_BLOCKS } from "../world/blocks";
import { HOTBAR_SLOTS, sanitizeHotbar } from "./hotbar";
import { seedFromText } from "./menu";

describe("seedFromText", () => {
  it("uses a plain number as the seed itself", () => {
    expect(seedFromText("2026")).toBe(2026);
    expect(seedFromText("  42 ")).toBe(42);
  });

  it("folds a negative number onto its positive twin (seeds live in the URL unsigned)", () => {
    expect(seedFromText("-7")).toBe(7);
  });

  it("hashes any other text, deterministically", () => {
    const a = seedFromText("my island");
    expect(a).toBe(seedFromText("my island"));
    expect(a).not.toBe(seedFromText("my islanD"));
    expect(Number.isInteger(a)).toBe(true);
  });

  it("rolls a random seed for empty input", () => {
    expect(seedFromText("", () => 0.5)).toBe(Math.floor(0.5 * 0x7fffffff));
    expect(seedFromText("   ", () => 0)).toBe(0);
  });

  it("always lands in [0, 2^31) so it survives parseInt and the URL", () => {
    for (const text of ["99999999999", "4294967296", "zzzzzzzzzzzzzzzzzzzz", "é漢字🙂", "0"]) {
      const seed = seedFromText(text);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(0x7fffffff);
      expect(Number.parseInt(seed.toString(), 10)).toBe(seed);
    }
  });
});

describe("sanitizeHotbar", () => {
  it("accepts nine inventory blocks", () => {
    expect(sanitizeHotbar([...PLACEABLE_BLOCKS])).toEqual([...PLACEABLE_BLOCKS]);
  });

  it("rejects the wrong length or shape", () => {
    expect(sanitizeHotbar(undefined)).toBeNull();
    expect(sanitizeHotbar("123456789")).toBeNull();
    expect(sanitizeHotbar([1, 2, 3])).toBeNull();
    expect(sanitizeHotbar(new Array(HOTBAR_SLOTS + 1).fill(BlockId.STONE))).toBeNull();
  });

  it("rejects blocks a player may not hold (air, water, bedrock, unknown ids)", () => {
    const base: number[] = [...PLACEABLE_BLOCKS];
    for (const bad of [BlockId.AIR, BlockId.WATER, BlockId.BEDROCK, 250, 1.5, "3"]) {
      const hotbar: unknown[] = [...base];
      hotbar[4] = bad;
      expect(sanitizeHotbar(hotbar)).toBeNull();
    }
  });

  it("the default hotbar is itself valid", () => {
    expect(PLACEABLE_BLOCKS).toHaveLength(HOTBAR_SLOTS);
    for (const block of PLACEABLE_BLOCKS) expect(INVENTORY_BLOCKS).toContain(block);
  });
});
