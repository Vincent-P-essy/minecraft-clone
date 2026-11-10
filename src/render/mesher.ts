import {
  AO_OCCLUDER,
  BLOCKS,
  BlockId,
  isTransparent,
  LIGHT_EMISSION,
  OPAQUE,
} from "../world/blocks";
import type { Chunk } from "../world/chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "../world/coords";
import { type Face, TILE_TABLE } from "./atlas-layout";
import {
  type BlockSource,
  buildLightVolume,
  ORIGIN,
  STRIDE_X,
  STRIDE_Y,
  STRIDE_Z,
} from "./light-volume";

/** Anything that can answer "what block is at this world position", so the
 * mesher can look past a chunk's own edge without knowing what a World is. */
export type NeighborLookup = BlockSource;

/** Geometry for one chunk, as packed vertices: two uint32 words per vertex,
 * four vertices per quad, quads back to back. There is no index buffer —
 * every chunk draws with the same shared 0,1,2 / 0,2,3 pattern, and a quad
 * that needs the other diagonal simply starts one corner later.
 *
 * word A: x:5 | y:8 | z:5 | face:3 | ao:2 | sky:4 | block:4
 * word B: tile:8 | sway:2 | swayOn:1 | emissive:1 | cross:1 | depth:4 | surface:1
 *
 * `sway` names the kind of foliage (leaves rustle in the fragment shader);
 * `swayOn` marks the vertices the wind actually moves — the tips of plants.
 *
 * Eight bytes a vertex instead of forty-eight keeps uploads small and the
 * vertex cache dense; normals and texture coordinates are derived in the
 * shader from the face index and the position itself. */
export interface MeshData {
  /** Cubes, cut-out foliage and plants — drawn in the opaque pass. Quads
   * that can see some sky come first; from `caveStart` on are the quads no
   * skylight reaches at all (cave interiors), which the renderer only
   * draws near the player and never into the shadow map. */
  opaque: Uint32Array;
  /** Index of the first cave quad within `opaque`. */
  caveStart: number;
  /** Water surfaces — drawn blended, after everything else. */
  water: Uint32Array;
  /** Vertical extent of the geometry, for culling bounds. */
  minY: number;
  maxY: number;
}

export const WORDS_PER_VERTEX = 2;
export const WORDS_PER_QUAD = WORDS_PER_VERTEX * 4;

export function quadCount(vertices: Uint32Array): number {
  return vertices.length / WORDS_PER_QUAD;
}

export const SWAY_NONE = 0;
export const SWAY_LEAVES = 1;
export const SWAY_PLANT = 2;

export interface UnpackedVertex {
  x: number;
  y: number;
  z: number;
  face: number;
  ao: number;
  sky: number;
  block: number;
  tile: number;
  sway: number;
  swayOn: boolean;
  emissive: boolean;
  cross: boolean;
  depth: number;
  surface: boolean;
}

/** Decodes one packed vertex — the CPU-side mirror of the vertex shader. */
export function unpackVertex(a: number, b: number): UnpackedVertex {
  return {
    x: a & 31,
    y: (a >>> 5) & 255,
    z: (a >>> 13) & 31,
    face: (a >>> 18) & 7,
    ao: (a >>> 21) & 3,
    sky: (a >>> 23) & 15,
    block: (a >>> 27) & 15,
    tile: b & 255,
    sway: (b >>> 8) & 3,
    swayOn: ((b >>> 10) & 1) === 1,
    emissive: ((b >>> 11) & 1) === 1,
    cross: ((b >>> 12) & 1) === 1,
    depth: (b >>> 13) & 15,
    surface: ((b >>> 17) & 1) === 1,
  };
}

type Axis = 0 | 1 | 2;
type Corner = readonly [number, number, number];

interface FaceSpec {
  readonly face: Face;
  readonly index: number;
  /** The axis the face's normal points along, and its sign. */
  readonly dAxis: Axis;
  readonly dirSign: 1 | -1;
  readonly normal: readonly [number, number, number];
  /** The 4 corners of the face, CCW as seen from outside the block along
   * `normal`. Each component is 0 or 1; the two that vary are the tangent
   * axes, the constant one selects the near/far plane. */
  readonly corners: readonly [Corner, Corner, Corner, Corner];
  /** The two in-plane axes: [width axis, height axis] for the greedy sweep. */
  readonly tangents: readonly [Axis, Axis];
}

