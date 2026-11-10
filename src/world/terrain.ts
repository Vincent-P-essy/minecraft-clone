import { createNoise3D } from "simplex-noise";
import { BlockId } from "./blocks";
import { Chunk } from "./chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "./coords";
import { type TreeCandidate, type TreeSpecies, treeBlocks, treeCandidatesNear } from "./features";
import { createFbmNoise2D } from "./noise";
import { deriveSeed, mulberry32 } from "./rng";

export const SEA_LEVEL = 48;
export const DIRT_DEPTH = 4;
const MAX_TERRAIN_HEIGHT = CHUNK_HEIGHT - 12;

const CAVE_SCALE = 0.065;
const CAVE_THRESHOLD = 0.58;
/** Cheese-noise band just outside a cavern wall where crystals may grow. */
const CRYSTAL_BAND = 0.5;
const TUNNEL_SCALE = 0.016;
const TUNNEL_WIDTH = 0.062;
/** Under water (and right at the shoreline), caves stay at least this far
 * below the bed so they never punch a dry hole into a lake or the sea. */
const WATER_FLOOR_GUARD = 4;

export const Biome = {
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  AUTUMN: 4,
  PINE: 5,
  DESERT: 6,
  TUNDRA: 7,
  MOUNTAIN: 8,
  SNOW_PEAK: 9,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];

export interface ColumnProfile {
  readonly terrainHeight: number;
  readonly biome: Biome;
  readonly isDesert: boolean;
  readonly isSnowy: boolean;
  /** Cold enough that standing water freezes over. */
  readonly frozen: boolean;
  /** Small-scale variation in [-1, 1], used to dither surface materials. */
  readonly detail: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A well-mixed 32-bit hash of integer coordinates — the source of every
 * per-cell random decision (plants, ores), so they're pure per position. */
export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ x, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h ^ y, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h ^ z, 0x27d4eb2f) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** Per-world-column terrain shape, independent of which chunk asks for it —
 * this is what makes chunk borders seamless: two chunks sampling the same
 * world (x, z) always agree, because neither of them is the source of truth,
 * the noise field is. */
export function createColumnSampler(
  seed: number,
): (worldX: number, worldZ: number) => ColumnProfile {
  const fbm = (salt: number, octaves: number, scale: number) =>
    createFbmNoise2D(deriveSeed(seed, salt), { octaves, persistence: 0.5, scale });

  const continent = fbm(0xc0a7, 4, 0.0014);
  const hills = fbm(0x4111, 4, 0.007);
  const detailNoise = fbm(0xde7a, 2, 0.035);
  const mountainMask = fbm(0x3a55, 3, 0.0022);
  const ridgeNoise = fbm(0x61d6, 4, 0.0055);
  const riverNoise = fbm(0x61fe, 2, 0.0028);
  const temperature = fbm(0x7e39, 3, 0.0011);
  const moisture = fbm(0x51a7, 3, 0.0015);

  return (worldX: number, worldZ: number): ColumnProfile => {
    const c = continent(worldX, worldZ) + 0.2;
    const coast = smoothstep(-0.22, -0.02, c);
    const inland = smoothstep(-0.02, 0.3, c);
    const n = hills(worldX, worldZ);
    const detail = detailNoise(worldX, worldZ);
    const mountains = smoothstep(0.1, 0.48, mountainMask(worldX, worldZ)) * inland;
    const ridge = Math.max(0, 1 - Math.abs(ridgeNoise(worldX, worldZ)) * 1.7);

    let height =
      SEA_LEVEL -
      18 +
      coast * 21 +
      n * (4 + 8 * inland) +
      detail * 1.6 +
      mountains * (ridge * ridge * 58 + 8 + n * 6);

    // Rivers: a thin band where a slow noise crosses zero cuts a channel to
    // just below sea level, inside a wider, gentler valley. They fade out
    // in the high mountains instead of sawing them in half.
    if (height > SEA_LEVEL - 3) {
      const r = Math.abs(riverNoise(worldX, worldZ));
      const lowland = 1 - mountains * 0.85;
      const valley = (1 - smoothstep(0.035, 0.15, r)) * lowland;
      const channel = (1 - smoothstep(0.01, 0.035, r)) * lowland;
      height = lerp(height, Math.min(height, SEA_LEVEL + 3 + n * 2), valley * 0.6);
      height = lerp(height, SEA_LEVEL - 3.2, channel);
    }

    const terrainHeight = Math.max(2, Math.min(MAX_TERRAIN_HEIGHT, Math.round(height)));
    const elevation = terrainHeight - SEA_LEVEL;

    const temp = temperature(worldX, worldZ) - Math.max(0, elevation - 18) * 0.012;
    const wet = moisture(worldX, worldZ);
    const frozen = temp < -0.34;

    let biome: Biome;
    if (terrainHeight <= SEA_LEVEL) biome = Biome.OCEAN;
    else if (elevation >= 54 + detail * 5) biome = Biome.SNOW_PEAK;
    else if (elevation >= 33 + detail * 5) biome = Biome.MOUNTAIN;
    else if (frozen) biome = Biome.TUNDRA;
    else if (elevation <= 2) biome = Biome.BEACH;
    else if (temp > 0.2 && wet < 0 && elevation < 24) biome = Biome.DESERT;
    else if (temp < -0.16) biome = Biome.PINE;
    else if (temp < -0.02 && wet > -0.1) biome = Biome.AUTUMN;
    else if (wet > 0.02) biome = Biome.FOREST;
    else biome = Biome.PLAINS;

    return {
      terrainHeight,
      biome,
      isDesert: biome === Biome.DESERT,
      isSnowy: biome === Biome.TUNDRA || biome === Biome.SNOW_PEAK,
      frozen,
      detail,
    };
  };
}

