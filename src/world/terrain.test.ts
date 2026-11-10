import { describe, expect, it } from "vitest";
import { BlockId } from "./blocks";
import type { Chunk } from "./chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "./coords";
import {
  Biome,
  type ColumnProfile,
  createCaveSampler,
  createColumnSampler,
  generateChunk,
  hash3,
  SEA_LEVEL,
  surfaceBlock,
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

const PLANTS: readonly BlockId[] = [
  BlockId.TALL_GRASS,
  BlockId.FLOWER_RED,
  BlockId.FLOWER_YELLOW,
  BlockId.FLOWER_BLUE,
  BlockId.DRY_BUSH,
];
const TREE_BLOCKS: readonly BlockId[] = [
  BlockId.WOOD,
  BlockId.LEAVES,
  BlockId.PALE_WOOD,
  BlockId.AUTUMN_LEAVES,
  BlockId.PINE_WOOD,
  BlockId.PINE_LEAVES,
  BlockId.CACTUS,
];
const LEAVES: readonly BlockId[] = [BlockId.LEAVES, BlockId.AUTUMN_LEAVES, BlockId.PINE_LEAVES];
const UNDERGROUND: readonly BlockId[] = [
  BlockId.STONE,
  BlockId.DIRT,
  BlockId.SAND,
  BlockId.SANDSTONE,
  BlockId.SNOW,
  BlockId.COAL_ORE,
  BlockId.GOLD_ORE,
  BlockId.CRYSTAL,
];

describe("generateChunk layering", () => {
  const seed = 2026;
  const sampleColumn = createColumnSampler(seed);
  const isCave = createCaveSampler(seed);
  // A spread of chunks so the invariants meet several biomes, not one.
  const coords: readonly (readonly [number, number])[] = [
    [2, -1],
    [0, 0],
    [-11, 7],
    [25, 14],
    [-40, -33],
  ];
  const chunks = coords.map(([cx, cz]) => ({ cx, cz, chunk: generateChunk(cx, cz, seed) }));

  function eachColumn(
    visit: (
      chunk: Chunk,
      lx: number,
      lz: number,
      worldX: number,
      worldZ: number,
      profile: ColumnProfile,
    ) => void,
  ): void {
    for (const { cx, cz, chunk } of chunks) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const worldX = cx * CHUNK_SIZE + lx;
          const worldZ = cz * CHUNK_SIZE + lz;
          visit(chunk, lx, lz, worldX, worldZ, sampleColumn(worldX, worldZ));
        }
      }
    }
  }

  it("has bedrock at the very bottom of every column — caves never breach it", () => {
    eachColumn((chunk, lx, lz) => {
      expect(chunk.getBlock(lx, 0, lz)).toBe(BlockId.BEDROCK);
    });
  });

  it("matches the biome surface block wherever no cave carved the surface away", () => {
    eachColumn((chunk, lx, lz, worldX, worldZ, profile) => {
      const h = profile.terrainHeight;
      const surface = chunk.getBlock(lx, h, lz);
      const nearWater = h <= SEA_LEVEL + 2;
      if (!nearWater && isCave(worldX, h, worldZ)) {
        // A natural cave mouth (a canopy may still overhang it).
        expect([BlockId.AIR, ...LEAVES]).toContain(surface);
      } else {
        expect(surface).toBe(surfaceBlock(profile));
      }
    });
  });

  it("keeps the water's bed watertight: columns at or below the shore are never carved near the top", () => {
    eachColumn((chunk, lx, lz, _x, _z, profile) => {
      if (profile.terrainHeight > SEA_LEVEL + 2) return;
      for (let y = Math.max(1, profile.terrainHeight - 3); y <= profile.terrainHeight; y++) {
        expect(chunk.getBlock(lx, y, lz)).not.toBe(BlockId.AIR);
      }
    });
  });

  it("below the surface: natural rock, soil and ore where uncarved, open cave where carved", () => {
    eachColumn((chunk, lx, lz, worldX, worldZ, profile) => {
      if (lx % 3 !== 0 || lz % 3 !== 0) return;
      const h = profile.terrainHeight;
      const carveCeiling = h <= SEA_LEVEL + 2 ? h - 4 : h;
      for (let y = 1; y < h; y++) {
        const block = chunk.getBlock(lx, y, lz);
        if (y <= carveCeiling && isCave(worldX, y, worldZ)) {
          expect([BlockId.AIR, BlockId.GLOWSHROOM]).toContain(block);
        } else {
          expect(UNDERGROUND).toContain(block);
        }
      }
    });
  });

  it("only stone hosts ore, and gold stays deep", () => {
    eachColumn((chunk, lx, lz, _x, _z, profile) => {
      for (let y = 1; y < profile.terrainHeight; y++) {
        const block = chunk.getBlock(lx, y, lz);
        if (block === BlockId.GOLD_ORE) expect(y).toBeLessThan(34);
        if (block === BlockId.CRYSTAL) expect(y).toBeLessThan(SEA_LEVEL - 4);
      }
    });
  });

  it("above the terrain: water (or ice) up to sea level, otherwise only air, plants or trees", () => {
    eachColumn((chunk, lx, lz, _x, _z, profile) => {
      for (let y = profile.terrainHeight + 1; y < CHUNK_HEIGHT; y++) {
        const block = chunk.getBlock(lx, y, lz);
        if (y <= SEA_LEVEL) {
          const expected = y === SEA_LEVEL && profile.frozen ? BlockId.ICE : BlockId.WATER;
          expect(block).toBe(expected);
        } else {
          expect([BlockId.AIR, ...PLANTS, ...TREE_BLOCKS]).toContain(block);
        }
      }
    });
  });

  it("plants only ever sit directly on the surface block", () => {
    eachColumn((chunk, lx, lz, _x, _z, profile) => {
      for (let y = 1; y < CHUNK_HEIGHT; y++) {
        const block = chunk.getBlock(lx, y, lz);
        if (PLANTS.includes(block)) expect(y).toBe(profile.terrainHeight + 1);
      }
    });
  });
});

describe("biomes", () => {
  it("a large area holds a real variety of biomes, with both land and sea", () => {
    const sample = createColumnSampler(2026);
    const seen = new Set<number>();
    for (let x = -3000; x <= 3000; x += 60) {
      for (let z = -3000; z <= 3000; z += 60) seen.add(sample(x, z).biome);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
    expect(seen.has(Biome.OCEAN)).toBe(true);
    expect(seen.has(Biome.FOREST)).toBe(true);
  });

  it("snowy and desert flags follow the biome", () => {
    const sample = createColumnSampler(7);
    for (let x = -2000; x <= 2000; x += 97) {
      for (let z = -2000; z <= 2000; z += 97) {
        const p = sample(x, z);
        expect(p.isDesert).toBe(p.biome === Biome.DESERT);
        expect(p.isSnowy).toBe(p.biome === Biome.TUNDRA || p.biome === Biome.SNOW_PEAK);
        if (p.biome === Biome.OCEAN) expect(p.terrainHeight).toBeLessThanOrEqual(SEA_LEVEL);
        else expect(p.terrainHeight).toBeGreaterThan(SEA_LEVEL);
      }
    }
  });
});

describe("hash3", () => {
  it("is deterministic and spreads over the full 32-bit range", () => {
    expect(hash3(1, 2, 3, 4)).toBe(hash3(1, 2, 3, 4));
    let high = 0;
    for (let i = 0; i < 2000; i++) {
      const h = hash3(99, i, i * 7, -i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      if (h > 0x7fffffff) high++;
    }
    expect(high).toBeGreaterThan(800);
    expect(high).toBeLessThan(1200);
  });
});
