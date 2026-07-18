import { describe, expect, it } from "vitest";
import { BlockId } from "./blocks";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "./coords";
import {
  createCaveSampler,
  createColumnSampler,
  DIRT_DEPTH,
  generateChunk,
  SEA_LEVEL,
} from "./terrain";

describe("createColumnSampler", () => {
  it("is deterministic for the same seed and world coordinate", () => {
    const a = createColumnSampler(42);
    const b = createColumnSampler(42);
    expect(a(100, -50)).toEqual(b(100, -50));
  });

  it("different seeds produce different terrain somewhere nearby", () => {
    const a = createColumnSampler(1);
    const b = createColumnSampler(2);
    let anyDifferent = false;
    for (let x = 0; x < 32; x++) {
      if (a(x, 0).terrainHeight !== b(x, 0).terrainHeight) anyDifferent = true;
    }
    expect(anyDifferent).toBe(true);
  });

  it("keeps terrain height within the chunk's vertical bounds", () => {
    const sample = createColumnSampler(2026);
    for (let x = -200; x < 200; x += 17) {
      for (let z = -200; z < 200; z += 23) {
        const { terrainHeight } = sample(x, z);
        expect(terrainHeight).toBeGreaterThanOrEqual(2);
        expect(terrainHeight).toBeLessThanOrEqual(CHUNK_HEIGHT - 2);
      }
    }
  });
});

describe("createCaveSampler", () => {
  it("is deterministic for the same seed", () => {
    const a = createCaveSampler(42);
    const b = createCaveSampler(42);
    for (let i = 0; i < 50; i++) {
      expect(a(i * 3, 10 + (i % 20), -i * 2)).toBe(b(i * 3, 10 + (i % 20), -i * 2));
    }
  });

  it("carves some cells and leaves others (not degenerate)", () => {
    const isCave = createCaveSampler(7);
    let carved = 0;
    let total = 0;
    for (let x = 0; x < 40; x++) {
      for (let y = 5; y < 25; y++) {
        total++;
        if (isCave(x, y, 0)) carved++;
      }
    }
    expect(carved).toBeGreaterThan(0);
    expect(carved).toBeLessThan(total);
  });
});

describe("generateChunk determinism", () => {
  it("the same seed and chunk coordinate produce identical block data", () => {
    const a = generateChunk(3, -2, 42);
    const b = generateChunk(3, -2, 42);
    expect(a.buffer).toEqual(b.buffer);
  });

  it("different seeds produce different block data", () => {
    const a = generateChunk(0, 0, 1);
    const b = generateChunk(0, 0, 2);
    expect(a.buffer).not.toEqual(b.buffer);
  });

  it("different chunk coordinates under the same seed produce different terrain", () => {
    const a = generateChunk(0, 0, 42);
    const b = generateChunk(5, 5, 42);
    expect(a.buffer).not.toEqual(b.buffer);
  });
});

describe("generateChunk layering", () => {
  const seed = 2026;
  const chunk = generateChunk(2, -1, seed);
  const sampleColumn = createColumnSampler(seed);
  const isCave = createCaveSampler(seed);
  const worldX = (lx: number): number => 2 * CHUNK_SIZE + lx;
  const worldZ = (lz: number): number => -1 * CHUNK_SIZE + lz;

  it("has bedrock at the very bottom of every column — caves never breach it", () => {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        expect(chunk.getBlock(lx, 0, lz)).toBe(BlockId.BEDROCK);
      }
    }
  });

  it("matches the biome surface block wherever no cave carved the surface away", () => {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const profile = sampleColumn(worldX(lx), worldZ(lz));
        const surface = chunk.getBlock(lx, profile.terrainHeight, lz);

        if (
          isCave(worldX(lx), profile.terrainHeight, worldZ(lz)) &&
          profile.terrainHeight > SEA_LEVEL
        ) {
          expect(surface).toBe(BlockId.AIR); // a natural cave mouth
        } else if (profile.terrainHeight <= SEA_LEVEL) {
          expect(surface).toBe(BlockId.SAND);
        } else if (profile.isSnowy) {
          expect(surface).toBe(BlockId.SNOW);
        } else if (profile.isDesert) {
          expect(surface).toBe(BlockId.SAND);
        } else {
          expect(surface).toBe(BlockId.GRASS);
        }
      }
    }
  });

  it("keeps the seabed watertight: underwater columns are never carved near the floor", () => {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const profile = sampleColumn(worldX(lx), worldZ(lz));
        if (profile.terrainHeight > SEA_LEVEL) continue;
        for (let y = Math.max(1, profile.terrainHeight - 3); y <= profile.terrainHeight; y++) {
          expect(chunk.getBlock(lx, y, lz)).not.toBe(BlockId.AIR);
        }
      }
    }
  });

  it("subsurface cells are stone/dirt/sand where uncarved, air where carved", () => {
    for (let lx = 0; lx < CHUNK_SIZE; lx += 3) {
      for (let lz = 0; lz < CHUNK_SIZE; lz += 3) {
        const profile = sampleColumn(worldX(lx), worldZ(lz));
        const underwater = profile.terrainHeight <= SEA_LEVEL;
        const carveCeiling = underwater ? profile.terrainHeight - 4 : profile.terrainHeight;
        for (let y = 1; y < profile.terrainHeight; y++) {
          const block = chunk.getBlock(lx, y, lz);
          if (y <= carveCeiling && isCave(worldX(lx), y, worldZ(lz))) {
            expect(block).toBe(BlockId.AIR);
          } else if (y < profile.terrainHeight - DIRT_DEPTH) {
            expect(block).toBe(BlockId.STONE);
          } else {
            expect([BlockId.DIRT, BlockId.SAND]).toContain(block);
          }
        }
      }
    }
  });

  it("above the terrain: water up to sea level, otherwise only air or tree blocks", () => {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const profile = sampleColumn(worldX(lx), worldZ(lz));
        for (let y = profile.terrainHeight + 1; y < CHUNK_HEIGHT; y++) {
          const block = chunk.getBlock(lx, y, lz);
          if (y <= SEA_LEVEL) {
            expect(block).toBe(BlockId.WATER);
          } else {
            expect([BlockId.AIR, BlockId.WOOD, BlockId.LEAVES]).toContain(block);
          }
        }
      }
    }
  });
});
