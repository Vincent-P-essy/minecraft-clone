import { describe, expect, it } from "vitest";
import { findPleasantSpawn } from "./spawn";
import { createCaveSampler, createColumnSampler, SEA_LEVEL } from "./terrain";

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

  it("centers the spawn inside its block so the player isn't on an edge", () => {
    const spawn = findPleasantSpawn(2026);
    expect(spawn.x - Math.floor(spawn.x)).toBeCloseTo(0.5);
    expect(spawn.z - Math.floor(spawn.z)).toBeCloseTo(0.5);
  });
});
