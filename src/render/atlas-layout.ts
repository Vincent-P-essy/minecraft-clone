import { BlockId } from "../world/blocks";

/** Pure geometry of the texture atlas — which grid cell holds which
 * texture, and the UV rect for it. Kept separate from the actual pixel
 * drawing (tile-painter.ts) so this part is unit-testable without a
 * canvas, and separate from the mesher so face-tile logic is one lookup
 * table instead of being scattered through the meshing loop. */

export const ATLAS_TILE_SIZE = 16;
export const ATLAS_GRID_SIZE = 8;
export const ATLAS_PIXELS = ATLAS_TILE_SIZE * ATLAS_GRID_SIZE;

export const TileKind = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  WOOD_SIDE: 6,
  WOOD_TOP: 7,
  LEAVES: 8,
  BEDROCK: 9,
  SNOW: 10,
  TALL_GRASS: 11,
  FLOWER_RED: 12,
  FLOWER_YELLOW: 13,
  FLOWER_BLUE: 14,
  PLANKS: 15,
  COBBLE: 16,
  STONE_BRICK: 17,
  GLASS: 18,
  LANTERN: 19,
  COAL_ORE: 20,
  GOLD_ORE: 21,
  CRYSTAL: 22,
  PALE_WOOD_SIDE: 23,
  PALE_WOOD_TOP: 24,
  AUTUMN_LEAVES: 25,
  PINE_WOOD_SIDE: 26,
  PINE_WOOD_TOP: 27,
  PINE_LEAVES: 28,
  CACTUS_SIDE: 29,
  CACTUS_TOP: 30,
  GRAVEL: 31,
  ICE: 32,
  BRICK: 33,
  SANDSTONE_SIDE: 34,
  SANDSTONE_TOP: 35,
  DRY_BUSH: 36,
  FROSTED_GRASS_SIDE: 37,
  GLOWSHROOM: 38,
  CLAY: 39,
  LANTERN_TOP: 40,
} as const;

export type TileKind = (typeof TileKind)[keyof typeof TileKind];

export const ALL_TILE_KINDS: readonly TileKind[] = Object.values(TileKind);
export const TILE_COUNT = ALL_TILE_KINDS.length;

export type Face = "top" | "bottom" | "north" | "south" | "east" | "west";

/** Face order shared by the mesher's packed vertices and the shaders'
 * normal table. */
export const FACE_ORDER: readonly Face[] = ["top", "bottom", "north", "south", "east", "west"];

export function tileGridPosition(tile: TileKind): { col: number; row: number } {
  return { col: tile % ATLAS_GRID_SIZE, row: Math.floor(tile / ATLAS_GRID_SIZE) };
}

/** UV rect [u0, v0, u1, v1] for a tile, in 0..1 atlas space. V is measured
 * from the top of the atlas image, matching canvas pixel coordinates. */
export function tileUV(tile: TileKind): readonly [number, number, number, number] {
  const { col, row } = tileGridPosition(tile);
  const step = 1 / ATLAS_GRID_SIZE;
  const u0 = col * step;
  const v0 = row * step;
  return [u0, v0, u0 + step, v0 + step];
}

/** [top, side, bottom] tiles for blocks that aren't the same on every face. */
const CAPPED: Partial<Record<BlockId, readonly [TileKind, TileKind, TileKind]>> = {
  [BlockId.GRASS]: [TileKind.GRASS_TOP, TileKind.GRASS_SIDE, TileKind.DIRT],
  [BlockId.FROSTED_GRASS]: [TileKind.SNOW, TileKind.FROSTED_GRASS_SIDE, TileKind.DIRT],
  [BlockId.WOOD]: [TileKind.WOOD_TOP, TileKind.WOOD_SIDE, TileKind.WOOD_TOP],
  [BlockId.PALE_WOOD]: [TileKind.PALE_WOOD_TOP, TileKind.PALE_WOOD_SIDE, TileKind.PALE_WOOD_TOP],
  [BlockId.PINE_WOOD]: [TileKind.PINE_WOOD_TOP, TileKind.PINE_WOOD_SIDE, TileKind.PINE_WOOD_TOP],
  [BlockId.CACTUS]: [TileKind.CACTUS_TOP, TileKind.CACTUS_SIDE, TileKind.CACTUS_TOP],
  [BlockId.SANDSTONE]: [TileKind.SANDSTONE_TOP, TileKind.SANDSTONE_SIDE, TileKind.SANDSTONE_TOP],
  [BlockId.LANTERN]: [TileKind.LANTERN_TOP, TileKind.LANTERN, TileKind.LANTERN_TOP],
};

