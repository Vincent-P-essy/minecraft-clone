import { BlockId } from "../world/blocks";

/** Pure geometry of the texture atlas — which grid cell holds which
 * texture, and the UV rect for it. Kept separate from the actual pixel
 * drawing (texture-atlas.ts) so this part is unit-testable without a
 * canvas, and separate from the mesher so face-tile logic is one lookup
 * table instead of being scattered through the meshing loop. */

export const ATLAS_TILE_SIZE = 16;
export const ATLAS_GRID_SIZE = 4;
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
} as const;

export type TileKind = (typeof TileKind)[keyof typeof TileKind];

export const ALL_TILE_KINDS: readonly TileKind[] = Object.values(TileKind);

export type Face = "top" | "bottom" | "north" | "south" | "east" | "west";

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

export function tileForBlockFace(id: BlockId, face: Face): TileKind {
  switch (id) {
    case BlockId.GRASS:
      if (face === "top") return TileKind.GRASS_TOP;
      if (face === "bottom") return TileKind.DIRT;
      return TileKind.GRASS_SIDE;
    case BlockId.DIRT:
      return TileKind.DIRT;
    case BlockId.STONE:
      return TileKind.STONE;
    case BlockId.SAND:
      return TileKind.SAND;
    case BlockId.WATER:
      return TileKind.WATER;
    case BlockId.WOOD:
      return face === "top" || face === "bottom" ? TileKind.WOOD_TOP : TileKind.WOOD_SIDE;
    case BlockId.LEAVES:
      return TileKind.LEAVES;
    case BlockId.BEDROCK:
      return TileKind.BEDROCK;
    case BlockId.SNOW:
      return TileKind.SNOW;
    case BlockId.AIR:
      return TileKind.STONE; // never sampled — the mesher skips air outright
  }
}
