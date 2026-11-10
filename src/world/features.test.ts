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
import {
  createCaveSampler,
  createColumnSampler,
  generateChunk,
  surfaceBlock,
  treeSpeciesAt,
  trunkBlockFor,
} from "./terrain";

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

describe("treeBlocks species", () => {
  const tree = { x: 0, z: 0, trunkHeight: 5, roll: 0.2, variant: 0.4 };

  it("every species stays within CANOPY_RADIUS and never puts a leaf in its own trunk", () => {
    for (const species of ["oak", "great-oak", "pale", "pine", "cactus"] as const) {
      const blocks = treeBlocks(tree, 50, species);
      const trunk = new Set(
        blocks.filter((b) => b.kind === "trunk").map((b) => `${b.x},${b.y},${b.z}`),
      );
      expect(trunk.size).toBeGreaterThan(0);
      for (const b of blocks) {
        expect(Math.abs(b.x)).toBeLessThanOrEqual(CANOPY_RADIUS);
        expect(Math.abs(b.z)).toBeLessThanOrEqual(CANOPY_RADIUS);
        expect(b.y).toBeGreaterThan(50);
        if (b.kind === "leaves") expect(trunk.has(`${b.x},${b.y},${b.z}`)).toBe(false);
      }
    }
  });

  it("a cactus is a bare column", () => {
    const blocks = treeBlocks(tree, 50, "cactus");
    expect(blocks.every((b) => b.kind === "trunk" && b.x === 0 && b.z === 0)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.length).toBeLessThanOrEqual(4);
  });

  it("a pine is taller than an oak grown from the same candidate", () => {
    const top = (species: "oak" | "pine"): number =>
      Math.max(...treeBlocks(tree, 50, species).map((b) => b.y));
    expect(top("pine")).toBeGreaterThan(top("oak"));
  });

  it("is deterministic", () => {
    expect(treeBlocks(tree, 50, "great-oak")).toEqual(treeBlocks(tree, 50, "great-oak"));
  });
});

describe("trees stamped into generated chunks", () => {
  const seed = 2026;
  const sample = createColumnSampler(seed);
  const isCave = createCaveSampler(seed);

  /** Mirrors the generator's own eligibility rules. */
  function speciesIfGrown(tree: NonNullable<ReturnType<typeof treeCandidateInCell>>) {
    const profile = sample(tree.x, tree.z);
    const species = treeSpeciesAt(profile, tree);
    if (!species) return null;
    if (isCave(tree.x, profile.terrainHeight, tree.z)) return null;
    const ground = surfaceBlock(profile);
    if (species === "cactus" ? ground !== BlockId.SAND : ground === BlockId.STONE) return null;
    return { species, profile };
  }

  it("an eligible tree's trunk appears in the generated chunk that contains it", () => {
    let checked = 0;
    for (let cx = -60; cx <= 60 && checked < 12; cx++) {
      for (let cz = -60; cz <= 60 && checked < 12; cz += 7) {
        const tree = treeCandidateInCell(seed, cx, cz);
        if (!tree) continue;
        const grown = speciesIfGrown(tree);
        if (!grown) continue;
        const chunk = generateChunk(worldToChunk(tree.x), worldToChunk(tree.z), seed);
        expect(
          chunk.getBlock(
            worldToLocal(tree.x),
            grown.profile.terrainHeight + 1,
            worldToLocal(tree.z),
          ),
        ).toBe(trunkBlockFor(grown.species));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("regenerating a chunk gives identical blocks", () => {
    expect(generateChunk(0, 0, seed).buffer).toEqual(generateChunk(0, 0, seed).buffer);
  });

  it("a canopy that straddles a chunk border is carried by the neighboring chunk", () => {
    // Find an oak whose trunk hugs a chunk border, then check the neighbor
    // chunk holds the overhanging leaves: both chunks derive the canopy
    // from the same pure functions, with no chunk-to-chunk communication.
    let checked = false;
    outer: for (let cx = -80; cx <= 80; cx++) {
      for (let cz = -80; cz <= 80; cz++) {
        const tree = treeCandidateInCell(seed, cx, cz);
        if (!tree) continue;
        const grown = speciesIfGrown(tree);
        if (grown?.species !== "oak") continue;
        const lx = worldToLocal(tree.x);
        if (lx !== 0 && lx !== CHUNK_SIZE - 1) continue;

        const neighborCx = worldToChunk(tree.x) + (lx === 0 ? -1 : 1);
        const neighborChunk = generateChunk(neighborCx, worldToChunk(tree.z), seed);
        const canopyY = grown.profile.terrainHeight + tree.trunkHeight - 1;
        const overhangX = lx === 0 ? tree.x - 1 : tree.x + 1;
        const block = neighborChunk.getBlock(
          worldToLocal(overhangX),
          canopyY,
          worldToLocal(tree.z),
        );
        // The overhanging cell carries the canopy unless something solid
        // legitimately occupies it (terrain rising into it, another trunk).
        expect(block).not.toBe(BlockId.AIR);
        expect(block).not.toBe(BlockId.TALL_GRASS);
        checked = true;
        break outer;
      }
    }
    expect(checked).toBe(true);
  });
});
