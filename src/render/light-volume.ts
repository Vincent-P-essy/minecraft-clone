import { BlockId, LIGHT_EMISSION, LIGHT_OPACITY } from "../world/blocks";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "../world/coords";

/** The mesher's working volume: the chunk being meshed plus a full chunk of
 * padding on every side, with voxel light (sky + block) solved over it.
 *
 * Light travels at most 15 cells, so a 16-cell pad makes the light inside
 * the chunk (and one cell beyond, which smooth lighting samples) *exact*
 * with no chunk-to-chunk light state to keep in sync: any chunk can be
 * lit from scratch from its 3x3 neighborhood and will agree with its
 * neighbors along the border. That trades a little recomputation for
 * never having a light seam or an incremental-update bug. */

export const PAD = CHUNK_SIZE;
/** Width (and depth) of the volume in cells. */
export const VW = CHUNK_SIZE + PAD * 2;
/** Rows: one sentinel floor row below y=0, the world, and two rows above. */
export const VH = CHUNK_HEIGHT + 3;
export const STRIDE_X = 1;
export const STRIDE_Z = VW;
export const STRIDE_Y = VW * VW;
const CELLS = VW * VW * VH;

/** Index of chunk-local (0, 0, 0) inside the volume. */
export const ORIGIN = STRIDE_Y + PAD * STRIDE_Z + PAD;

export interface BlockSource {
  getBlock(worldX: number, worldY: number, worldZ: number): BlockId;
  /** Fast path: the raw block buffer of a loaded chunk. */
  getChunkBuffer?(cx: number, cz: number): Uint8Array | undefined;
}

export interface LightVolume {
  readonly blocks: Uint8Array;
  /** Sky light 0..15 per cell. */
  readonly sky: Uint8Array;
  /** Block (emitter) light 0..15 per cell. */
  readonly blk: Uint8Array;
  /** Highest volume row holding any block (row = world y + 1). */
  top: number;
}

const QUEUE_BITS = 20;
const QUEUE_MASK = (1 << QUEUE_BITS) - 1;

// One set of scratch buffers per thread — the mesher is never re-entrant.
const blocks = new Uint8Array(CELLS);
const sky = new Uint8Array(CELLS);
const blk = new Uint8Array(CELLS);
const opac = new Uint8Array(CELLS);
const litFloor = new Uint8Array(VW * VW);
const queue = new Int32Array(1 << QUEUE_BITS);
const volume: LightVolume = { blocks, sky, blk, top: 0 };

const NEIGHBORS = [STRIDE_X, -STRIDE_X, STRIDE_Z, -STRIDE_Z, STRIDE_Y, -STRIDE_Y] as const;

function copyChunk(buffer: Uint8Array, dx: number, dz: number): void {
  const baseX = PAD + dx * CHUNK_SIZE;
  const baseZ = PAD + dz * CHUNK_SIZE;
  for (let y = 0; y < CHUNK_HEIGHT; y++) {
    const srcRow = y * CHUNK_SIZE * CHUNK_SIZE;
    const dstRow = (y + 1) * STRIDE_Y + baseZ * STRIDE_Z + baseX;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const src = srcRow + z * CHUNK_SIZE;
      blocks.set(buffer.subarray(src, src + CHUNK_SIZE), dstRow + z * STRIDE_Z);
    }
  }
}

function copyByLookup(source: BlockSource, cx: number, cz: number, dx: number, dz: number): void {
  const worldX = (cx + dx) * CHUNK_SIZE;
  const worldZ = (cz + dz) * CHUNK_SIZE;
  const baseX = PAD + dx * CHUNK_SIZE;
  const baseZ = PAD + dz * CHUNK_SIZE;
  for (let y = 0; y < CHUNK_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const dst = (y + 1) * STRIDE_Y + (baseZ + z) * STRIDE_Z + baseX;
      for (let x = 0; x < CHUNK_SIZE; x++) {
        blocks[dst + x] = source.getBlock(worldX + x, y, worldZ + z);
      }
    }
  }
}

function flood(light: Uint8Array, head: number, tail: number): void {
  while (head !== tail) {
    const i = queue[head] ?? 0;
    head = (head + 1) & QUEUE_MASK;
    const level = light[i] ?? 0;
    if (level <= 1) continue;
    for (const offset of NEIGHBORS) {
      const j = i + offset;
      const o = opac[j] ?? 15;
      if (o >= 15) continue;
      const next = level - 1 - o;
      if (next > (light[j] ?? 0)) {
        light[j] = next;
        if (next > 1) {
          queue[tail] = j;
          tail = (tail + 1) & QUEUE_MASK;
        }
      }
    }
  }
}

