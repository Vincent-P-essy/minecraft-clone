import { BlockId } from "../world/blocks";

/** Flat per-block colors for the CPU raycaster — the same palette the
 * procedural textures are painted from, without needing a canvas. A few
 * blocks have a top that differs from their sides. */
export interface BlockColor {
  readonly top: readonly [number, number, number];
  readonly side: readonly [number, number, number];
}

const uniform = (r: number, g: number, b: number): BlockColor => ({
  top: [r, g, b],
  side: [r, g, b],
});

export const BLOCK_COLORS: Readonly<Record<BlockId, BlockColor>> = {
  [BlockId.AIR]: uniform(0, 0, 0), // never drawn — rays pass through air
  [BlockId.GRASS]: { top: [80, 142, 54], side: [116, 82, 52] },
  [BlockId.DIRT]: uniform(116, 82, 52),
  [BlockId.STONE]: uniform(124, 124, 130),
  [BlockId.SAND]: uniform(218, 198, 132),
  [BlockId.WATER]: uniform(52, 120, 190),
  [BlockId.WOOD]: { top: [170, 134, 86], side: [98, 70, 42] },
  [BlockId.LEAVES]: uniform(56, 114, 42),
  [BlockId.BEDROCK]: uniform(40, 40, 46),
  [BlockId.SNOW]: uniform(238, 244, 250),
  [BlockId.TALL_GRASS]: uniform(80, 142, 54),
  [BlockId.FLOWER_RED]: uniform(226, 58, 44),
  [BlockId.FLOWER_YELLOW]: uniform(250, 214, 60),
  [BlockId.FLOWER_BLUE]: uniform(86, 130, 240),
  [BlockId.PLANKS]: uniform(174, 134, 80),
  [BlockId.COBBLE]: uniform(120, 120, 126),
  [BlockId.STONE_BRICK]: uniform(124, 124, 130),
  [BlockId.GLASS]: uniform(214, 236, 244),
  [BlockId.LANTERN]: uniform(255, 214, 130),
  [BlockId.COAL_ORE]: uniform(96, 96, 102),
  [BlockId.GOLD_ORE]: uniform(168, 150, 98),
  [BlockId.CRYSTAL]: uniform(110, 200, 226),
  [BlockId.PALE_WOOD]: { top: [214, 198, 156], side: [220, 218, 208] },
  [BlockId.AUTUMN_LEAVES]: uniform(214, 110, 30),
  [BlockId.PINE_WOOD]: { top: [152, 110, 68], side: [70, 46, 30] },
  [BlockId.PINE_LEAVES]: uniform(34, 84, 56),
  [BlockId.CACTUS]: uniform(60, 130, 58),
  [BlockId.GRAVEL]: uniform(128, 122, 118),
  [BlockId.ICE]: uniform(164, 208, 242),
  [BlockId.BRICK]: uniform(158, 80, 60),
  [BlockId.SANDSTONE]: uniform(208, 186, 122),
  [BlockId.DRY_BUSH]: uniform(122, 90, 52),
  [BlockId.FROSTED_GRASS]: { top: [238, 244, 250], side: [116, 82, 52] },
  [BlockId.GLOWSHROOM]: uniform(96, 236, 228),
  [BlockId.CLAY]: uniform(154, 162, 176),
};
