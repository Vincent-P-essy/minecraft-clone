import { createCaveSampler, createColumnSampler, SEA_LEVEL } from "./terrain";

const MAX_SPAWN_HEIGHT = SEA_LEVEL + 12;
const SEARCH_STEP = 8;
const SEARCH_LIMIT = 640; // world units in each direction — always finds something in practice

export interface SpawnPoint {
  readonly x: number;
  readonly z: number;
}

/** A deterministic, *pleasant* place to start: a grassy column at a gentle
 * height, not a desert, not a windswept snow peak, not the roof of a cave
 * about to swallow the player. Scans outward from the origin in growing
 * rings so the same seed always spawns in the same spot. Falls back to
 * (8, 8) if the seed is somehow all ocean and dunes within the search
 * limit. */
export function findPleasantSpawn(seed: number): SpawnPoint {
  const sample = createColumnSampler(seed);
  const isCave = createCaveSampler(seed);

  for (let radius = 0; radius <= SEARCH_LIMIT; radius += SEARCH_STEP) {
    const candidates: [number, number][] = radius === 0 ? [[0, 0]] : ringCoordinates(radius);
    for (const [x, z] of candidates) {
      const profile = sample(x, z);
      if (profile.isDesert || profile.isSnowy) continue;
      if (profile.terrainHeight <= SEA_LEVEL + 1) continue; // beach or ocean
      if (profile.terrainHeight > MAX_SPAWN_HEIGHT) continue; // steep highlands
      if (isCave(x, profile.terrainHeight, z)) continue; // cave mouth underfoot
      return { x: x + 0.5, z: z + 0.5 };
    }
  }
  return { x: 8, z: 8 };
}

function ringCoordinates(radius: number): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = -radius; i <= radius; i += SEARCH_STEP) {
    coords.push([i, -radius], [i, radius], [-radius, i], [radius, i]);
  }
  return coords;
}
