import { mulberry32 } from "../world/rng";

/** A small tileable noise image the shaders share, computed once at
 * startup — one texture fetch replaces a stack of procedural-noise math
 * per pixel, which is what keeps clouds, cloud shadows and water ripples
 * cheap enough for a phone GPU.
 *
 *   R: soft fractal noise (cloud cover, cloud shadows)
 *   G: a second, independent field (grass tint patches, foam)
 *   B, A: the x/z slope of a ripple height field (water normals)
 *
 * Pure (no canvas, no WebGL) so it can be tested and built in a worker. */

export const NOISE_SIZE = 256;

/** Periodic value noise: lattice values wrap at `period`, so the field
 * tiles seamlessly. */
function makeLattice(seed: number, period: number): Float32Array {
  const rng = mulberry32(seed);
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  return lattice;
}

function sampleLattice(lattice: Float32Array, period: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const xa = ((x0 % period) + period) % period;
  const ya = ((y0 % period) + period) % period;
  const xb = (xa + 1) % period;
  const yb = (ya + 1) % period;
  const v00 = lattice[ya * period + xa] ?? 0;
  const v10 = lattice[ya * period + xb] ?? 0;
  const v01 = lattice[yb * period + xa] ?? 0;
  const v11 = lattice[yb * period + xb] ?? 0;
  return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v00 - v10 - v01 + v11) * sx * sy;
}

/** Tileable fractal noise over the unit square, normalized to ~[0, 1]. */
export function tileableFbm(
  seed: number,
  basePeriod: number,
  octaves: number,
): (u: number, v: number) => number {
  const layers: { lattice: Float32Array; period: number; amplitude: number }[] = [];
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const period = basePeriod << o;
    layers.push({ lattice: makeLattice(seed + o * 7919, period), period, amplitude });
    total += amplitude;
    amplitude *= 0.5;
  }
  return (u, v) => {
    let sum = 0;
    for (const layer of layers) {
      sum +=
        sampleLattice(layer.lattice, layer.period, u * layer.period, v * layer.period) *
        layer.amplitude;
    }
    return sum / total;
  };
}

/** RGBA8 pixels, NOISE_SIZE x NOISE_SIZE. */
export function buildNoisePixels(seed: number): Uint8Array {
  const size = NOISE_SIZE;
  const clouds = tileableFbm(seed ^ 0xc10d, 4, 5);
  const patches = tileableFbm(seed ^ 0x9a7c, 6, 4);
  const ripples = tileableFbm(seed ^ 0x51ff, 8, 4);

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      height[y * size + x] = ripples(x / size, y / size);
    }
  }

  // Stretch contrast so thresholds in the shaders have room to work.
  const stretch = (v: number): number => Math.max(0, Math.min(1, (v - 0.5) * 1.9 + 0.5));

  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const left = height[y * size + ((x + size - 1) % size)] ?? 0;
      const right = height[y * size + ((x + 1) % size)] ?? 0;
      const up = height[((y + size - 1) % size) * size + x] ?? 0;
      const down = height[((y + 1) % size) * size + x] ?? 0;
      const slopeX = (right - left) * 9;
      const slopeZ = (down - up) * 9;
      pixels[i * 4] = Math.round(stretch(clouds(x / size, y / size)) * 255);
      pixels[i * 4 + 1] = Math.round(stretch(patches(x / size, y / size)) * 255);
      pixels[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, 0.5 + slopeX)) * 255);
      pixels[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, 0.5 + slopeZ)) * 255);
    }
  }
  return pixels;
}