/** Order matches FACE_ORDER in atlas-layout.ts and the shaders' normal table. */
export const FACES: readonly FaceSpec[] = [
  {
    face: "top",
    index: 0,
    dAxis: 1,
    dirSign: 1,
    normal: [0, 1, 0],
    corners: [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    tangents: [0, 2],
  },
  {
    face: "bottom",
    index: 1,
    dAxis: 1,
    dirSign: -1,
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    tangents: [0, 2],
  },
  {
    face: "north",
    index: 2,
    dAxis: 2,
    dirSign: -1,
    normal: [0, 0, -1],
    corners: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    tangents: [0, 1],
  },
  {
    face: "south",
    index: 3,
    dAxis: 2,
    dirSign: 1,
    normal: [0, 0, 1],
    corners: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    tangents: [0, 1],
  },
  {
    face: "east",
    index: 4,
    dAxis: 0,
    dirSign: 1,
    normal: [1, 0, 0],
    corners: [
      [1, 0, 1],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
    ],
    tangents: [1, 2],
  },
  {
    face: "west",
    index: 5,
    dAxis: 0,
    dirSign: -1,
    normal: [-1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    tangents: [1, 2],
  },
];

const STRIDES: readonly [number, number, number] = [STRIDE_X, STRIDE_Y, STRIDE_Z];

/** Both sides of the two diagonal planes of a plant, CCW per side. */
const CROSS_QUADS: readonly (readonly [Corner, Corner, Corner, Corner])[] = [
  [
    [0, 0, 0],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 0],
  ],
  [
    [1, 0, 1],
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 1],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 1],
  ],
  [
    [1, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
    [1, 1, 0],
  ],
];

// Per-block lookups for the hot loop.
const KIND_NONE = 0;
const KIND_CUBE = 1;
const KIND_CROSS = 2;
const KIND_LIQUID = 3;
const KIND = new Uint8Array(256);
const SWAY = new Uint8Array(256);
for (const def of Object.values(BLOCKS)) {
  KIND[def.id] =
    def.shape === "cube"
      ? KIND_CUBE
      : def.shape === "cross"
        ? KIND_CROSS
        : def.shape === "liquid"
          ? KIND_LIQUID
          : KIND_NONE;
  SWAY[def.id] = def.sway === "leaves" ? SWAY_LEAVES : def.sway === "plant" ? SWAY_PLANT : 0;
}

/** Whether a face should be emitted looking from block `self` into `neighbor`. */
export function shouldRenderFace(self: BlockId, neighbor: BlockId): boolean {
  if (self === BlockId.AIR) return false;
  if (neighbor === BlockId.AIR) return true;
  if (!isTransparent(neighbor)) return false;
  if (self === neighbor) return false; // no internal faces inside one water/leaves body
  return true;
}

/** Classic voxel AO (the "0fps" formulation): a face vertex is darkened by
 * the two edge-adjacent cells and the corner cell that share it, all sampled
 * one step out along the face normal. Level 3 = fully open, 0 = pinched into
 * a corner. When both edge neighbors are solid the corner cell can't
 * brighten anything — the vertex is fully pinched regardless. */
export function vertexAOLevel(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));
}

/** Local vertex order for the quad's two triangles. The shared diagonal goes
 * across the pair of vertices whose brightness sum is larger — the standard
 * fix for the anisotropic dark-streak artifact, where interpolating along
 * the darker diagonal drags darkness across the whole face. Both orderings
 * preserve CCW winding. */
export function quadIndexOrder(
  ao: readonly [number, number, number, number],
): readonly [number, number, number, number, number, number] {
  if (ao[0] + ao[2] >= ao[1] + ao[3]) {
    return [0, 1, 2, 0, 2, 3];
  }
  return [1, 2, 3, 1, 3, 0];
}

/** A growable uint32 writer, reused across calls so meshing allocates only
 * the two exact-size result arrays. */
class WordBuffer {
  data = new Uint32Array(1 << 15);
  length = 0;

