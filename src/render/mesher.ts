import { BlockId, isTransparent } from "../world/blocks";
import type { Chunk } from "../world/chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "../world/coords";
import { type Face, tileForBlockFace } from "./atlas-layout";

/** Anything that can answer "what block is at this world position", so the
 * mesher can look past a chunk's own edge without knowing what a World is. */
export interface NeighborLookup {
  getBlock(worldX: number, worldY: number, worldZ: number): BlockId;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** Spans 0..width / 0..height across a merged quad, so the chunk shader
   * repeats the tile with `fract()` instead of stretching it. */
  uvs: Float32Array;
  colors: Float32Array;
  /** Texture-array layer (a TileKind) per vertex. */
  layers: Float32Array;
  indices: Uint32Array;
}

type Axis = 0 | 1 | 2;

interface FaceSpec {
  readonly face: Face;
  /** The axis the face's normal points along, and its sign. */
  readonly dAxis: Axis;
  readonly dirSign: 1 | -1;
  readonly normal: readonly [number, number, number];
  /** The 4 corners of the face, CCW as seen from outside the block along
   * `normal`. Each component is 0 or 1; the two that vary are the tangent
   * axes, the constant one selects the near/far plane. */
  readonly corners: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  /** The two in-plane axes: [width axis, height axis] for the greedy sweep. */
  readonly tangents: readonly [Axis, Axis];
  /** Directional shading: top brightest, bottom darkest, sides in between. */
  readonly shade: number;
}

const FACES: readonly FaceSpec[] = [
  {
    face: "top",
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
    shade: 1.0,
  },
  {
    face: "bottom",
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
    shade: 0.5,
  },
  {
    face: "north",
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
    shade: 0.75,
  },
  {
    face: "south",
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
    shade: 0.75,
  },
  {
    face: "east",
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
    shade: 0.85,
  },
  {
    face: "west",
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
    shade: 0.85,
  },
];

const DIMS: readonly [number, number, number] = [CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE];

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

export const AO_BRIGHTNESS: readonly [number, number, number, number] = [0.5, 0.7, 0.85, 1.0];

/** Local vertex order for the quad's two triangles. The shared diagonal goes
 * across the pair of vertices whose AO sum is larger (the brighter pair) —
 * the standard fix for the anisotropic dark-streak artifact, where
 * interpolating along the darker diagonal drags darkness across the whole
 * face. Both orderings preserve CCW winding. */
export function quadIndexOrder(
  ao: readonly [number, number, number, number],
): readonly [number, number, number, number, number, number] {
  if (ao[0] + ao[2] >= ao[1] + ao[3]) {
    return [0, 1, 2, 0, 2, 3];
  }
  return [1, 2, 3, 1, 3, 0];
}

/** Reads a block by chunk-local coordinates, dropping out to the neighbor
 * lookup (and world coordinates) past this chunk's own edges. */
function makeLocalReader(
  chunk: Chunk,
  neighbors: NeighborLookup,
): (lx: number, ly: number, lz: number) => BlockId {
  return (lx, ly, lz) => {
    if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE && ly >= 0 && ly < CHUNK_HEIGHT) {
      return chunk.getBlock(lx, ly, lz);
    }
    return neighbors.getBlock(chunk.worldOriginX + lx, ly, chunk.worldOriginZ + lz);
  };
}

/** Builds greedy-meshed geometry for one chunk: coplanar faces that share a
 * tile and the exact same 4-corner ambient-occlusion pattern merge into one
 * big quad, cutting triangle and draw-call cost. Identical AO patterns tile
 * seamlessly, so a merged quad's linear shading reproduces the faces it
 * replaced; faces whose AO differs (at silhouettes and terrace edges) stay
 * separate and keep their gradient. Plain typed arrays in, plain typed
 * arrays out — no Three.js/WebGL dependency, so this runs (and is tested)
 * anywhere, including under Node. */
