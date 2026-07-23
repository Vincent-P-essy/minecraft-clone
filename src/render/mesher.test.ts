import { describe, expect, it } from "vitest";
import { BlockId } from "../world/blocks";
import { Chunk } from "../world/chunk";
import {
  AO_BRIGHTNESS,
  type MeshData,
  type NeighborLookup,
  meshChunk,
  quadIndexOrder,
  shouldRenderFace,
  vertexAOLevel,
} from "./mesher";

const allAir: NeighborLookup = { getBlock: () => BlockId.AIR };

function faceCount(mesh: MeshData): number {
  return mesh.indices.length / 6; // 6 indices (2 triangles) per quad face
}

/** Counts quads whose normal matches — each quad is 4 consecutive vertices. */
function countFacesWithNormal(mesh: MeshData, nx: number, ny: number, nz: number): number {
  let count = 0;
  for (let v = 0; v < mesh.normals.length / 3; v += 4) {
    const i = v * 3;
    if (mesh.normals[i] === nx && mesh.normals[i + 1] === ny && mesh.normals[i + 2] === nz) count++;
  }
  return count;
}

describe("shouldRenderFace", () => {
  it("air never renders a face", () => {
    expect(shouldRenderFace(BlockId.AIR, BlockId.STONE)).toBe(false);
    expect(shouldRenderFace(BlockId.AIR, BlockId.AIR)).toBe(false);
  });

  it("a solid block against air renders", () => {
    expect(shouldRenderFace(BlockId.STONE, BlockId.AIR)).toBe(true);
  });

  it("a solid block against an opaque neighbor is fully hidden", () => {
    expect(shouldRenderFace(BlockId.STONE, BlockId.DIRT)).toBe(false);
  });

  it("a solid block against a transparent neighbor renders", () => {
    expect(shouldRenderFace(BlockId.SAND, BlockId.WATER)).toBe(true);
    expect(shouldRenderFace(BlockId.STONE, BlockId.LEAVES)).toBe(true);
  });

  it("two blocks of the same transparent kind don't render an interior face", () => {
    expect(shouldRenderFace(BlockId.WATER, BlockId.WATER)).toBe(false);
    expect(shouldRenderFace(BlockId.LEAVES, BlockId.LEAVES)).toBe(false);
  });

  it("two different transparent kinds still render a face between them", () => {
    expect(shouldRenderFace(BlockId.WATER, BlockId.LEAVES)).toBe(true);
  });
});

describe("meshChunk on an empty chunk", () => {
  it("produces no geometry at all", () => {
    const chunk = new Chunk(0, 0);
    const mesh = meshChunk(chunk, allAir);
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });
});

describe("meshChunk on a single isolated block", () => {
  const chunk = new Chunk(0, 0);
  chunk.setBlock(5, 5, 5, BlockId.STONE);
  const mesh = meshChunk(chunk, allAir);

  it("emits exactly 6 faces (one per side of the cube)", () => {
    expect(faceCount(mesh)).toBe(6);
  });

  it("emits 4 vertices per face and a matching vertex count", () => {
    expect(mesh.positions.length / 3).toBe(24);
    expect(mesh.normals.length / 3).toBe(24);
    expect(mesh.colors.length / 3).toBe(24);
    expect(mesh.uvs.length / 2).toBe(24);
  });

  it("every triangle's winding matches its stored normal", () => {
    // For each face (4 verts, 6 indices = 2 triangles sharing the same normal),
    // cross(v1-v0, v2-v0) must point the same way as the vertex normal —
    // this is exactly what makes Three.js backface-cull the right side.
    for (let f = 0; f < mesh.indices.length; f += 6) {
      const i0 = mesh.indices[f] ?? 0;
      const i1 = mesh.indices[f + 1] ?? 0;
      const i2 = mesh.indices[f + 2] ?? 0;
      const v0 = readVec3(mesh.positions, i0);
      const v1 = readVec3(mesh.positions, i1);
      const v2 = readVec3(mesh.positions, i2);
      const normal = readVec3(mesh.normals, i0);

      const edge1 = sub(v1, v0);
      const edge2 = sub(v2, v0);
      const computed = cross(edge1, edge2);

      expect(dot(normalize(computed), normal)).toBeCloseTo(1, 5);
    }
  });
});

describe("meshChunk between two solid neighbors", () => {
  it("culls the shared interior face and greedily merges the coplanar rest", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(4, 4, 4, BlockId.STONE);
    chunk.setBlock(5, 4, 4, BlockId.STONE); // touching along +X/-X
    const mesh = meshChunk(chunk, allAir);
    // The interior faces are culled; every remaining pair of coplanar faces
    // (top, bottom, north, south) merges into one quad, plus the two outer
    // end caps (+X, -X). 2 isolated cubes would be 12 faces; this is 6.
    expect(faceCount(mesh)).toBe(6);
  });
});