export type CaveQuery = (worldX: number, worldY: number, worldZ: number) => boolean;

interface CaveField {
  /** Raw cavern noise; above CAVE_THRESHOLD the cell is open. */
  readonly cheese: (x: number, y: number, z: number) => number;
  /** Winding tunnels that link the caverns together. */
  readonly tunnel: (x: number, y: number, z: number) => boolean;
}

function createCaveField(seed: number): CaveField {
  const cheese3D = createNoise3D(mulberry32(deriveSeed(seed, 0xca4e)));
  const tunnelA = createNoise3D(mulberry32(deriveSeed(seed, 0x7a11)));
  const tunnelB = createNoise3D(mulberry32(deriveSeed(seed, 0x7b22)));
  return {
    cheese: (x, y, z) => cheese3D(x * CAVE_SCALE, y * CAVE_SCALE * 1.4, z * CAVE_SCALE),
    tunnel: (x, y, z) => {
      const sx = x * TUNNEL_SCALE;
      const sy = y * TUNNEL_SCALE * 1.7;
      const sz = z * TUNNEL_SCALE;
      if (Math.abs(tunnelA(sx, sy, sz)) > TUNNEL_WIDTH) return false;
      return Math.abs(tunnelB(sx, sy, sz)) <= TUNNEL_WIDTH;
    },
  };
}

/** Whether a below-surface cell is carved into cave air. Pure per-position,
 * so chunks agree along their borders for the same reason columns do. */
export function createCaveSampler(seed: number): CaveQuery {
  const field = createCaveField(seed);
  return (x, y, z) => field.cheese(x, y, z) > CAVE_THRESHOLD || field.tunnel(x, y, z);
}

/** The block on top of a column, before caves and plants. */
export function surfaceBlock(profile: ColumnProfile): BlockId {
  const { biome, detail, terrainHeight } = profile;
  switch (biome) {
    case Biome.OCEAN: {
      const depth = SEA_LEVEL - terrainHeight;
      if (depth > 5 && detail > 0.3) return BlockId.GRAVEL;
      if (depth > 2 && detail < -0.42) return BlockId.CLAY;
      return BlockId.SAND;
    }
    case Biome.BEACH:
    case Biome.DESERT:
      return BlockId.SAND;
    case Biome.TUNDRA:
      return detail > 0.25 ? BlockId.SNOW : BlockId.FROSTED_GRASS;
    case Biome.MOUNTAIN:
      if (detail > 0.32) return BlockId.GRAVEL;
      return terrainHeight - SEA_LEVEL < 40 && detail < -0.05 ? BlockId.GRASS : BlockId.STONE;
    case Biome.SNOW_PEAK:
      return BlockId.SNOW;
    default:
      return BlockId.GRASS;
  }
}

