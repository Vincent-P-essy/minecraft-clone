import { describe, expect, it } from "vitest";
import { findPleasantSpawn } from "./spawn";
import { treeCandidatesNear } from "./features";
import { createCaveSampler, createColumnSampler, SEA_LEVEL, treeSpeciesAt } from "./terrain";

describe("findPleasantSpawn", () => {
  it("is deterministic per seed", () => {
    expect(findPleasantSpawn(2026)).toEqual(findPleasantSpawn(2026));
  });

  it("lands on a grassy, gently-elevated, cave-free column for many seeds", () => {
    for (const seed of [1, 2, 42, 2026, 987654]) {
      const spawn = findPleasantSpawn(seed);
      const profile = createColumnSampler(seed)(Math.floor(spawn.x), Math.floor(spawn.z));
      const isCave = createCaveSampler(seed);

      expect(profile.isDesert).toBe(false);
      expect(profile.isSnowy).toBe(false);
      expect(profile.terrainHeight).toBeGreaterThan(SEA_LEVEL + 1);
      expect(profile.terrainHeight).toBeLessThanOrEqual(SEA_LEVEL + 12);
      expect(isCave(Math.floor(spawn.x), profile.terrainHeight, Math.floor(spawn.z))).toBe(false);
    }
  });

  it("stands on level ground: the eight columns around the spawn are the same height", () => {
    for (const seed of [1, 2, 42, 2026, 987654]) {
      const spawn = findPleasantSpawn(seed);
      const sample = createColumnSampler(seed);
      const x = Math.floor(spawn.x);
      const z = Math.floor(spawn.z);
      const height = sample(x, z).terrainHeight;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          expect(sample(x + dx, z + dz).terrainHeight).toBe(height);
        }
      }
    }
  });

  it("leaves the first few steps clear of tree trunks", () => {
    for (const seed of [1, 2, 42, 505, 2026, 987654]) {
      const spawn = findPleasantSpawn(seed);
      const sample = createColumnSampler(seed);
      const x = Math.floor(spawn.x);
      const z = Math.floor(spawn.z);
      for (const tree of treeCandidatesNear(seed, x - 2, x + 2, z - 2, z + 2)) {
        const near = Math.abs(tree.x - x) <= 2 && Math.abs(tree.z - z) <= 2;
        if (near) expect(treeSpeciesAt(sample(tree.x, tree.z), tree)).toBeNull();
      }
    }
  });

  it("centers the spawn inside its block so the player isn't on an edge", () => {
    const spawn = findPleasantSpawn(2026);
    expect(spawn.x - Math.floor(spawn.x)).toBeCloseTo(0.5);
    expect(spawn.z - Math.floor(spawn.z)).toBeCloseTo(0.5);
  });
});
