import { describe, expect, it } from "vitest";
import { BlockId } from "../world/blocks";
import {
  ALL_TILE_KINDS,
  ATLAS_GRID_SIZE,
  TileKind,
  tileForBlockFace,
  tileGridPosition,
  tileUV,
} from "./atlas-layout";

describe("tileGridPosition", () => {
  it("places tile 0 at the origin", () => {
    expect(tileGridPosition(TileKind.GRASS_TOP)).toEqual({ col: 0, row: 0 });
  });

  it("wraps to the next row after ATLAS_GRID_SIZE tiles", () => {
    // With a 4-wide grid, tile index 4 (SAND) is the first tile of row 1,
    // and tile index 5 (WATER) is the second.
    expect(TileKind.SAND).toBe(ATLAS_GRID_SIZE);
    expect(tileGridPosition(TileKind.SAND)).toEqual({ col: 0, row: 1 });
    expect(tileGridPosition(TileKind.WATER)).toEqual({ col: 1, row: 1 });
  });
});

describe("tileUV", () => {
  it("returns a unit rect for tile 0", () => {
    const [u0, v0, u1, v1] = tileUV(0);
    expect(u0).toBe(0);
    expect(v0).toBe(0);
    expect(u1).toBeCloseTo(1 / ATLAS_GRID_SIZE);
    expect(v1).toBeCloseTo(1 / ATLAS_GRID_SIZE);
  });

  it("every tile's rect stays within [0, 1]", () => {
    for (const tile of ALL_TILE_KINDS) {
      const [u0, v0, u1, v1] = tileUV(tile);
      for (const value of [u0, v0, u1, v1]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(u1).toBeGreaterThan(u0);
      expect(v1).toBeGreaterThan(v0);
    }
  });

  it("adjacent tiles don't overlap", () => {
    const [, , u1] = tileUV(0);
    const [u0Next] = tileUV(1);
    expect(u0Next).toBeCloseTo(u1);
  });
});

describe("tileForBlockFace", () => {
  it("gives grass a distinct top, side, and bottom", () => {
    const top = tileForBlockFace(BlockId.GRASS, "top");
    const side = tileForBlockFace(BlockId.GRASS, "east");
    const bottom = tileForBlockFace(BlockId.GRASS, "bottom");
    expect(new Set([top, side, bottom]).size).toBe(3);
  });

  it("gives grass the same tile on every side face", () => {
    const sides = (["north", "south", "east", "west"] as const).map((f) =>
      tileForBlockFace(BlockId.GRASS, f),
    );
    expect(new Set(sides).size).toBe(1);
  });

  it("gives wood the same tile on top and bottom, distinct from its sides", () => {
    const top = tileForBlockFace(BlockId.WOOD, "top");
    const bottom = tileForBlockFace(BlockId.WOOD, "bottom");
    const side = tileForBlockFace(BlockId.WOOD, "north");
    expect(top).toBe(bottom);
    expect(top).not.toBe(side);
  });

  it("gives uniform blocks the same tile on every face", () => {
    const faces = (["top", "bottom", "north", "south", "east", "west"] as const).map((f) =>
      tileForBlockFace(BlockId.STONE, f),
    );
    expect(new Set(faces).size).toBe(1);
  });

  it("gives every non-air BlockId some tile without throwing", () => {
    for (const id of Object.values(BlockId)) {
      if (id === BlockId.AIR) continue;
      expect(() => tileForBlockFace(id, "top")).not.toThrow();
    }
  });
});