export function meshChunk(chunk: Chunk, neighbors: NeighborLookup): MeshData {
  const block = makeLocalReader(chunk, neighbors);
  const occludes = (lx: number, ly: number, lz: number): boolean => {
    const id = block(lx, ly, lz);
    return id !== BlockId.AIR && id !== BlockId.WATER && id !== BlockId.LEAVES;
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const layers: number[] = [];
  const indices: number[] = [];

  // Reused per (face, layer): the greedy mask over the two tangent axes.
  const maxCells = CHUNK_HEIGHT * CHUNK_SIZE;
  const maskKey = new Int32Array(maxCells);
  const maskLayer = new Uint8Array(maxCells);
  const maskAO = new Uint8Array(maxCells * 4);

  // Scratch for building one face's 4-corner AO.
  const ao = [0, 0, 0, 0];

  for (const spec of FACES) {
    const d = spec.dAxis;
    const [uAxis, vAxis] = spec.tangents;
    const s = spec.dirSign;
    const dimD = DIMS[d];
    const dimU = DIMS[uAxis];
    const dimV = DIMS[vAxis];

    const local: [number, number, number] = [0, 0, 0];
    const open: [number, number, number] = [0, 0, 0];

    for (let k = 0; k < dimD; k++) {
      // --- build the mask for this layer ---
      maskKey.fill(0, 0, dimU * dimV);
      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU; i++) {
          local[d] = k;
          local[uAxis] = i;
          local[vAxis] = j;
          const self = block(local[0], local[1], local[2]);
          if (self === BlockId.AIR) continue;
          open[0] = local[0];
          open[1] = local[1];
          open[2] = local[2];
          open[d] = k + s;
          const neighbor = block(open[0], open[1], open[2]);
          if (!shouldRenderFace(self, neighbor)) continue;

          const layer = tileForBlockFace(self, spec.face);

          // Per-corner AO sampled in the open cell's plane.
          for (let c = 0; c < 4; c++) {
            const corner = spec.corners[c];
            const ou = (corner ? corner[uAxis] : 0) === 1 ? 1 : -1;
            const ov = (corner ? corner[vAxis] : 0) === 1 ? 1 : -1;
            const s1x = open[0] + (uAxis === 0 ? ou : 0);
            const s1y = open[1] + (uAxis === 1 ? ou : 0);
            const s1z = open[2] + (uAxis === 2 ? ou : 0);
            const s2x = open[0] + (vAxis === 0 ? ov : 0);
            const s2y = open[1] + (vAxis === 1 ? ov : 0);
            const s2z = open[2] + (vAxis === 2 ? ov : 0);
            const scx = open[0] + (uAxis === 0 ? ou : 0) + (vAxis === 0 ? ov : 0);
            const scy = open[1] + (uAxis === 1 ? ou : 0) + (vAxis === 1 ? ov : 0);
            const scz = open[2] + (uAxis === 2 ? ou : 0) + (vAxis === 2 ? ov : 0);
            const level = vertexAOLevel(
              occludes(s1x, s1y, s1z),
              occludes(s2x, s2y, s2z),
              occludes(scx, scy, scz),
            );
            ao[c] = level;
          }

          const cell = j * dimU + i;
          const a0 = ao[0] ?? 0;
          const a1 = ao[1] ?? 0;
          const a2 = ao[2] ?? 0;
          const a3 = ao[3] ?? 0;
          maskLayer[cell] = layer;
          maskAO[cell * 4] = a0;
          maskAO[cell * 4 + 1] = a1;
          maskAO[cell * 4 + 2] = a2;
          maskAO[cell * 4 + 3] = a3;
          // Faces merge when they share a tile AND the exact same 4-corner AO
          // pattern — identical patterns tile seamlessly, so a merged quad's
          // linear shading matches the faces it replaced. This captures flat
          // fields (AO 3333) and consistent slope/edge runs alike.
          maskKey[cell] = ((layer << 8) | (a0 << 6) | (a1 << 4) | (a2 << 2) | a3) + 1;
        }
      }

      // --- greedily merge rectangles and emit ---
      for (let j = 0; j < dimV; j++) {
        for (let i = 0; i < dimU;) {
          const cell = j * dimU + i;
          const key = maskKey[cell] ?? 0;
          if (key === 0) {
            i++;
            continue;
          }

          // Extend width while the key matches and merging is allowed.
          let w = 1;
          if (key > 0) {
            while (i + w < dimU && maskKey[cell + w] === key) w++;
          }
          // Extend height (only whole matching rows).
          let h = 1;
          if (key > 0) {
            outer: while (j + h < dimV) {
              const rowBase = (j + h) * dimU + i;
              for (let x = 0; x < w; x++) {
                if (maskKey[rowBase + x] !== key) break outer;
              }
              h++;
            }
          }

          emitQuad(
            spec,
            k,
            i,
            j,
            w,
            h,
            maskLayer[cell] ?? 0,
            maskAO[cell * 4] ?? 0,
            maskAO[cell * 4 + 1] ?? 0,
            maskAO[cell * 4 + 2] ?? 0,
            maskAO[cell * 4 + 3] ?? 0,
            positions,
            normals,
            uvs,
            colors,
            layers,
            indices,
          );

          for (let dj = 0; dj < h; dj++) {
            for (let di = 0; di < w; di++) {
              maskKey[(j + dj) * dimU + i + di] = 0;
            }
          }
          i += w;
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: new Float32Array(colors),
    layers: new Float32Array(layers),
    indices: new Uint32Array(indices),
  };
}

/** Emits one (possibly merged) quad: 4 vertices scaled to the rectangle,
 * with the tile layer, per-corner AO-tinted directional shade, repeating
 * UVs, and the AO-aware triangle diagonal. */
function emitQuad(
  spec: FaceSpec,
  k: number,
  i: number,
  j: number,
  w: number,
  h: number,
  layer: number,
  ao0: number,
  ao1: number,
  ao2: number,
  ao3: number,
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  layers: number[],
  indices: number[],
): void {
  const d = spec.dAxis;
  const [uAxis, vAxis] = spec.tangents;
  const base = positions.length / 3;
  const [nx, ny, nz] = spec.normal;
  const { shade } = spec;
  const aoQuad: [number, number, number, number] = [ao0, ao1, ao2, ao3];

  for (let c = 0; c < 4; c++) {
    const corner = spec.corners[c] ?? spec.corners[0];
    const pos: [number, number, number] = [0, 0, 0];
    pos[d] = k + corner[d];
    pos[uAxis] = i + corner[uAxis] * w;
    pos[vAxis] = j + corner[vAxis] * h;
    positions.push(pos[0], pos[1], pos[2]);
    normals.push(nx, ny, nz);
    uvs.push(corner[uAxis] * w, corner[vAxis] * h);
    layers.push(layer);
    const brightness = shade * (AO_BRIGHTNESS[aoQuad[c] ?? 3] ?? 1);
    colors.push(brightness, brightness, brightness);
  }

  for (const localIndex of quadIndexOrder(aoQuad)) {
    indices.push(base + localIndex);
  }
}