const UNIFORM: Record<BlockId, TileKind> = {
  [BlockId.AIR]: TileKind.STONE, // never sampled — the mesher skips air outright
  [BlockId.GRASS]: TileKind.GRASS_SIDE,
  [BlockId.DIRT]: TileKind.DIRT,
  [BlockId.STONE]: TileKind.STONE,
  [BlockId.SAND]: TileKind.SAND,
  [BlockId.WATER]: TileKind.WATER,
  [BlockId.WOOD]: TileKind.WOOD_SIDE,
  [BlockId.LEAVES]: TileKind.LEAVES,
  [BlockId.BEDROCK]: TileKind.BEDROCK,
  [BlockId.SNOW]: TileKind.SNOW,
  [BlockId.TALL_GRASS]: TileKind.TALL_GRASS,
  [BlockId.FLOWER_RED]: TileKind.FLOWER_RED,
  [BlockId.FLOWER_YELLOW]: TileKind.FLOWER_YELLOW,
  [BlockId.FLOWER_BLUE]: TileKind.FLOWER_BLUE,
  [BlockId.PLANKS]: TileKind.PLANKS,
  [BlockId.COBBLE]: TileKind.COBBLE,
  [BlockId.STONE_BRICK]: TileKind.STONE_BRICK,
  [BlockId.GLASS]: TileKind.GLASS,
  [BlockId.LANTERN]: TileKind.LANTERN,
  [BlockId.COAL_ORE]: TileKind.COAL_ORE,
  [BlockId.GOLD_ORE]: TileKind.GOLD_ORE,
  [BlockId.CRYSTAL]: TileKind.CRYSTAL,
  [BlockId.PALE_WOOD]: TileKind.PALE_WOOD_SIDE,
  [BlockId.AUTUMN_LEAVES]: TileKind.AUTUMN_LEAVES,
  [BlockId.PINE_WOOD]: TileKind.PINE_WOOD_SIDE,
  [BlockId.PINE_LEAVES]: TileKind.PINE_LEAVES,
  [BlockId.CACTUS]: TileKind.CACTUS_SIDE,
  [BlockId.GRAVEL]: TileKind.GRAVEL,
  [BlockId.ICE]: TileKind.ICE,
  [BlockId.BRICK]: TileKind.BRICK,
  [BlockId.SANDSTONE]: TileKind.SANDSTONE_SIDE,
  [BlockId.DRY_BUSH]: TileKind.DRY_BUSH,
  [BlockId.FROSTED_GRASS]: TileKind.FROSTED_GRASS_SIDE,
  [BlockId.GLOWSHROOM]: TileKind.GLOWSHROOM,
  [BlockId.CLAY]: TileKind.CLAY,
};

export function tileForBlockFace(id: BlockId, face: Face): TileKind {
  const capped = CAPPED[id];
  if (capped) return face === "top" ? capped[0] : face === "bottom" ? capped[2] : capped[1];
  return UNIFORM[id];
}

/** Flat `blockId * 6 + faceIndex -> tile` table for the mesher's hot loop. */
export const TILE_TABLE: Uint8Array = (() => {
  const out = new Uint8Array(256 * 6);
  for (const id of Object.values(BlockId)) {
    FACE_ORDER.forEach((face, f) => {
      out[id * 6 + f] = tileForBlockFace(id, face);
    });
  }
  return out;
})();
