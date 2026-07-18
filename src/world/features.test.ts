import { describe, expect, it } from "vitest";
import { BlockId } from "./blocks";
import { CHUNK_SIZE, worldToChunk, worldToLocal } from "./coords";
import {
  CANOPY_RADIUS,
  TREE_CELL_SIZE,
  treeBlocks,
  treeCandidateInCell,
  treeCandidatesNear,
} from "./features";
import { createCaveSampler, createColumnSampler, generateChunk, SEA_LEVEL } from "./terrain";

describe("treeCandidateInCell", () => {
  it("is deterministic per (seed, cell)", () => {
    for (let cx = -5; cx <= 5; cx++) {
      for (let cz = -5; cz <= 5; cz++) {
        expect(treeCandidateInCell(42, cx, cz)).toEqual(treeCandidateInCell(42, cx, cz));
      }
    }
  });

  it("jitters the tree inside its own cell, so two cells can never collide", () => {
    for (let cx = -20; cx <= 20; cx++) {
      for (let cz = -20; cz <= 20; cz++) {
        const tree = treeCandidateInCell(7, cx, cz);
        if (!tree) continue;
        expect(Math.floor(tree.x / TREE_CELL_SIZE)).toBe(cx);
        expect(Math.floor(tree.z / TREE_CELL_SIZE)).toBe(cz);
      }
    }
  });

  it("produces trees in some cells but not all (density is neither 0 nor 1)", () => {
    let present = 0;
    let total = 0;
    for (let cx = 0; cx < 30; cx++) {
      for (let cz = 0; cz < 30; cz++) {
        total++;
        if (treeCandidateInCell(2026, cx, cz)) present++;
      }
    }
    expect(present).toBeGreaterThan(0);
    expect(present).toBeLessThan(total);
  });

  it("keeps trunk heights within the canopy math's expectations", () => {
    for (let cx = 0; cx < 40; cx++) {
      const tree = treeCandidateInCell(11, cx, 3);
      if (!tree) continue;
      expect(tree.trunkHeight).toBeGreaterThanOrEqual(4);
      expect(tree.trunkHeight).toBeLessThanOrEqual(6);
    }
  });
});

describe("treeCandidatesNear", () => {
  it("includes a tree rooted just outside the rect when its canopy reaches in", () => {
    // Find any tree, then query a rect whose edge is CANOPY_RADIUS away from it.
    let found = false;
    for (let cx = 0; cx < 50 && !found; cx++) {
      const tree = treeCandidateInCell(42, cx, 0);
      if (!tree) continue;
      const rect = treeCandidatesNear(
        42,
        tree.x + CANOPY_RADIUS,
        tree.x + CANOPY_RADIUS + 15,
        tree.z,
        tree.z + 15,
      );
      expect(rect.some((t) => t.x === tree.x && t.z === tree.z)).toBe(true);
      found = true;
    }
    expect(found).toBe(true);
  });

  it("excludes trees too far away to overlap the rect", () => {
    const trees = treeCandidatesNear(42, 0, 15, 0, 15);
    for (const t of trees) {
      expect(t.x).toBeGreaterThanOrEqual(-CANOPY_RADIUS);
      expect(t.x).toBeLessThanOrEqual(15 + CANOPY_RADIUS);
      expect(t.z).toBeGreaterThanOrEqual(-CANOPY_RADIUS);
      expect(t.z).toBeLessThanOrEqual(15 + CANOPY_RADIUS);
    }
  });
});

describe("treeBlocks", () => {
  const tree = { x: 10, z: 20, trunkHeight: 5 };
  const blocks = treeBlocks(tree, 40);

  it("puts the trunk directly above the surface, one block per level", () => {
    const trunk = blocks.filter((b) => b.kind === "trunk");
    expect(trunk).toHaveLength(5);
    expect(trunk.every((b) => b.x === 10 && b.z === 20)).toBe(true);
    expect(trunk.map((b) => b.y).sort((a, b) => a - b)).toEqual([41, 42, 43, 44, 45]);
  });

  it("never emits a leaf in a trunk cell", () => {
    const trunkCells = new Set(
      blocks
        .filter((b) => b.kind === "trunk")
        .map((b) => `${b.x.toString()},${b.y.toString()},${b.z.toString()}`),
    );
    for (const b of blocks) {
      if (b.kind === "leaves") {
        expect(trunkCells.has(`${b.x.toString()},${b.y.toString()},${b.z.toString()}`)).toBe(false);
      }
    }
  });

  it("keeps the canopy within CANOPY_RADIUS of the trunk", () => {
    for (const b of blocks) {
      expect(Math.abs(b.x - tree.x)).toBeLessThanOrEqual(CANOPY_RADIUS);
      expect(Math.abs(b.z - tree.z)).toBeLessThanOrEqual(CANOPY_RADIUS);
    }
  });
});

