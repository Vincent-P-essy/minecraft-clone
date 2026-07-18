/** Numeric block ids, stored one byte each in a chunk's Uint8Array. */
export const BlockId = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  WOOD: 6,
  LEAVES: 7,
  BEDROCK: 8,
  SNOW: 9,
} as const;

export type BlockId = (typeof BlockId)[keyof typeof BlockId];

export interface BlockDef {
  readonly id: BlockId;
  readonly name: string;
  /** Has collision and stops the player. */
  readonly solid: boolean;
  /** Doesn't occlude a neighboring block's face in the mesher (air, water, leaves). */
  readonly transparent: boolean;
  /** Can be broken and picked up into the hotbar. */
  readonly breakable: boolean;
}

function block(id: BlockId, name: string, overrides: Partial<BlockDef> = {}): BlockDef {
  return { id, name, solid: true, transparent: false, breakable: true, ...overrides };
}

export const BLOCKS: Readonly<Record<BlockId, BlockDef>> = {
  [BlockId.AIR]: block(BlockId.AIR, "air", { solid: false, transparent: true, breakable: false }),
  [BlockId.GRASS]: block(BlockId.GRASS, "grass"),
  [BlockId.DIRT]: block(BlockId.DIRT, "dirt"),
  [BlockId.STONE]: block(BlockId.STONE, "stone"),
  [BlockId.SAND]: block(BlockId.SAND, "sand"),
  [BlockId.WATER]: block(BlockId.WATER, "water", {
    solid: false,
    transparent: true,
    breakable: false,
  }),
  [BlockId.WOOD]: block(BlockId.WOOD, "wood"),
  [BlockId.LEAVES]: block(BlockId.LEAVES, "leaves", { transparent: true }),
  [BlockId.BEDROCK]: block(BlockId.BEDROCK, "bedrock", { breakable: false }),
  [BlockId.SNOW]: block(BlockId.SNOW, "snow"),
};

export function isSolid(id: BlockId): boolean {
  return BLOCKS[id].solid;
}

export function isTransparent(id: BlockId): boolean {
  return BLOCKS[id].transparent;
}

/** Blocks a player can place from the hotbar, in hotbar order. */
export const PLACEABLE_BLOCKS: readonly BlockId[] = [
  BlockId.GRASS,
  BlockId.DIRT,
  BlockId.STONE,
  BlockId.SAND,
  BlockId.WOOD,
  BlockId.LEAVES,
  BlockId.SNOW,
];