describe("greedy meshing", () => {
  it("merges a flat NxN slab's top into a single quad", () => {
    const chunk = new Chunk(0, 0);
    for (let x = 0; x < 6; x++) {
      for (let z = 0; z < 6; z++) {
        chunk.setBlock(x, 4, z, BlockId.STONE);
      }
    }
    const mesh = meshChunk(chunk, allAir);
    // Per-face meshing would emit 36 top quads; greedy merges the flat,
    // AO-uniform top into 1. The whole 6x6x1 slab is a handful of quads,
    // nowhere near 6 faces x 36 blocks.
    const topQuads = countFacesWithNormal(mesh, 0, 1, 0);
    expect(topQuads).toBe(1);
    expect(faceCount(mesh)).toBeLessThan(20);
  });

  it("keeps faces separate where ambient occlusion varies (a block on the slab)", () => {
    const chunk = new Chunk(0, 0);
    for (let x = 0; x < 6; x++) {
      for (let z = 0; z < 6; z++) {
        chunk.setBlock(x, 4, z, BlockId.STONE);
      }
    }
    // A bump in the middle shadows nearby top faces, so their AO is no
    // longer uniform and they can't all fold into one quad.
    chunk.setBlock(3, 5, 3, BlockId.STONE);
    const mesh = meshChunk(chunk, allAir);
    expect(countFacesWithNormal(mesh, 0, 1, 0)).toBeGreaterThan(1);
  });

  it("a merged quad's UVs span its full size so the shader can repeat the tile", () => {
    const chunk = new Chunk(0, 0);
    for (let x = 0; x < 4; x++) chunk.setBlock(x, 4, 0, BlockId.STONE);
    const mesh = meshChunk(chunk, allAir);
    let maxU = 0;
    for (const u of mesh.uvs) maxU = Math.max(maxU, u);
    // The top strip is 4 blocks long, so a UV coordinate reaches 4 (not 1).
    expect(maxU).toBeGreaterThanOrEqual(4);
  });

  it("assigns every vertex the tile layer for its block face", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(2, 2, 2, BlockId.STONE);
    const mesh = meshChunk(chunk, allAir);
    // TileKind.STONE is 3; every stone vertex carries layer 3.
    for (const layer of mesh.layers) {
      expect(layer).toBe(3);
    }
    expect(mesh.layers.length).toBe(mesh.positions.length / 3);
  });
});

describe("meshChunk across a chunk boundary", () => {
  it("hides the face against a solid block in the neighboring chunk", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(15, 4, 4, BlockId.STONE); // rightmost column of this chunk

    const neighborChunk = new Chunk(1, 0);
    neighborChunk.setBlock(0, 4, 4, BlockId.STONE); // leftmost column of chunk (1, 0), touching the above

    const neighbors: NeighborLookup = {
      getBlock: (worldX, worldY, worldZ) => {
        // Only chunk (1, 0) is registered; anything else reads as air.
        const lx = worldX - neighborChunk.worldOriginX;
        const lz = worldZ - neighborChunk.worldOriginZ;
        if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) {
          return neighborChunk.getBlock(lx, worldY, lz);
        }
        return BlockId.AIR;
      },
    };

    const mesh = meshChunk(chunk, neighbors);
    // A single block normally emits 6 faces; the +X face into the neighbor is hidden.
    expect(faceCount(mesh)).toBe(5);
  });

  it("shows the face when the neighboring chunk is air at that position", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(15, 4, 4, BlockId.STONE);
    const mesh = meshChunk(chunk, allAir);
    expect(faceCount(mesh)).toBe(6);
  });
});

describe("meshChunk UVs", () => {
  it("stays within [0, 1] for every vertex", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 1, 1, BlockId.GRASS);
    chunk.setBlock(2, 1, 1, BlockId.WATER);
    const mesh = meshChunk(chunk, allAir);
    for (const uv of mesh.uvs) {
      expect(uv).toBeGreaterThanOrEqual(0);
      expect(uv).toBeLessThanOrEqual(1);
    }
  });
});

