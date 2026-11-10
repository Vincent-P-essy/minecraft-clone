/** Numeric block ids, stored one byte each in a chunk's Uint8Array. Ids are
 * append-only: saved edits reference them, so an id is never reused. */
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
  TALL_GRASS: 10,
  FLOWER_RED: 11,
  FLOWER_YELLOW: 12,
  FLOWER_BLUE: 13,
  PLANKS: 14,
  COBBLE: 15,
  STONE_BRICK: 16,
  GLASS: 17,
  LANTERN: 18,
  COAL_ORE: 19,
  GOLD_ORE: 20,
  CRYSTAL: 21,
  PALE_WOOD: 22,
  AUTUMN_LEAVES: 23,
  PINE_WOOD: 24,
  PINE_LEAVES: 25,
  CACTUS: 26,
  GRAVEL: 27,
  ICE: 28,
  BRICK: 29,
  SANDSTONE: 30,
  DRY_BUSH: 31,
  FROSTED_GRASS: 32,
  GLOWSHROOM: 33,
  CLAY: 34,
} as const;

export type BlockId = (typeof BlockId)[keyof typeof BlockId];

/** How a block is drawn: a full cube, two crossed quads (plants), or a
 * liquid surface handled by the water pass. */
export type BlockShape = "cube" | "cross" | "liquid" | "none";

/** Wind response in the vertex shader. */
export type BlockSway = "none" | "leaves" | "plant";

export interface BlockDef {
  readonly id: BlockId;
  readonly name: string;
  /** Has collision and stops the player. */
  readonly solid: boolean;
  /** Doesn't occlude a neighboring block's face in the mesher (air, water,
   * leaves, glass, plants). */
  readonly transparent: boolean;
  /** Can be broken and picked up into the hotbar. */
  readonly breakable: boolean;
  readonly shape: BlockShape;
  /** Light emitted, 0..15. */
  readonly emission: number;
  /** How much light this block swallows per step: 0 = clear (air, glass,
   * plants), 1..14 = partial (leaves, water), 15 = opaque. */
  readonly opacity: number;
  readonly sway: BlockSway;
  /** Placing a block here overwrites this one (plants, air, water). */
  readonly replaceable: boolean;
}

function block(id: BlockId, name: string, overrides: Partial<BlockDef> = {}): BlockDef {
  return {
    id,
    name,
    solid: true,
    transparent: false,
    breakable: true,
    shape: "cube",
    emission: 0,
    opacity: 15,
    sway: "none",
    replaceable: false,
    ...overrides,
  };
}

function plant(id: BlockId, name: string, overrides: Partial<BlockDef> = {}): BlockDef {
  return block(id, name, {
    solid: false,
    transparent: true,
    shape: "cross",
    opacity: 0,
    sway: "plant",
    replaceable: true,
    ...overrides,
  });
}

const LEAF: Partial<BlockDef> = { transparent: true, opacity: 1, sway: "leaves" };

export const BLOCKS: Readonly<Record<BlockId, BlockDef>> = {
  [BlockId.AIR]: block(BlockId.AIR, "air", {
    solid: false,
    transparent: true,
    breakable: false,
    shape: "none",
    opacity: 0,
    replaceable: true,
  }),
  [BlockId.GRASS]: block(BlockId.GRASS, "grass"),
  [BlockId.DIRT]: block(BlockId.DIRT, "dirt"),
  [BlockId.STONE]: block(BlockId.STONE, "stone"),
  [BlockId.SAND]: block(BlockId.SAND, "sand"),
  [BlockId.WATER]: block(BlockId.WATER, "water", {
    solid: false,
    transparent: true,
    breakable: false,
    shape: "liquid",
    opacity: 2,
    replaceable: true,
  }),
  [BlockId.WOOD]: block(BlockId.WOOD, "oak log"),
  [BlockId.LEAVES]: block(BlockId.LEAVES, "oak leaves", LEAF),
  [BlockId.BEDROCK]: block(BlockId.BEDROCK, "bedrock", { breakable: false }),
  [BlockId.SNOW]: block(BlockId.SNOW, "snow"),
  [BlockId.TALL_GRASS]: plant(BlockId.TALL_GRASS, "tall grass"),
  [BlockId.FLOWER_RED]: plant(BlockId.FLOWER_RED, "ember bloom"),
  [BlockId.FLOWER_YELLOW]: plant(BlockId.FLOWER_YELLOW, "sun daisy"),
  [BlockId.FLOWER_BLUE]: plant(BlockId.FLOWER_BLUE, "sky bell"),
  [BlockId.PLANKS]: block(BlockId.PLANKS, "planks"),
  [BlockId.COBBLE]: block(BlockId.COBBLE, "cobblestone"),
  [BlockId.STONE_BRICK]: block(BlockId.STONE_BRICK, "stone bricks"),
  [BlockId.GLASS]: block(BlockId.GLASS, "glass", { transparent: true, opacity: 0 }),
  [BlockId.LANTERN]: block(BlockId.LANTERN, "lantern", { emission: 15 }),
  [BlockId.COAL_ORE]: block(BlockId.COAL_ORE, "coal ore"),
  [BlockId.GOLD_ORE]: block(BlockId.GOLD_ORE, "gold ore"),
  [BlockId.CRYSTAL]: block(BlockId.CRYSTAL, "lumen crystal", { emission: 9 }),
  [BlockId.PALE_WOOD]: block(BlockId.PALE_WOOD, "pale log"),
  [BlockId.AUTUMN_LEAVES]: block(BlockId.AUTUMN_LEAVES, "autumn leaves", LEAF),
  [BlockId.PINE_WOOD]: block(BlockId.PINE_WOOD, "pine log"),
  [BlockId.PINE_LEAVES]: block(BlockId.PINE_LEAVES, "pine needles", LEAF),
  [BlockId.CACTUS]: block(BlockId.CACTUS, "cactus"),
  [BlockId.GRAVEL]: block(BlockId.GRAVEL, "gravel"),
  [BlockId.ICE]: block(BlockId.ICE, "ice"),
  [BlockId.BRICK]: block(BlockId.BRICK, "bricks"),
  [BlockId.SANDSTONE]: block(BlockId.SANDSTONE, "sandstone"),
  [BlockId.DRY_BUSH]: plant(BlockId.DRY_BUSH, "dry bush"),
  [BlockId.FROSTED_GRASS]: block(BlockId.FROSTED_GRASS, "frosted grass"),
  [BlockId.GLOWSHROOM]: plant(BlockId.GLOWSHROOM, "glowshroom", { emission: 7, sway: "none" }),
  [BlockId.CLAY]: block(BlockId.CLAY, "clay"),
};

