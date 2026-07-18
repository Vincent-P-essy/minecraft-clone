/**
 * mulberry32: a tiny, fast, seedable PRNG. Not cryptographic — it exists so
 * terrain generation is reproducible from a single numeric seed, which
 * `Math.random` can never be.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives an independent-looking sub-seed so unrelated noise channels
 * (height, moisture, ...) don't share identical permutation tables. */
export function deriveSeed(seed: number, salt: number): number {
  return (Math.imul(seed ^ salt, 0x9e3779b1) ^ (seed >>> 3)) >>> 0;
}