describe("vertexAOLevel", () => {
  it("is fully open with no occluders", () => {
    expect(vertexAOLevel(false, false, false)).toBe(3);
  });

  it("drops one level per single occluder", () => {
    expect(vertexAOLevel(true, false, false)).toBe(2);
    expect(vertexAOLevel(false, true, false)).toBe(2);
    expect(vertexAOLevel(false, false, true)).toBe(2);
  });

  it("is fully pinched when both edge neighbors occlude, regardless of the corner", () => {
    expect(vertexAOLevel(true, true, false)).toBe(0);
    expect(vertexAOLevel(true, true, true)).toBe(0);
  });

  it("one side plus the corner gives level 1", () => {
    expect(vertexAOLevel(true, false, true)).toBe(1);
  });
});

describe("quadIndexOrder", () => {
  it("keeps the 0-2 diagonal when that pair is at least as bright", () => {
    expect(quadIndexOrder([3, 3, 3, 3])).toEqual([0, 1, 2, 0, 2, 3]);
    expect(quadIndexOrder([3, 0, 3, 0])).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("flips to the 1-3 diagonal when that pair is brighter", () => {
    expect(quadIndexOrder([0, 3, 0, 3])).toEqual([1, 2, 3, 1, 3, 0]);
  });

  it("both orderings reference each vertex of the quad", () => {
    expect(new Set(quadIndexOrder([3, 3, 3, 3])).size).toBe(4);
    expect(new Set(quadIndexOrder([0, 3, 0, 3])).size).toBe(4);
  });
});

describe("meshChunk ambient occlusion", () => {
  it("an isolated block keeps uniform per-face colors (no occluders anywhere)", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(5, 5, 5, BlockId.STONE);
    const mesh = meshChunk(chunk, allAir);
    // Every quad's 4 vertices share one color when AO is level 3 across the face.
    for (let v = 0; v < mesh.colors.length / 3; v += 4) {
      const first = mesh.colors[v * 3];
      for (let c = 1; c < 4; c++) {
        expect(mesh.colors[(v + c) * 3]).toBe(first);
      }
    }
  });

  it("a neighbor diagonally above darkens exactly the two top-face vertices it touches", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(5, 5, 5, BlockId.STONE);
    chunk.setBlock(6, 6, 5, BlockId.STONE); // sits kitty-corner above the +X edge of the top face
    const mesh = meshChunk(chunk, allAir);

    // Find the top face of the (5,5,5) block: 4 consecutive vertices whose
    // normal is +Y and whose y position is 6.
    let darkened = 0;
    let open = 0;
    for (let v = 0; v < mesh.positions.length / 3; v += 4) {
      const normalY = mesh.normals[v * 3 + 1];
      const posY = mesh.positions[v * 3 + 1];
      const posX = mesh.positions[v * 3];
      if (normalY !== 1 || posY !== 6) continue;
      if (posX !== 5 && posX !== 6) continue; // only the (5,5,5) block's top face
      for (let c = 0; c < 4; c++) {
        const x = mesh.positions[(v + c) * 3] ?? 0;
        const color = mesh.colors[(v + c) * 3] ?? 0;
        // The occluder at x∈[6,7) touches the two vertices at x=6.
        if (x === 6) {
          expect(color).toBeCloseTo(AO_BRIGHTNESS[2], 5);
          darkened++;
        } else {
          expect(color).toBeCloseTo(1.0, 5);
          open++;
        }
      }
    }
    expect(darkened).toBe(2);
    expect(open).toBe(2);
  });

  it("winding still matches normals even when AO flips the quad diagonal", () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(5, 5, 5, BlockId.STONE);
    // Occluders arranged to push the brighter pair onto the 1-3 diagonal of
    // the top face: darken corners 0 (x=5,z=5 side) and 2 (x=6,z=6 side).
    chunk.setBlock(4, 6, 4, BlockId.STONE);
    chunk.setBlock(6, 6, 6, BlockId.STONE);
    const mesh = meshChunk(chunk, allAir);
    for (let f = 0; f < mesh.indices.length; f += 3) {
      const i0 = mesh.indices[f] ?? 0;
      const i1 = mesh.indices[f + 1] ?? 0;
      const i2 = mesh.indices[f + 2] ?? 0;
      const v0 = readVec3(mesh.positions, i0);
      const v1 = readVec3(mesh.positions, i1);
      const v2 = readVec3(mesh.positions, i2);
      const normal = readVec3(mesh.normals, i0);
      const computed = cross(sub(v1, v0), sub(v2, v0));
      expect(dot(normalize(computed), normal)).toBeCloseTo(1, 5);
    }
  });
});

function readVec3(arr: Float32Array, vertexIndex: number): [number, number, number] {
  const base = vertexIndex * 3;
  return [arr[base] ?? 0, arr[base + 1] ?? 0, arr[base + 2] ?? 0];
}

function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len === 0 ? v : [v[0] / len, v[1] / len, v[2] / len];
}