export const BLOCK_COUNT = Object.keys(BLOCKS).length;

/** Flat lookup tables for the hot loops (lighting, meshing, raycasting),
 * indexed by block id — a typed-array read instead of an object walk. */
const table = (pick: (def: BlockDef) => number): Uint8Array => {
  const out = new Uint8Array(256);
  for (const def of Object.values(BLOCKS)) out[def.id] = pick(def);
  return out;
};

/** 1 where the block fully stops light and hides neighbor faces. */
export const OPAQUE = table((d) => (d.opacity >= 15 ? 1 : 0));
/** Light swallowed per propagation step, 0..15. */
export const LIGHT_OPACITY = table((d) => d.opacity);
export const LIGHT_EMISSION = table((d) => d.emission);
export const SOLID = table((d) => (d.solid ? 1 : 0));
/** 1 for blocks that darken the corners of faces around them. */
export const AO_OCCLUDER = table((d) =>
  d.shape === "cube" && d.id !== BlockId.GLASS && d.opacity > 0 ? 1 : 0,
);

export function isSolid(id: BlockId): boolean {
  return BLOCKS[id].solid;
}

export function isTransparent(id: BlockId): boolean {
  return BLOCKS[id].transparent;
}

/** Whether the crosshair can land on this block (anything but air/water). */
export function isTargetable(id: BlockId): boolean {
  const shape = BLOCKS[id].shape;
  return shape === "cube" || shape === "cross";
}

export function isPlant(id: BlockId): boolean {
  return BLOCKS[id].shape === "cross";
}

/** The default hotbar, in slot order. */
export const PLACEABLE_BLOCKS: readonly BlockId[] = [
  BlockId.GRASS,
  BlockId.DIRT,
  BlockId.STONE,
  BlockId.PLANKS,
  BlockId.WOOD,
  BlockId.GLASS,
  BlockId.LANTERN,
  BlockId.STONE_BRICK,
  BlockId.SAND,
];

/** Everything the creative inventory offers. */
export const INVENTORY_BLOCKS: readonly BlockId[] = [
  BlockId.GRASS,
  BlockId.DIRT,
  BlockId.STONE,
  BlockId.COBBLE,
  BlockId.STONE_BRICK,
  BlockId.BRICK,
  BlockId.SAND,
  BlockId.SANDSTONE,
  BlockId.GRAVEL,
  BlockId.CLAY,
  BlockId.SNOW,
  BlockId.ICE,
  BlockId.FROSTED_GRASS,
  BlockId.WOOD,
  BlockId.PALE_WOOD,
  BlockId.PINE_WOOD,
  BlockId.PLANKS,
  BlockId.LEAVES,
  BlockId.AUTUMN_LEAVES,
  BlockId.PINE_LEAVES,
  BlockId.GLASS,
  BlockId.LANTERN,
  BlockId.CRYSTAL,
  BlockId.COAL_ORE,
  BlockId.GOLD_ORE,
  BlockId.CACTUS,
  BlockId.TALL_GRASS,
  BlockId.FLOWER_RED,
  BlockId.FLOWER_YELLOW,
  BlockId.FLOWER_BLUE,
  BlockId.DRY_BUSH,
  BlockId.GLOWSHROOM,
];