/** The block `depth` cells under the surface (depth >= 1). */
function subsurfaceBlock(profile: ColumnProfile, depth: number): BlockId {
  switch (profile.biome) {
    case Biome.DESERT:
      return depth <= 3 ? BlockId.SAND : depth <= 7 ? BlockId.SANDSTONE : BlockId.STONE;
    case Biome.BEACH:
    case Biome.OCEAN:
      return depth <= 2 ? BlockId.SAND : BlockId.STONE;
    case Biome.MOUNTAIN:
      return BlockId.STONE;
    case Biome.SNOW_PEAK:
      return depth <= 1 ? BlockId.SNOW : BlockId.STONE;
    default:
      return depth <= DIRT_DEPTH - 1 ? BlockId.DIRT : BlockId.STONE;
  }
}

/** Ore veins: every 4x4x4 lattice cell may hold one small blob, decided by
 * a hash — no noise evaluation, and pure per position. */
function oreAt(seed: number, x: number, y: number, z: number): BlockId {
  const h = hash3(seed ^ 0x0be5, x >> 2, y >> 2, z >> 2);
  const kind = h & 0xff;
  if (kind >= 20) return BlockId.STONE;
  const cx = 1 + ((h >>> 8) & 1);
  const cy = 1 + ((h >>> 9) & 1);
  const cz = 1 + ((h >>> 10) & 1);
  const dx = (x & 3) - cx;
  const dy = (y & 3) - cy;
  const dz = (z & 3) - cz;
  const reach = (h >>> 11) & 1 ? 2 : 1;
  if (dx * dx + dy * dy + dz * dz > reach) return BlockId.STONE;
  if (kind < 15) return BlockId.COAL_ORE;
  return y < 34 ? BlockId.GOLD_ORE : BlockId.STONE;
}

/** What grows on top of a column, if anything. */
function plantFor(seed: number, profile: ColumnProfile, x: number, z: number): BlockId {
  const roll = (hash3(seed ^ 0x9a55, x, 0, z) & 0xffff) / 0x10000;
  const flower = (): BlockId => {
    // Flowers come in patches of one colour, a dozen blocks across.
    const patch = hash3(seed ^ 0xf10e, Math.floor(x / 12), 1, Math.floor(z / 12)) % 3;
    return patch === 0
      ? BlockId.FLOWER_RED
      : patch === 1
        ? BlockId.FLOWER_YELLOW
        : BlockId.FLOWER_BLUE;
  };
  switch (profile.biome) {
    case Biome.PLAINS:
      if (roll < 0.06) return flower();
      return roll < 0.36 ? BlockId.TALL_GRASS : BlockId.AIR;
    case Biome.FOREST:
      if (roll < 0.02) return flower();
      return roll < 0.16 ? BlockId.TALL_GRASS : BlockId.AIR;
    case Biome.AUTUMN:
      return roll < 0.1 ? BlockId.TALL_GRASS : BlockId.AIR;
    case Biome.PINE:
      return roll < 0.05 ? BlockId.TALL_GRASS : BlockId.AIR;
    case Biome.DESERT:
      return roll < 0.012 ? BlockId.DRY_BUSH : BlockId.AIR;
    case Biome.MOUNTAIN:
      return roll < 0.04 ? BlockId.TALL_GRASS : BlockId.AIR;
    default:
      return BlockId.AIR;
  }
}

