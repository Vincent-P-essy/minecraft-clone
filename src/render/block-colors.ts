import { BlockId } from "../world/blocks";

/** Flat per-block colors for the CPU raycaster — the same palette the
 * procedural texture atlas is built from, without needing a canvas. Grass
 * is the one block whose top and sides differ. */
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
  [BlockId.GRASS]: { top: [86, 140, 58], side: [122, 84, 51] },
  [BlockId.DIRT]: uniform(122, 84, 51),
  [BlockId.STONE]: uniform(130, 130, 134),
  [BlockId.SAND]: uniform(219, 196, 120),
  [BlockId.WATER]: uniform(59, 111, 209),
  [BlockId.WOOD]: uniform(95, 66, 40),
  [BlockId.LEAVES]: uniform(58, 117, 45),
  [BlockId.BEDROCK]: uniform(40, 40, 44),
  [BlockId.SNOW]: uniform(235, 240, 245),
};
