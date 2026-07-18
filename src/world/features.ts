import type { ColumnProfile } from "./terrain";
import { mulberry32 } from "./rng";

/** Tree placement is a pure function of (seed, world position) — a chunk
 * never "owns" a tree. Each 8x8 world-grid cell rolls one candidate tree at
 * a jittered position, so any chunk can recompute every tree overlapping it
 * (including trees rooted in a neighboring chunk whose canopy leans across
 * the border) and always agree with its neighbors. That property is what
 * makes canopies seamless across chunk boundaries without any chunk-to-chunk
 * communication. */

export const TREE_CELL_SIZE = 8;
/** Fraction of cells that contain a tree candidate (before terrain eligibility). */
const TREE_CELL_CHANCE = 0.42;
const TREE_SALT = 0x7ee5;

export const CANOPY_RADIUS = 2;
const MIN_TRUNK_HEIGHT = 4;
const MAX_TRUNK_HEIGHT = 6;

export interface TreeCandidate {
  /** World position of the trunk column. */
  readonly x: number;
  readonly z: number;
  readonly trunkHeight: number;
}

function cellHash(seed: number, cellX: number, cellZ: number): number {
  let h = (seed ^ TREE_SALT) >>> 0;
  h = Math.imul(h ^ cellX, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h ^ cellZ, 2246822519) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The at-most-one tree candidate rolled by an 8x8 placement cell. */
export function treeCandidateInCell(
  seed: number,
  cellX: number,
  cellZ: number,
): TreeCandidate | null {
  const rng = mulberry32(cellHash(seed, cellX, cellZ));
  if (rng() > TREE_CELL_CHANCE) return null;
  const x = cellX * TREE_CELL_SIZE + Math.floor(rng() * TREE_CELL_SIZE);
  const z = cellZ * TREE_CELL_SIZE + Math.floor(rng() * TREE_CELL_SIZE);
  const trunkHeight =
    MIN_TRUNK_HEIGHT + Math.floor(rng() * (MAX_TRUNK_HEIGHT - MIN_TRUNK_HEIGHT + 1));
  return { x, z, trunkHeight };
}

/** Whether terrain at the candidate's column can actually host a tree. */
export function treeAllowedOn(profile: ColumnProfile, seaLevel: number): boolean {
  return !profile.isDesert && !profile.isSnowy && profile.terrainHeight > seaLevel + 1;
}

/** All tree candidates whose trunk could place blocks inside the world-space
 * rectangle [minX-CANOPY_RADIUS, maxX+CANOPY_RADIUS] x [same for Z]. */
export function treeCandidatesNear(
  seed: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): TreeCandidate[] {
  const cellMinX = Math.floor((minX - CANOPY_RADIUS) / TREE_CELL_SIZE);
  const cellMaxX = Math.floor((maxX + CANOPY_RADIUS) / TREE_CELL_SIZE);
  const cellMinZ = Math.floor((minZ - CANOPY_RADIUS) / TREE_CELL_SIZE);
  const cellMaxZ = Math.floor((maxZ + CANOPY_RADIUS) / TREE_CELL_SIZE);

  const trees: TreeCandidate[] = [];
  for (let cx = cellMinX; cx <= cellMaxX; cx++) {
    for (let cz = cellMinZ; cz <= cellMaxZ; cz++) {
      const tree = treeCandidateInCell(seed, cx, cz);
      if (!tree) continue;
      if (
        tree.x >= minX - CANOPY_RADIUS &&
        tree.x <= maxX + CANOPY_RADIUS &&
        tree.z >= minZ - CANOPY_RADIUS &&
        tree.z <= maxZ + CANOPY_RADIUS
      ) {
        trees.push(tree);
      }
    }
  }
  return trees;
}

export interface TreeBlock {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly kind: "trunk" | "leaves";
}

/** Every block of one tree, in world coordinates, given the surface height
 * of the trunk's column. Trunk cells win over leaf cells by construction
 * (leaves skip the trunk column below the canopy top). */
export function treeBlocks(tree: TreeCandidate, surfaceY: number): TreeBlock[] {
  const blocks: TreeBlock[] = [];
  const trunkBase = surfaceY + 1;
  const trunkTop = surfaceY + tree.trunkHeight;

  for (let y = trunkBase; y <= trunkTop; y++) {
    blocks.push({ x: tree.x, y, z: tree.z, kind: "trunk" });
  }

  for (const layer of [trunkTop - 1, trunkTop]) {
    for (let dx = -CANOPY_RADIUS; dx <= CANOPY_RADIUS; dx++) {
      for (let dz = -CANOPY_RADIUS; dz <= CANOPY_RADIUS; dz++) {
        if (dx === 0 && dz === 0) continue; // trunk occupies this cell
        blocks.push({ x: tree.x + dx, y: layer, z: tree.z + dz, kind: "leaves" });
      }
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      blocks.push({ x: tree.x + dx, y: trunkTop + 1, z: tree.z + dz, kind: "leaves" });
    }
  }
  blocks.push({ x: tree.x, y: trunkTop + 1, z: tree.z, kind: "leaves" });
  blocks.push({ x: tree.x, y: trunkTop + 2, z: tree.z, kind: "leaves" });

  return blocks;
}