/** Which tree (if any) a candidate grows into on this column. */
export function treeSpeciesAt(profile: ColumnProfile, tree: TreeCandidate): TreeSpecies | null {
  if (profile.terrainHeight <= SEA_LEVEL + 1) return null;
  const roll = tree.roll ?? 0;
  const variant = tree.variant ?? 0;
  switch (profile.biome) {
    case Biome.FOREST:
      if (roll >= 0.55) return null;
      return variant < 0.12 ? "great-oak" : "oak";
    case Biome.PLAINS:
      return roll < 0.035 ? "oak" : null;
    case Biome.AUTUMN:
      return roll < 0.5 ? "pale" : null;
    case Biome.PINE:
      return roll < 0.55 ? "pine" : null;
    case Biome.TUNDRA:
      return roll < 0.07 ? "pine" : null;
    case Biome.MOUNTAIN:
      return roll < 0.05 && profile.terrainHeight - SEA_LEVEL < 46 ? "pine" : null;
    case Biome.DESERT:
      return roll < 0.05 ? "cactus" : null;
    default:
      return null;
  }
}

const TRUNK_BLOCK: Record<TreeSpecies, BlockId> = {
  oak: BlockId.WOOD,
  "great-oak": BlockId.WOOD,
  pale: BlockId.PALE_WOOD,
  pine: BlockId.PINE_WOOD,
  cactus: BlockId.CACTUS,
};

const LEAF_BLOCK: Record<TreeSpecies, BlockId> = {
  oak: BlockId.LEAVES,
  "great-oak": BlockId.LEAVES,
  pale: BlockId.AUTUMN_LEAVES,
  pine: BlockId.PINE_LEAVES,
  cactus: BlockId.AIR,
};

export function trunkBlockFor(species: TreeSpecies): BlockId {
  return TRUNK_BLOCK[species];
}

interface Terrain {
  readonly sampleColumn: (x: number, z: number) => ColumnProfile;
  readonly cave: CaveField;
  readonly isCave: CaveQuery;
}

/** Noise tables are a pure function of the seed, so build them once. */
const terrainCache = new Map<number, Terrain>();
function terrainFor(seed: number): Terrain {
  let terrain = terrainCache.get(seed);
  if (!terrain) {
    const cave = createCaveField(seed);
    terrain = {
      sampleColumn: createColumnSampler(seed),
      cave,
      isCave: (x, y, z) => cave.cheese(x, y, z) > CAVE_THRESHOLD || cave.tunnel(x, y, z),
    };
    if (terrainCache.size > 4) terrainCache.clear();
    terrainCache.set(seed, terrain);
  }
  return terrain;
}

/** Fills one column of a chunk (bedrock -> stone and ores -> soil -> surface
 * -> water/air) given the terrain profile already sampled for that world
 * column. Cave carving happens inline: on land the surface itself may be
 * carved (natural cave mouths on hillsides); under water a guard keeps the
 * bed watertight. */
