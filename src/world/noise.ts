import { createNoise2D } from "simplex-noise";
import { mulberry32 } from "./rng";

export interface FbmOptions {
  /** Number of noise layers summed together. More = rougher detail. */
  readonly octaves: number;
  /** Amplitude multiplier per octave. Lower = smoother dominant shape. */
  readonly persistence: number;
  /** Input coordinates are multiplied by this before the first octave. */
  readonly scale: number;
}

export const DEFAULT_FBM: FbmOptions = { octaves: 4, persistence: 0.5, scale: 0.01 };

/** A seeded 2D fractal (fBm) noise field, normalized to [-1, 1]. */
export function createFbmNoise2D(seed: number, options: FbmOptions = DEFAULT_FBM) {
  const noise2D = createNoise2D(mulberry32(seed));
  const { octaves, persistence, scale } = options;

  return (x: number, z: number): number => {
    let amplitude = 1;
    let frequency = scale;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise2D(x * frequency, z * frequency) * amplitude;
      max += amplitude;
      amplitude *= persistence;
      frequency *= 2;
    }
    return max === 0 ? 0 : sum / max;
  };
}
