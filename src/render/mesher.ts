import { BlockId, isTransparent } from "../world/blocks";
import type { Chunk } from "../world/chunk";
import { CHUNK_HEIGHT, CHUNK_SIZE } from "../world/coords";
import { type Face, tileForBlockFace, tileUV } from "./atlas-layout";

/** Anything that can answer "what block is at this world position", so the
 * mesher can look past a chunk's own edge without knowing what a World is. */
export interface NeighborLookup {
  getBlock(worldX: number, worldY: number, worldZ: number): BlockId;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

type Axis = 0 | 1 | 2;

interface FaceSpec {
  readonly face: Face;
  readonly dir: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  /** The 4 corners of the face, CCW as seen from outside the block along `normal`. */
  readonly corners: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  /** The two in-plane axes (everything except the normal's axis). */
  readonly tangents: readonly [Axis, Axis];
  /** Directional shading: top brightest, bottom darkest, sides in between. */
  readonly shade: number;
}

const FACES: readonly FaceSpec[] = [
  {
    face: "top",
    dir: [0, 1, 0],
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
    dir: [0, -1, 0],
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
    dir: [0, 0, -1],
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
    dir: [0, 0, 1],
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
    dir: [1, 0, 0],
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
    dir: [-1, 0, 0],
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

function blockAt(
  chunk: Chunk,
  neighbors: NeighborLookup,
  lx: number,
  ly: number,
  lz: number,
): BlockId {
  if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE && ly >= 0 && ly < CHUNK_HEIGHT) {
    return chunk.getBlock(lx, ly, lz);
  }
  return neighbors.getBlock(chunk.worldOriginX + lx, ly, chunk.worldOriginZ + lz);
}

/** Builds face-culled mesh data — with per-vertex ambient occlusion baked
 * into the vertex colors — for one chunk. Plain typed arrays in, plain typed
 * arrays out — no Three.js/WebGL dependency, so this runs (and is tested)
 * anywhere, including inside a Web Worker or under Node. */
export function meshChunk(chunk: Chunk, neighbors: NeighborLookup): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const occludes = (lx: number, ly: number, lz: number): boolean => {
    const id = blockAt(chunk, neighbors, lx, ly, lz);
    return id !== BlockId.AIR && !isTransparent(id);
  };

  for (let ly = 0; ly < CHUNK_HEIGHT; ly++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = chunk.getBlock(lx, ly, lz);
        if (id === BlockId.AIR) continue;

        for (const spec of FACES) {
          const neighbor = blockAt(
            chunk,
            neighbors,
            lx + spec.dir[0],
            ly + spec.dir[1],
            lz + spec.dir[2],
          );
          if (!shouldRenderFace(id, neighbor)) continue;

          const baseIndex = positions.length / 3;
          const [u0, v0, u1, v1] = tileUV(tileForBlockFace(id, spec.face));
          const faceU = [u0, u1, u1, u0] as const;
          const faceV = [v1, v1, v0, v0] as const;
          const [c0, c1, c2, c3] = spec.corners;
          const cornerList = [c0, c1, c2, c3] as const;
          const [nx, ny, nz] = spec.normal;
          const { shade } = spec;
          const [t1, t2] = spec.tangents;

          // The open cell this face looks into; all AO samples live in its plane.
          const bx = lx + spec.dir[0];
          const by = ly + spec.dir[1];
          const bz = lz + spec.dir[2];

          const ao: [number, number, number, number] = [3, 3, 3, 3];
          for (let c = 0; c < 4; c++) {
            const corner = cornerList[c] ?? c0;
            const o1 = corner[t1] === 1 ? 1 : -1;
            const o2 = corner[t2] === 1 ? 1 : -1;
            const s1: [number, number, number] = [bx, by, bz];
            s1[t1] += o1;
            const s2: [number, number, number] = [bx, by, bz];
            s2[t2] += o2;
            const sc: [number, number, number] = [bx, by, bz];
            sc[t1] += o1;
            sc[t2] += o2;
            ao[c] = vertexAOLevel(
              occludes(s1[0], s1[1], s1[2]),
              occludes(s2[0], s2[1], s2[2]),
              occludes(sc[0], sc[1], sc[2]),
            );
          }

          for (let c = 0; c < 4; c++) {
            const corner = cornerList[c] ?? c0;
            positions.push(lx + corner[0], ly + corner[1], lz + corner[2]);
            normals.push(nx, ny, nz);
            uvs.push(faceU[c] ?? 0, faceV[c] ?? 0);
            const brightness = shade * (AO_BRIGHTNESS[ao[c] ?? 3] ?? 1);
            colors.push(brightness, brightness, brightness);
          }

          for (const local of quadIndexOrder(ao)) {
            indices.push(baseIndex + local);
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