/** Fills the shared volume with the 3x3 chunk neighborhood around
 * (cx, cz) and solves sky and block light over it. The returned object is
 * reused by the next call. */
export function buildLightVolume(
  center: Uint8Array,
  cx: number,
  cz: number,
  source: BlockSource,
): LightVolume {
  blocks.fill(0);
  blocks.fill(BlockId.BEDROCK, 0, STRIDE_Y); // sentinel floor under the world

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) {
        copyChunk(center, 0, 0);
        continue;
      }
      const buffer = source.getChunkBuffer?.(cx + dx, cz + dz);
      if (buffer) copyChunk(buffer, dx, dz);
      else if (!source.getChunkBuffer) copyByLookup(source, cx, cz, dx, dz);
    }
  }

  // Highest occupied row, so nothing above it is ever touched.
  let top = VH - 3;
  search: for (; top > 0; top--) {
    const row = top * STRIDE_Y;
    for (let i = row; i < row + STRIDE_Y; i++) {
      if (blocks[i] !== 0) break search;
    }
  }
  volume.top = top;
  const ceiling = top + 2; // rows top+1 (open air) and top+2 (barrier)

  // The row above everything is open sky; the row above that is a barrier
  // so the flood fill never walks into stale data.
  sky.fill(15, (top + 1) * STRIDE_Y, (ceiling + 1) * STRIDE_Y);
  blk.fill(0, (top + 1) * STRIDE_Y, (ceiling + 1) * STRIDE_Y);
  opac.fill(0, (top + 1) * STRIDE_Y, ceiling * STRIDE_Y);
  opac.fill(15, ceiling * STRIDE_Y, (ceiling + 1) * STRIDE_Y);
  opac.fill(15, 0, STRIDE_Y);
  sky.fill(0, 0, STRIDE_Y);
  blk.fill(0, 0, STRIDE_Y);

  // Pass 1 — straight down each column: sunlight falls unattenuated through
  // clear cells, thins through leaves and water, and stops at anything
  // opaque. Emitters seed the block-light queue as they're met.
  let head = 0;
  let tail = 0;
  for (let z = 0; z < VW; z++) {
    for (let x = 0; x < VW; x++) {
      const column = z * STRIDE_Z + x;
      const border = x === 0 || z === 0 || x === VW - 1 || z === VW - 1;
      let level = 15;
      let floor = top + 1;
      for (let row = top; row >= 1; row--) {
        const i = row * STRIDE_Y + column;
        const id = blocks[i] ?? 0;
        const o = LIGHT_OPACITY[id] ?? 15;
        if (o >= 15) level = 0;
        else if (o > 0) level = level > o ? level - o : 0;
        if (level === 15) floor = row;
        sky[i] = level;
        // Border columns are walls for the flood fill, which also keeps
        // index arithmetic from wrapping around the volume's edges.
        opac[i] = border ? 15 : o;
        const emission = LIGHT_EMISSION[id] ?? 0;
        blk[i] = emission;
        if (emission > 1 && !border) {
          queue[tail] = i;
          tail = (tail + 1) & QUEUE_MASK;
        }
      }
      litFloor[column] = floor;
    }
  }
  flood(blk, head, tail);

  // Pass 2 — sideways: a fully lit cell only needs to spread if a neighbor
  // column is still dark at that height, i.e. between this column's lit
  // floor and the highest lit floor around it. Dimmer cells (under leaves,
  // in water) always spread.
  head = 0;
  tail = 0;
  for (let z = 1; z < VW - 1; z++) {
    for (let x = 1; x < VW - 1; x++) {
      const column = z * STRIDE_Z + x;
      const floor = litFloor[column] ?? 1;
      let reach = litFloor[column - 1] ?? 1;
      const b = litFloor[column + 1] ?? 1;
      const c = litFloor[column - STRIDE_Z] ?? 1;
      const d = litFloor[column + STRIDE_Z] ?? 1;
      if (b > reach) reach = b;
      if (c > reach) reach = c;
      if (d > reach) reach = d;
      for (let row = floor; row < reach; row++) {
        queue[tail] = row * STRIDE_Y + column;
        tail = (tail + 1) & QUEUE_MASK;
      }
      for (let row = floor - 1; row >= 1; row--) {
        const i = row * STRIDE_Y + column;
        if ((sky[i] ?? 0) <= 1) break;
        queue[tail] = i;
        tail = (tail + 1) & QUEUE_MASK;
      }
    }
  }
  flood(sky, head, tail);

  return volume;
}
