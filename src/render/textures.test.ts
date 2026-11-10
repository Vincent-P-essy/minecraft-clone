import { describe, expect, it } from "vitest";
import { BLOCKS, BlockId } from "../world/blocks";
import { ALL_TILE_KINDS, ATLAS_TILE_SIZE, TileKind, tileForBlockFace } from "./atlas-layout";
import { buildNoisePixels, NOISE_SIZE, tileableFbm } from "./noise-texture";
import { paintTile } from "./tile-painter";

const PIXELS = ATLAS_TILE_SIZE * ATLAS_TILE_SIZE;

function alphaStats(tile: TileKind): { cut: number; dull: number; full: number } {
  const data = paintTile(tile, 1);
  let cut = 0;
  let dull = 0;
  let full = 0;
  for (let i = 0; i < PIXELS; i++) {
    const a = data[i * 4 + 3] ?? 0;
    if (a < 128) cut++;
    else if (a < 220) dull++;
    else full++;
  }
  return { cut, dull, full };
}

describe("paintTile", () => {
  it("paints a full 16x16 RGBA tile for every tile kind", () => {
    for (const tile of ALL_TILE_KINDS) {
      expect(paintTile(tile, 1)).toHaveLength(PIXELS * 4);
    }
  });

  it("is deterministic per seed and differs between seeds", () => {
    expect(paintTile(TileKind.STONE, 7)).toEqual(paintTile(TileKind.STONE, 7));
    expect(paintTile(TileKind.STONE, 7)).not.toEqual(paintTile(TileKind.STONE, 8));
  });

  it("gives every tile real texture, not one flat colour", () => {
    for (const tile of ALL_TILE_KINDS) {
      const data = paintTile(tile, 1);
      const colors = new Set<number>();
      for (let i = 0; i < PIXELS; i++) {
        colors.add(
          ((data[i * 4] ?? 0) << 16) | ((data[i * 4 + 1] ?? 0) << 8) | (data[i * 4 + 2] ?? 0),
        );
      }
      expect(colors.size).toBeGreaterThan(2);
    }
  });

  it("keeps solid cube textures fully opaque", () => {
    for (const tile of [
      TileKind.STONE,
      TileKind.DIRT,
      TileKind.GRASS_TOP,
      TileKind.PLANKS,
      TileKind.BRICK,
    ]) {
      expect(alphaStats(tile).cut).toBe(0);
    }
  });

  it("cuts holes in foliage, plants and glass", () => {
    expect(alphaStats(TileKind.LEAVES).cut).toBeGreaterThan(10);
    expect(alphaStats(TileKind.LEAVES).cut).toBeLessThan(PIXELS / 2);
    expect(alphaStats(TileKind.TALL_GRASS).cut).toBeGreaterThan(PIXELS / 3);
    expect(alphaStats(TileKind.GLASS).cut).toBeGreaterThan(PIXELS / 2);
  });

  it("marks glowing texels with full alpha and the rest of an emissive block below it", () => {
    for (const tile of [TileKind.LANTERN, TileKind.CRYSTAL, TileKind.GLOWSHROOM]) {
      const stats = alphaStats(tile);
      expect(stats.full).toBeGreaterThan(0);
      expect(stats.dull).toBeGreaterThan(0);
    }
  });

  it("bleeds colour into cut-out texels so mipmaps don't pick up a dark fringe", () => {
    const data = paintTile(TileKind.LEAVES, 1);
    for (let i = 0; i < PIXELS; i++) {
      if ((data[i * 4 + 3] ?? 0) === 0) {
        // Leaves are green: the hidden colour must be too, not black.
        expect(data[i * 4 + 1] ?? 0).toBeGreaterThan(40);
      }
    }
  });

  it("every block's emissive faces have something to glow with", () => {
    for (const def of Object.values(BLOCKS)) {
      if (def.emission === 0 || def.id === BlockId.AIR) continue;
      expect(alphaStats(tileForBlockFace(def.id, "north")).full).toBeGreaterThan(0);
    }
  });
});

describe("tileableFbm", () => {
  it("wraps seamlessly at the edges of the unit square", () => {
    const noise = tileableFbm(3, 4, 4);
    for (const v of [0, 0.13, 0.5, 0.77]) {
      expect(noise(0, v)).toBeCloseTo(noise(1, v), 9);
      expect(noise(v, 0)).toBeCloseTo(noise(v, 1), 9);
    }
  });

  it("stays within [0, 1] and actually varies", () => {
    const noise = tileableFbm(11, 4, 5);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 2000; i++) {
      const v = noise((i * 0.618) % 1, (i * 0.377) % 1);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    expect(max - min).toBeGreaterThan(0.3);
  });
});

describe("buildNoisePixels", () => {
  const pixels = buildNoisePixels(2026);

  it("fills an RGBA image of the advertised size", () => {
    expect(pixels).toHaveLength(NOISE_SIZE * NOISE_SIZE * 4);
  });

  it("is deterministic per seed", () => {
    expect(buildNoisePixels(2026)).toEqual(pixels);
  });

  it("uses most of the 0..255 range in the cloud channel (thresholds need headroom)", () => {
    let min = 255;
    let max = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      min = Math.min(min, pixels[i] ?? 0);
      max = Math.max(max, pixels[i] ?? 0);
    }
    expect(min).toBeLessThan(40);
    expect(max).toBeGreaterThan(215);
  });

  it("centres the ripple slopes on 'flat' (128), so calm water has an upright normal", () => {
    let sumX = 0;
    let sumZ = 0;
    const count = NOISE_SIZE * NOISE_SIZE;
    for (let i = 0; i < pixels.length; i += 4) {
      sumX += pixels[i + 2] ?? 0;
      sumZ += pixels[i + 3] ?? 0;
    }
    expect(Math.abs(sumX / count - 127.5)).toBeLessThan(3);
    expect(Math.abs(sumZ / count - 127.5)).toBeLessThan(3);
  });
});