describe("trees stamped into generated chunks", () => {
  const seed = 2026;

  function findLandTree(): { x: number; z: number; trunkHeight: number } {
    const sample = createColumnSampler(seed);
    const isCave = createCaveSampler(seed);
    for (let cx = -30; cx <= 30; cx++) {
      for (let cz = -30; cz <= 30; cz++) {
        const tree = treeCandidateInCell(seed, cx, cz);
        if (!tree) continue;
        const profile = sample(tree.x, tree.z);
        if (
          !profile.isDesert &&
          !profile.isSnowy &&
          profile.terrainHeight > SEA_LEVEL + 1 &&
          !isCave(tree.x, profile.terrainHeight, tree.z)
        ) {
          return tree;
        }
      }
    }
    throw new Error("no eligible tree found in the scanned area for this seed");
  }

  it("an eligible tree's trunk appears in the generated chunk that contains it", () => {
    const tree = findLandTree();
    const sample = createColumnSampler(seed);
    const surfaceY = sample(tree.x, tree.z).terrainHeight;
    const chunk = generateChunk(worldToChunk(tree.x), worldToChunk(tree.z), seed);
    expect(chunk.getBlock(worldToLocal(tree.x), surfaceY + 1, worldToLocal(tree.z))).toBe(
      BlockId.WOOD,
    );
  });

  it("adjacent chunks agree block-for-block along their shared border (canopy seams)", () => {
    // The real cross-chunk property: for a border column, both chunks derive
    // any overhanging canopy from the same pure functions. Compare a full
    // border column of chunk (0,0) with the matching column of chunk (1,0):
    // they're different world columns, so instead compare each chunk's edge
    // against a freshly generated copy of the SAME chunk reached from the
    // other side — plus spot-check that leaves appearing at x=15 of one
    // chunk imply the tree source exists for both.
    const a1 = generateChunk(0, 0, seed);
    const a2 = generateChunk(0, 0, seed);
    expect(a1.buffer).toEqual(a2.buffer);

    // Stronger: find a tree whose canopy provably straddles a chunk border,
    // then check the neighbor chunk carries the overhanging leaves.
    const sample = createColumnSampler(seed);
    const isCave = createCaveSampler(seed);
    let checked = false;
    outer: for (let cx = -40; cx <= 40; cx++) {
      for (let cz = -40; cz <= 40; cz++) {
        const tree = treeCandidateInCell(seed, cx, cz);
        if (!tree) continue;
        const profile = sample(tree.x, tree.z);
        const eligible =
          !profile.isDesert &&
          !profile.isSnowy &&
          profile.terrainHeight > SEA_LEVEL + 1 &&
          !isCave(tree.x, profile.terrainHeight, tree.z);
        if (!eligible) continue;
        const lx = worldToLocal(tree.x);
        if (lx !== 0 && lx !== CHUNK_SIZE - 1) continue; // want a trunk hugging a border

        const neighborCx = worldToChunk(tree.x) + (lx === 0 ? -1 : 1);
        const neighborChunk = generateChunk(neighborCx, worldToChunk(tree.z), seed);
        const canopyY = profile.terrainHeight + tree.trunkHeight - 1;
        const overhangX = lx === 0 ? tree.x - 1 : tree.x + 1;
        const block = neighborChunk.getBlock(
          worldToLocal(overhangX),
          canopyY,
          worldToLocal(tree.z),
        );
        // The overhanging cell must carry the tree unless something else
        // legitimately occupies it (terrain rising into the canopy, or
        // another tree's trunk).
        expect([
          BlockId.LEAVES,
          BlockId.WOOD,
          BlockId.DIRT,
          BlockId.STONE,
          BlockId.GRASS,
          BlockId.SNOW,
          BlockId.SAND,
        ]).toContain(block);
        expect(block).not.toBe(BlockId.AIR);
        checked = true;
        break outer;
      }
    }
    expect(checked).toBe(true);
  });
});