function fillColumn(
  chunk: Chunk,
  lx: number,
  lz: number,
  worldX: number,
  worldZ: number,
  profile: ColumnProfile,
  terrain: Terrain,
  seed: number,
): void {
  const { terrainHeight } = profile;
  const nearWater = terrainHeight <= SEA_LEVEL + 2;
  const carveCeiling = nearWater ? terrainHeight - WATER_FLOOR_GUARD : terrainHeight;
  const top = surfaceBlock(profile);
  const { cave } = terrain;

  let below: BlockId = BlockId.BEDROCK;
  let surfaceIntact = true;
  for (let y = 0; y < CHUNK_HEIGHT; y++) {
    let id: BlockId;
    if (y === 0) {
      id = BlockId.BEDROCK;
    } else if (y < terrainHeight) {
      id = subsurfaceBlock(profile, terrainHeight - y);
      if (id === BlockId.STONE) id = oreAt(seed, worldX, y, worldZ);
    } else if (y === terrainHeight) {
      id = top;
    } else if (y <= SEA_LEVEL) {
      id = y === SEA_LEVEL && profile.frozen ? BlockId.ICE : BlockId.WATER;
    } else {
      break; // everything above is air, which the chunk already is
    }

    if (y > 0 && y <= carveCeiling && y <= terrainHeight) {
      const cheese = cave.cheese(worldX, y, worldZ);
      if (cheese > CAVE_THRESHOLD || cave.tunnel(worldX, y, worldZ)) {
        // Open cave. Now and then a glowing mushroom takes root on the floor.
        const floor: boolean = below !== BlockId.AIR && below !== BlockId.GLOWSHROOM;
        id =
          floor && y < terrainHeight - 8 && (hash3(seed ^ 0x5407, worldX, y, worldZ) & 0x3f) < 2
            ? BlockId.GLOWSHROOM
            : BlockId.AIR;
        if (y === terrainHeight) surfaceIntact = false;
      } else if (
        id === BlockId.STONE &&
        cheese > CRYSTAL_BAND &&
        y < SEA_LEVEL - 4 &&
        (hash3(seed ^ 0xc457, worldX >> 1, y >> 1, worldZ >> 1) & 7) === 0
      ) {
        // Crystals grow in the walls right around caverns, where they'll be seen.
        id = BlockId.CRYSTAL;
      }
    }

    if (id !== BlockId.AIR) chunk.setBlock(lx, y, lz, id);
    below = id;
  }

  if (surfaceIntact && terrainHeight > SEA_LEVEL && terrainHeight + 1 < CHUNK_HEIGHT) {
    const plant = plantFor(seed, profile, worldX, worldZ);
    if (plant !== BlockId.AIR && (top === BlockId.GRASS || top === BlockId.SAND)) {
      chunk.setBlock(lx, terrainHeight + 1, lz, plant);
    }
  }
}

function isSoft(id: BlockId): boolean {
  return (
    id === BlockId.AIR ||
    id === BlockId.TALL_GRASS ||
    id === BlockId.FLOWER_RED ||
    id === BlockId.FLOWER_YELLOW ||
    id === BlockId.FLOWER_BLUE ||
    id === BlockId.DRY_BUSH
  );
}

/** Stamps every tree overlapping this chunk. Tree placement and each tree's
 * surface height come from pure per-world-position functions, so a canopy
 * that straddles a border gets identical blocks stamped from both sides. */
function stampTrees(chunk: Chunk, seed: number, terrain: Terrain): void {
  const minX = chunk.worldOriginX;
  const maxX = minX + CHUNK_SIZE - 1;
  const minZ = chunk.worldOriginZ;
  const maxZ = minZ + CHUNK_SIZE - 1;

  for (const tree of treeCandidatesNear(seed, minX, maxX, minZ, maxZ)) {
    const profile = terrain.sampleColumn(tree.x, tree.z);
    const species = treeSpeciesAt(profile, tree);
    if (!species) continue;
    // A tree can't grow over a cave mouth that swallowed its ground.
    if (terrain.isCave(tree.x, profile.terrainHeight, tree.z)) continue;
    // Cacti only stand on sand; everything else wants soil.
    const ground = surfaceBlock(profile);
    if (species === "cactus" ? ground !== BlockId.SAND : ground === BlockId.STONE) continue;

    const trunk = TRUNK_BLOCK[species];
    const leaves = LEAF_BLOCK[species];
    for (const block of treeBlocks(tree, profile.terrainHeight, species)) {
      const lx = block.x - minX;
      const lz = block.z - minZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) continue;
      if (block.y < 1 || block.y >= CHUNK_HEIGHT) continue;
      if (block.kind === "trunk") {
        chunk.setBlock(lx, block.y, lz, trunk);
      } else if (isSoft(chunk.getBlock(lx, block.y, lz))) {
        chunk.setBlock(lx, block.y, lz, leaves);
      }
    }
  }
}

export function generateChunk(cx: number, cz: number, seed: number): Chunk {
  const chunk = new Chunk(cx, cz);
  const terrain = terrainFor(seed);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const worldX = originX + lx;
      const worldZ = originZ + lz;
      const profile = terrain.sampleColumn(worldX, worldZ);
      fillColumn(chunk, lx, lz, worldX, worldZ, profile, terrain, seed);
    }
  }

  stampTrees(chunk, seed, terrain);

  return chunk;
}
