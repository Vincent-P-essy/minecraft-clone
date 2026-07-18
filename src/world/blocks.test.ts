import { describe, expect, it } from "vitest";
import { BLOCKS, BlockId, isSolid, isTransparent, PLACEABLE_BLOCKS } from "./blocks";

describe("BLOCKS registry", () => {
  it("has an entry for every declared BlockId", () => {
    for (const id of Object.values(BlockId)) {
      expect(BLOCKS[id]).toBeDefined();
      expect(BLOCKS[id].id).toBe(id);
    }
  });

  it("gives every entry a unique name", () => {
    const names = Object.values(BLOCKS).map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("air", () => {
  it("is not solid, is transparent, and cannot be broken or placed", () => {
    expect(isSolid(BlockId.AIR)).toBe(false);
    expect(isTransparent(BlockId.AIR)).toBe(true);
    expect(BLOCKS[BlockId.AIR].breakable).toBe(false);
    expect(PLACEABLE_BLOCKS).not.toContain(BlockId.AIR);
  });
});

describe("water", () => {
  it("is transparent but not solid, matching how the player passes through it", () => {
    expect(isSolid(BlockId.WATER)).toBe(false);
    expect(isTransparent(BlockId.WATER)).toBe(true);
  });
});

describe("bedrock", () => {
  it("is solid but not breakable", () => {
    expect(isSolid(BlockId.BEDROCK)).toBe(true);
    expect(BLOCKS[BlockId.BEDROCK].breakable).toBe(false);
  });
});

describe("stone", () => {
  it("is solid, opaque, and breakable", () => {
    expect(isSolid(BlockId.STONE)).toBe(true);
    expect(isTransparent(BlockId.STONE)).toBe(false);
    expect(BLOCKS[BlockId.STONE].breakable).toBe(true);
  });
});

describe("PLACEABLE_BLOCKS", () => {
  it("only lists breakable, non-air blocks", () => {
    for (const id of PLACEABLE_BLOCKS) {
      expect(BLOCKS[id].breakable).toBe(true);
      expect(id).not.toBe(BlockId.AIR);
    }
  });

  it("fits in a 9-slot hotbar", () => {
    expect(PLACEABLE_BLOCKS.length).toBeLessThanOrEqual(9);
  });
});