  reserve(extra: number): void {
    if (this.length + extra <= this.data.length) return;
    const grown = new Uint32Array(Math.max(this.data.length * 2, this.length + extra));
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  take(): Uint32Array {
    const out = this.data.slice(0, this.length);
    this.length = 0;
    return out;
  }
}

const opaqueOut = new WordBuffer();
const caveOut = new WordBuffer();
const waterOut = new WordBuffer();

const MASK_CELLS = CHUNK_HEIGHT * CHUNK_SIZE;
const maskKey = new Int32Array(MASK_CELLS);
const maskLight = new Int32Array(MASK_CELLS);
const maskExtra = new Int32Array(MASK_CELLS);
/** Water-column depth memo for the layer being meshed (18x18, -1 = unknown). */
const depthMemo = new Int8Array(18 * 18);

/** Builds greedy-meshed geometry for one chunk: coplanar faces that share a
 * tile and the exact same 4-corner shading pattern (ambient occlusion and
 * both light channels) merge into one big quad. Identical patterns tile
 * seamlessly, so a merged quad's linear shading reproduces the faces it
 * replaced; faces whose shading differs (silhouettes, shadow edges, the
 * falloff around a lantern) stay separate and keep their gradient. Plain
 * typed arrays in, plain typed arrays out — no Three.js/WebGL dependency,
 * so this runs (and is tested) anywhere, including under Node. */
export function meshChunk(chunk: Chunk, neighbors: NeighborLookup): MeshData {
  const center = chunk.buffer;

  // Vertical extent of this chunk's own blocks: nothing outside it can emit.
  let minY = CHUNK_HEIGHT;
  let maxY = -1;
  const layerCells = CHUNK_SIZE * CHUNK_SIZE;
  for (let y = 0; y < CHUNK_HEIGHT && minY === CHUNK_HEIGHT; y++) {
    const row = y * layerCells;
    for (let i = row; i < row + layerCells; i++) {
      if (center[i] !== 0) {
        minY = y;
        break;
      }
    }
  }
  for (let y = CHUNK_HEIGHT - 1; y >= minY && maxY < 0; y--) {
    const row = y * layerCells;
    for (let i = row; i < row + layerCells; i++) {
      if (center[i] !== 0) {
        maxY = y;
        break;
      }
    }
  }
  if (maxY < 0) {
    return {
      opaque: new Uint32Array(0),
      caveStart: 0,
      water: new Uint32Array(0),
      minY: 0,
      maxY: 0,
    };
  }

  const volume = buildLightVolume(center, chunk.cx, chunk.cz, neighbors);
  const blocks = volume.blocks;
  const sky = volume.sky;
  const blk = volume.blk;

  const lo: [number, number, number] = [0, minY, 0];
  const hi: [number, number, number] = [CHUNK_SIZE - 1, maxY, CHUNK_SIZE - 1];

  /** How many water cells sit at and below (lx, ly, lz), capped at 7. */
  const waterDepth = (lx: number, ly: number, lz: number): number => {
    const memoIndex = (lz + 1) * 18 + lx + 1;
    const known = depthMemo[memoIndex] ?? -1;
    if (known >= 0) return known;
    let depth = 0;
    let i = ORIGIN + ly * STRIDE_Y + lz * STRIDE_Z + lx;
    while (depth < 7 && blocks[i] === BlockId.WATER) {
      depth++;
      i -= STRIDE_Y;
    }
    depthMemo[memoIndex] = depth;
    return depth;
  };

  const local: [number, number, number] = [0, 0, 0];
  const aoQuad: [number, number, number, number] = [0, 0, 0, 0];
  const skyQuad: [number, number, number, number] = [0, 0, 0, 0];
  const blkQuad: [number, number, number, number] = [0, 0, 0, 0];
  const depthQuad: [number, number, number, number] = [0, 0, 0, 0];

  for (const spec of FACES) {
    const d = spec.dAxis;
    const [uAxis, vAxis] = spec.tangents;
    const strideD = STRIDES[d] * spec.dirSign;
    const strideU = STRIDES[uAxis];
    const strideV = STRIDES[vAxis];
    const loU = lo[uAxis];
    const loV = lo[vAxis];
    const dimU = hi[uAxis] - loU + 1;
    const dimV = hi[vAxis] - loV + 1;
    const isTop = spec.index === 0;
    const isSide = spec.index >= 2;

    for (let k = lo[d]; k <= hi[d]; k++) {
      // The world has a floor: nothing ever looks at bedrock from below.
      if (spec.index === 1 && k === 0) continue;
      let any = false;
      if (isTop) depthMemo.fill(-1);

      // --- build the mask for this layer ---
      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          const cell = j * dimU + i;
          local[d] = k;
          local[uAxis] = loU + i;
          local[vAxis] = loV + j;
          const self = ORIGIN + local[1] * STRIDE_Y + local[2] * STRIDE_Z + local[0];
          const id = blocks[self] ?? 0;
          const kind = KIND[id] ?? 0;
          if (kind !== KIND_CUBE && kind !== KIND_LIQUID) {
            maskKey[cell] = 0;
            continue;
          }
          const open = self + strideD;
          const neighbor = blocks[open] ?? 0;
          if (neighbor !== 0 && (OPAQUE[neighbor] === 1 || neighbor === id)) {
            maskKey[cell] = 0;
            continue;
          }
          const liquid = kind === KIND_LIQUID;

          // Per-corner ambient occlusion and smooth light, sampled in the
          // open cell's plane: the open cell itself, the two cells beside
          // it and the one diagonal to it all touch this vertex.
          let lightKey = 0;
          let aoKey = 0;
          const openSky = sky[open] ?? 0;
          const openBlk = blk[open] ?? 0;
          for (let c = 0; c < 4; c++) {
            const corner = spec.corners[c] ?? spec.corners[0];
            const s1 = open + (corner[uAxis] === 1 ? strideU : -strideU);
            const s2 = open + (corner[vAxis] === 1 ? strideV : -strideV);
            const sc = s1 + (corner[vAxis] === 1 ? strideV : -strideV);
            const b1 = blocks[s1] ?? 0;
            const b2 = blocks[s2] ?? 0;
            const bc = blocks[sc] ?? 0;
            const o1 = OPAQUE[b1] === 1;
            const o2 = OPAQUE[b2] === 1;

            let skySum = openSky;
            let blkSum = openBlk;
            let count = 1;
            if (!o1) {
              skySum += sky[s1] ?? 0;
              blkSum += blk[s1] ?? 0;
              count++;
            }
            if (!o2) {
              skySum += sky[s2] ?? 0;
              blkSum += blk[s2] ?? 0;
              count++;
            }
            if (!(o1 && o2) && OPAQUE[bc] !== 1) {
              skySum += sky[sc] ?? 0;
              blkSum += blk[sc] ?? 0;
              count++;
            }
            const skyLevel = Math.round(skySum / count);
            const blkLevel = Math.round(blkSum / count);
            const ao = liquid
              ? 3
              : vertexAOLevel(AO_OCCLUDER[b1] === 1, AO_OCCLUDER[b2] === 1, AO_OCCLUDER[bc] === 1);
            lightKey |= ((skyLevel << 4) | blkLevel) << (c * 8);
            aoKey |= ao << (c * 2);
          }

          // A face no light reaches at all is drawn near-black whatever its
          // occlusion, so pitch-dark cave walls drop their AO pattern and
          // merge into big quads. Most of a chunk's faces are exactly these.
          if (lightKey === 0) aoKey = 0xff;

          let extra = 0;
          let flags: number;
          if (liquid) {
            const surface = blocks[self + STRIDE_Y] !== BlockId.WATER;
            flags = surface ? 4 : 0;
            if (isTop) {
              // Depth at a vertex is the shallowest of the four columns
              // meeting there, so it falls to zero exactly along a shore.
              const lx = local[0];
              const lz = local[2];
              for (let c = 0; c < 4; c++) {
                const corner = spec.corners[c] ?? spec.corners[0];
                const ox = corner[0] === 1 ? 1 : -1;
                const oz = corner[2] === 1 ? 1 : -1;
                let depth = waterDepth(lx, k, lz);
                depth = Math.min(depth, waterDepth(lx + ox, k, lz));
                depth = Math.min(depth, waterDepth(lx, k, lz + oz));
                depth = Math.min(depth, waterDepth(lx + ox, k, lz + oz));
                extra |= depth << (c * 4);
              }
            } else {
              extra = 0x7777;
            }
          } else {
            flags = (SWAY[id] ?? 0) | ((LIGHT_EMISSION[id] ?? 0) > 0 ? 8 : 0);
          }

          const tile = TILE_TABLE[id * 6 + spec.index] ?? 0;
          const key = 1 + (tile | (aoKey << 8) | (flags << 16) | (liquid ? 1 << 20 : 0));
          maskKey[cell] = key;
          maskLight[cell] = lightKey;
          maskExtra[cell] = extra;
          any = true;
        }
      }
      if (!any) continue;

      // --- greedily merge rectangles and emit ---
      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU;) {
          const cell = j * dimU + i;
          const key = maskKey[cell] ?? 0;
          if (key === 0) {
            i++;
            continue;
          }
          const light = maskLight[cell] ?? 0;
          const extra = maskExtra[cell] ?? 0;

          let w = 1;
          let h = 1;
          if (key > 0) {
            while (
              i + w < dimU &&
              maskKey[cell + w] === key &&
              maskLight[cell + w] === light &&
              maskExtra[cell + w] === extra
            ) {
              w++;
            }
            outer: while (j + h < dimV) {
              const rowBase = (j + h) * dimU + i;
              for (let x = 0; x < w; x++) {
                if (
                  maskKey[rowBase + x] !== key ||
                  maskLight[rowBase + x] !== light ||
                  maskExtra[rowBase + x] !== extra
                ) {
                  break outer;
                }
              }
              h++;
            }
            for (let dj = 0; dj < h; dj++) {
              maskKey.fill(0, (j + dj) * dimU + i, (j + dj) * dimU + i + w);
            }
          }

          const bits = key - 1;
          const tile = bits & 255;
          const flags = (bits >>> 16) & 15;
          const liquid = ((bits >>> 20) & 1) === 1;
          for (let c = 0; c < 4; c++) {
            aoQuad[c] = (bits >>> (8 + c * 2)) & 3;
            skyQuad[c] = (light >>> (c * 8 + 4)) & 15;
            blkQuad[c] = (light >>> (c * 8)) & 15;
            depthQuad[c] = (extra >>> (c * 4)) & 15;
          }

          // Start one corner later when the 1-3 diagonal is the brighter one.
          const m0 = aoQuad[0] * 8 + skyQuad[0] + blkQuad[0];
          const m1 = aoQuad[1] * 8 + skyQuad[1] + blkQuad[1];
          const m2 = aoQuad[2] * 8 + skyQuad[2] + blkQuad[2];
          const m3 = aoQuad[3] * 8 + skyQuad[3] + blkQuad[3];
          const start = m0 + m2 >= m1 + m3 ? 0 : 1;

          const sunless = (light & 0xf0f0f0f0) === 0;
          const out = liquid ? waterOut : sunless ? caveOut : opaqueOut;
          out.reserve(8);
          const data = out.data;
          let at = out.length;
          for (let n = 0; n < 4; n++) {
            const c = (start + n) & 3;
            const corner = spec.corners[c] ?? spec.corners[0];
            local[d] = k + corner[d];
            local[uAxis] = loU + i + corner[uAxis] * w;
            local[vAxis] = loV + j + corner[vAxis] * h;
            let wordB = tile;
            if (liquid) {
              // The surface sits a little below the block top; side faces
              // of surface cells drop their upper edge to meet it.
              const lowered = (flags & 4) !== 0 && (isTop || (isSide && corner[1] === 1));
              wordB |= ((depthQuad[c] ?? 0) << 13) | (lowered ? 1 << 17 : 0);
            } else {
              const sway = flags & 3;
              // Cube foliage is flagged but never displaced: leaves rustle in
              // the fragment shader, so canopies can merge like any block.
              wordB |= (sway << 8) | (flags & 8 ? 1 << 11 : 0);
            }
            data[at++] =
              (local[0] |
                (local[1] << 5) |
                (local[2] << 13) |
                (spec.index << 18) |
                ((aoQuad[c] ?? 0) << 21) |
                ((skyQuad[c] ?? 0) << 23) |
                ((blkQuad[c] ?? 0) << 27)) >>>
              0;
            data[at++] = wordB >>> 0;
          }
          out.length = at;
          i += w;
        }
      }
    }
  }

  // --- plants: two crossed quads, both sides, lit by their own cell ---
  for (let y = minY; y <= maxY; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const self = ORIGIN + y * STRIDE_Y + z * STRIDE_Z + x;
        const id = blocks[self] ?? 0;
        if (KIND[id] !== KIND_CROSS) continue;
        const tile = TILE_TABLE[id * 6] ?? 0;
        const sway = SWAY[id] ?? 0;
        const emissive = (LIGHT_EMISSION[id] ?? 0) > 0;
        const shade = (3 << 21) | ((sky[self] ?? 0) << 23) | ((blk[self] ?? 0) << 27);
        const plantOut = (sky[self] ?? 0) === 0 ? caveOut : opaqueOut;
        plantOut.reserve(32);
        const data = plantOut.data;
        let at = plantOut.length;
        for (const quad of CROSS_QUADS) {
          for (const corner of quad) {
            data[at++] =
              ((x + corner[0]) | ((y + corner[1]) << 5) | ((z + corner[2]) << 13) | shade) >>> 0;
            data[at++] =
              (tile |
                (sway << 8) |
                (sway !== 0 && corner[1] === 1 ? 1 << 10 : 0) |
                (emissive ? 1 << 11 : 0) |
                (1 << 12)) >>>
              0;
          }
        }
        plantOut.length = at;
      }
    }
  }

  // One buffer, surface quads first, so both ranges share a single upload.
  const caveStart = opaqueOut.length / WORDS_PER_QUAD;
  const opaque = new Uint32Array(opaqueOut.length + caveOut.length);
  opaque.set(opaqueOut.data.subarray(0, opaqueOut.length));
  opaque.set(caveOut.data.subarray(0, caveOut.length), opaqueOut.length);
  opaqueOut.length = 0;
  caveOut.length = 0;
  return { opaque, caveStart, water: waterOut.take(), minY, maxY: maxY + 1 };
}
