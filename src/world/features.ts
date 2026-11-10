import { mulberry32 } from "./rng";

/** Tree placement is a pure function of (seed, world position) — a chunk
 * never "owns" a tree. Each placement cell rolls one candidate tree at a
 * jittered position, so any chunk can recompute every tree overlapping it
 * (including trees rooted in a neighboring chunk whose canopy leans across
 * the border) and always agree with its neighbors. That property is what
 * makes canopies seamless across chunk boundaries without any chunk-to-chunk
 * communication. */

export const TREE_CELL_SIZE = 5;
/** Fraction of cells that roll a candidate at all; each biome then thins
 * the candidates further with its own density (see terrain.ts). */
const TREE_CELL_CHANCE = 0.85;
const TREE_SALT = 0x7ee5;

/** The widest any species' canopy reaches from its trunk column. */
export const CANOPY_RADIUS = 3;
const MIN_TRUNK_HEIGHT = 4;
const MAX_TRUNK_HEIGHT = 6;

export type TreeSpecies = "oak" | "great-oak" | "pale" | "pine" | "cactus";

export interface TreeCandidate {
  /** World position of the trunk column. */
  readonly x: number;
  readonly z: number;
  readonly trunkHeight: number;
  /** Uniform in [0, 1): compared against the biome's tree density. */
  readonly roll?: number;
  /** Uniform in [0, 1): picks shape variations within a species. */
  readonly variant?: number;
}

function cellHash(seed: number, cellX: number, cellZ: number): number {
  let h = (seed ^ TREE_SALT) >>> 0;
  h = Math.imul(h ^ cellX, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h ^ cellZ, 2246822519) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The at-most-one tree candidate rolled by a placement cell. */
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
  const roll = rng();
  const variant = rng();
  return { x, z, trunkHeight, roll, variant };
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

/** A deterministic 0..1 value per (tree, cell) — used to nibble canopy
 * corners so no two trees are the same silhouette. */
function nibble(tree: TreeCandidate, dx: number, dy: number, dz: number): number {
  let h = Math.imul((tree.x * 73856093) ^ (tree.z * 19349663), 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (dx * 31 + dy * 17 + dz * 13 + 977), 2246822519) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function pushDisc(
  blocks: TreeBlock[],
  tree: TreeCandidate,
  y: number,
  radius: number,
  /** Chance each outermost-corner cell is left out. */
  trim: number,
  skipCenter: boolean,
): void {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (skipCenter && dx === 0 && dz === 0) continue;
      const corner = Math.abs(dx) === radius && Math.abs(dz) === radius;
      if (corner && radius > 0 && nibble(tree, dx, y, dz) < trim) continue;
      blocks.push({ x: tree.x + dx, y, z: tree.z + dz, kind: "leaves" });
    }
  }
}

/** Every block of one tree, in world coordinates, given the surface height
 * of the trunk's column. Trunk cells win over leaf cells by construction
 * (leaves skip the trunk column below the canopy top). */
export function treeBlocks(
  tree: TreeCandidate,
  surfaceY: number,
  species: TreeSpecies = "oak",
): TreeBlock[] {
  const blocks: TreeBlock[] = [];
  const trunkBase = surfaceY + 1;

  if (species === "cactus") {
    const height = 2 + Math.floor((tree.variant ?? 0) * 3);
    for (let y = trunkBase; y < trunkBase + height; y++) {
      blocks.push({ x: tree.x, y, z: tree.z, kind: "trunk" });
    }
    return blocks;
  }

  if (species === "pine") {
    const trunkTop = surfaceY + tree.trunkHeight + 3;
    for (let y = trunkBase; y <= trunkTop; y++) {
      blocks.push({ x: tree.x, y, z: tree.z, kind: "trunk" });
    }
    // A cone of alternating skirts, widest near the ground.
    for (let y = trunkTop; y >= trunkBase + 2; y--) {
      const fromTop = trunkTop - y;
      const radius =
        fromTop > 0 && fromTop % 2 === 0 ? Math.min(2, 1 + Math.floor(fromTop / 3)) : 1;
      pushDisc(blocks, tree, y, radius, radius === 2 ? 1 : 0.35, true);
    }
    blocks.push({ x: tree.x, y: trunkTop + 1, z: tree.z, kind: "leaves" });
    blocks.push({ x: tree.x, y: trunkTop + 2, z: tree.z, kind: "leaves" });
    return blocks;
  }

  if (species === "pale") {
    const trunkTop = surfaceY + tree.trunkHeight + 1;
    for (let y = trunkBase; y <= trunkTop; y++) {
      blocks.push({ x: tree.x, y, z: tree.z, kind: "trunk" });
    }
    pushDisc(blocks, tree, trunkTop - 2, 2, 0.8, true);
    pushDisc(blocks, tree, trunkTop - 1, 2, 0.5, true);
    pushDisc(blocks, tree, trunkTop, 1, 0.2, true);
    pushDisc(blocks, tree, trunkTop + 1, 1, 0.7, false);
    return blocks;
  }

  if (species === "great-oak") {
    const trunkTop = surfaceY + tree.trunkHeight + 3;
    for (let y = trunkBase; y <= trunkTop; y++) {
      blocks.push({ x: tree.x, y, z: tree.z, kind: "trunk" });
    }
    pushDisc(blocks, tree, trunkTop - 2, 2, 0.6, true);
    pushDisc(blocks, tree, trunkTop - 1, 3, 1, true);
    pushDisc(blocks, tree, trunkTop, 3, 1, true);
    pushDisc(blocks, tree, trunkTop + 1, 2, 0.5, false);
    pushDisc(blocks, tree, trunkTop + 2, 1, 0.5, false);
    return blocks;
  }

  // Oak: two wide layers under a small crown.
  const trunkTop = surfaceY + tree.trunkHeight;
  for (let y = trunkBase; y <= trunkTop; y++) {
    blocks.push({ x: tree.x, y, z: tree.z, kind: "trunk" });
  }
  const trim = tree.variant === undefined ? 0 : 0.55;
  pushDisc(blocks, tree, trunkTop - 1, 2, trim, true);
  pushDisc(blocks, tree, trunkTop, 2, trim, true);
  pushDisc(blocks, tree, trunkTop + 1, 1, trim * 0.5, false);
  blocks.push({ x: tree.x, y: trunkTop + 2, z: tree.z, kind: "leaves" });
  return blocks;
}
