import { createNoise3D } from "simplex-noise";
import { BlockId } from "./blocks";
import { Chunk } from "./chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "./coords";
import { treeAllowedOn, treeBlocks, treeCandidatesNear } from "./features";
import { createFbmNoise2D } from "./noise";
import { deriveSeed, mulberry32 } from "./rng";

export const SEA_LEVEL = 32;
const BASE_HEIGHT = 34;
const HEIGHT_AMPLITUDE = 24;
export const DIRT_DEPTH = 4;
const SNOW_HEIGHT = SEA_LEVEL + HEIGHT_AMPLITUDE * 0.7;
const DESERT_MOISTURE_THRESHOLD = -0.2;
const DESERT_MAX_HEIGHT = SEA_LEVEL + 6;

const MOISTURE_SALT = 0x51a7;
const CAVE_SALT = 0xca4e;

const CAVE_SCALE = 0.065;
const CAVE_THRESHOLD = 0.58;
/** Under the sea, caves stay at least this far below the seabed so they
 * never punch a dry hole into the ocean floor. */
const OCEAN_FLOOR_GUARD = 4;

export interface ColumnProfile {
  readonly terrainHeight: number;
  readonly isDesert: boolean;
  readonly isSnowy: boolean;
}

/** Per-world-column terrain shape, independent of which chunk asks for it —
 * this is what makes chunk borders seamless: two chunks sampling the same
 * world (x, z) always agree, because neither of them is the source of truth,
 * the noise field is. */
export function createColumnSampler(
  seed: number,
): (worldX: number, worldZ: number) => ColumnProfile {
  const heightNoise = createFbmNoise2D(seed, { octaves: 4, persistence: 0.5, scale: 0.01 });
  const moistureNoise = createFbmNoise2D(deriveSeed(seed, MOISTURE_SALT), {
    octaves: 2,
    persistence: 0.5,
    scale: 0.006,
  });

  return (worldX: number, worldZ: number): ColumnProfile => {
    const raw = BASE_HEIGHT + heightNoise(worldX, worldZ) * HEIGHT_AMPLITUDE;
    const terrainHeight = Math.max(2, Math.min(CHUNK_HEIGHT - 2, Math.round(raw)));
    const moisture = moistureNoise(worldX, worldZ);
    const isDesert = moisture < DESERT_MOISTURE_THRESHOLD && terrainHeight <= DESERT_MAX_HEIGHT;
    const isSnowy = terrainHeight >= SNOW_HEIGHT;
    return { terrainHeight, isDesert, isSnowy };
  };
}

export type CaveQuery = (worldX: number, worldY: number, worldZ: number) => boolean;

/** Whether a below-surface cell is carved into cave air. Pure per-position,
 * so chunks agree along their borders for the same reason columns do. */
export function createCaveSampler(seed: number): CaveQuery {
  const noise3D = createNoise3D(mulberry32(deriveSeed(seed, CAVE_SALT)));
  return (worldX: number, worldY: number, worldZ: number): boolean =>
    noise3D(worldX * CAVE_SCALE, worldY * CAVE_SCALE * 1.4, worldZ * CAVE_SCALE) > CAVE_THRESHOLD;
}

function surfaceBlock(profile: ColumnProfile): BlockId {
  if (profile.terrainHeight <= SEA_LEVEL) return BlockId.SAND;
  if (profile.isSnowy) return BlockId.SNOW;
  if (profile.isDesert) return BlockId.SAND;
  return BlockId.GRASS;
}

function subsurfaceBlock(profile: ColumnProfile): BlockId {
  return profile.isDesert ? BlockId.SAND : BlockId.DIRT;
}

/** Fills one column of a chunk (bedrock -> stone -> dirt/sand -> surface ->
 * water/air) given the terrain profile already sampled for that world column.
 * Cave carving happens inline: on land the surface itself may be carved
 * (natural cave mouths on hillsides); under the ocean a guard keeps the
 * seabed watertight. */
function fillColumn(
  chunk: Chunk,
  lx: number,
  lz: number,
  worldX: number,
  worldZ: number,
  profile: ColumnProfile,
  isCave: CaveQuery,
): void {
  const { terrainHeight } = profile;
  const underwater = terrainHeight <= SEA_LEVEL;
  const carveCeiling = underwater ? terrainHeight - OCEAN_FLOOR_GUARD : terrainHeight;

  for (let y = 0; y < CHUNK_HEIGHT; y++) {
    let id: BlockId;
    if (y === 0) {
      id = BlockId.BEDROCK;
    } else if (y < terrainHeight - DIRT_DEPTH) {
      id = BlockId.STONE;
    } else if (y < terrainHeight) {
      id = subsurfaceBlock(profile);
    } else if (y === terrainHeight) {
      id = surfaceBlock(profile);
    } else if (y <= SEA_LEVEL) {
      id = BlockId.WATER;
    } else {
      id = BlockId.AIR;
    }

    if (
      id !== BlockId.BEDROCK &&
      id !== BlockId.AIR &&
      id !== BlockId.WATER &&
      y <= carveCeiling &&
      isCave(worldX, y, worldZ)
    ) {
      id = BlockId.AIR;
    }

    chunk.setBlock(lx, y, lz, id);
  }
}

/** Stamps every tree overlapping this chunk. Tree placement and each tree's
 * surface height come from pure per-world-position functions, so a canopy
 * that straddles a border gets identical blocks stamped from both sides. */
function stampTrees(
  chunk: Chunk,
  seed: number,
  sampleColumn: (x: number, z: number) => ColumnProfile,
  isCave: CaveQuery,
): void {
  const minX = chunk.worldOriginX;
  const maxX = minX + CHUNK_SIZE - 1;
  const minZ = chunk.worldOriginZ;
  const maxZ = minZ + CHUNK_SIZE - 1;

  for (const tree of treeCandidatesNear(seed, minX, maxX, minZ, maxZ)) {
    const profile = sampleColumn(tree.x, tree.z);
    if (!treeAllowedOn(profile, SEA_LEVEL)) continue;
    // A tree can't grow over a cave mouth that swallowed its ground.
    if (isCave(tree.x, profile.terrainHeight, tree.z)) continue;

    for (const block of treeBlocks(tree, profile.terrainHeight)) {
      const lx = block.x - minX;
      const lz = block.z - minZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) continue;
      if (block.y < 1 || block.y >= CHUNK_HEIGHT) continue;
      if (block.kind === "trunk") {
        chunk.setBlock(lx, block.y, lz, BlockId.WOOD);
      } else if (chunk.getBlock(lx, block.y, lz) === BlockId.AIR) {
        chunk.setBlock(lx, block.y, lz, BlockId.LEAVES);
      }
    }
  }
}

export function generateChunk(cx: number, cz: number, seed: number): Chunk {
  const chunk = new Chunk(cx, cz);
  const sampleColumn = createColumnSampler(seed);
  const isCave = createCaveSampler(seed);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const worldX = originX + lx;
      const worldZ = originZ + lz;
      const profile = sampleColumn(worldX, worldZ);
      fillColumn(chunk, lx, lz, worldX, worldZ, profile, isCave);
    }
  }

  stampTrees(chunk, seed, sampleColumn, isCave);

  return chunk;
}
